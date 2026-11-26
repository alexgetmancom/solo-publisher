//! `createBot` and its middleware chain, in the order it is installed:
//!
//! 1. timing and usage around everything,
//! 2. the admin gate,
//! 3. the callback acknowledgement (dedupe, answer redirect, supersession claim),
//! 4. `sequentialize` per chat,
//! 5. the callback boundary,
//! 6. the menu plugin,
//! 7. `/start` (and any other registered command),
//! 8. the text triggers,
//! 9. the message router (settings input, intake, the publication flows),
//! 10. the callback router (publication namespace, screen buttons, else "Unknown action").

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::panic::AssertUnwindSafe;
use std::rc::Rc;
use std::time::Instant;

use content::Locale;
use db::BackendDb;
use domain::application::ports::Clock;
use domain::publishing::Boundaries;
use domain::publishing::boundaries::{MediaMetadata, MediaProbe, ProviderOutcome, VideoProvider};
use domain::studio::boundaries::{StudioBoundaries, YoutubeUploads, ZernioAccount, ZernioDirectory};
use foundation::config::{Config, SharedConfig};
use foundation::i18n::{Key, t};
use foundation::logger::{LogLevel, log};
use futures_util::FutureExt as _;
use providers::external::telegram::BotApi;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::Fut;
use crate::action_lock::ActionLocks;
use crate::api::Api;
use crate::api::types::{Update, User};
use crate::boundary::{self, BoundaryState};
use crate::callback::parse_screen_callback;
use crate::context::Ctx;
use crate::registry::Registry;
use crate::sequentialize::Sequence;
use crate::{menu, publication, screens, tap};

/// What Studio calls through the bot's services but the bot does not own:
/// publishing's and Studio's boundaries, implemented by the host (the app
/// binary, or a test).
pub trait Host {
    fn publishing(&self) -> Boundaries<'_>;
    fn studio(&self) -> StudioBoundaries<'_>;
}

/// The asynchronous adapters Studio waits on, as one object-safe trait
/// (`StudioAdapters` is generic; [`DynAdapters`] bridges the two).
pub trait Adapters {
    fn probe<'a>(&'a self, path: &'a str) -> Fut<'a, Result<MediaMetadata, String>>;
    fn audio_stats<'a>(&'a self, path: &'a str) -> Fut<'a, Result<String, String>>;
    fn post_outcome<'a>(
        &'a self,
        provider_post_id: &'a str,
        platform: &'a str,
    ) -> Fut<'a, domain::Result<ProviderOutcome>>;
    fn publish_instagram_reel<'a>(
        &'a self,
        account_id: &'a str,
        public_url: &'a str,
        metadata: &'a Value,
        request_id: &'a str,
    ) -> Fut<'a, domain::Result<ProviderOutcome>>;
    fn keep_youtube_private<'a>(
        &'a self,
        config: &'a Config,
        video_id: &'a str,
        locale: Locale,
    ) -> Fut<'a, domain::Result<()>>;
    fn zernio_accounts<'a>(&'a self, config: &'a Config) -> Fut<'a, domain::Result<Vec<ZernioAccount>>>;
}

pub struct DynAdapters(pub Box<dyn Adapters>);

impl MediaProbe for DynAdapters {
    async fn probe(&self, path: &str) -> Result<MediaMetadata, String> {
        self.0.probe(path).await
    }
    async fn audio_stats(&self, path: &str) -> Result<String, String> {
        self.0.audio_stats(path).await
    }
}

impl VideoProvider for DynAdapters {
    async fn post_outcome(&self, provider_post_id: &str, platform: &str) -> domain::Result<ProviderOutcome> {
        self.0.post_outcome(provider_post_id, platform).await
    }
    async fn publish_instagram_reel(
        &self,
        account_id: &str,
        public_url: &str,
        metadata: &Value,
        request_id: &str,
    ) -> domain::Result<ProviderOutcome> {
        self.0
            .publish_instagram_reel(account_id, public_url, metadata, request_id)
            .await
    }
}

impl YoutubeUploads for DynAdapters {
    async fn keep_private(&self, config: &Config, video_id: &str, locale: Locale) -> domain::Result<()> {
        self.0.keep_youtube_private(config, video_id, locale).await
    }
}

impl ZernioDirectory for DynAdapters {
    async fn accounts(&self, config: &Config) -> domain::Result<Vec<ZernioAccount>> {
        self.0.zernio_accounts(config).await
    }
}

/// Everything a bot is built from.
pub struct BotDeps {
    pub db: BackendDb,
    pub clock: Rc<dyn Clock>,
    pub config: SharedConfig,
    pub host: Rc<dyn Host>,
    pub adapters: DynAdapters,
    /// The controller bot's Bot API.
    pub telegram: BotApi,
    /// Where the release controls send promote and rollback requests.
    pub deploy_agent: Rc<dyn crate::deployment::DeployAgent>,
}

/// Background tasks the bot started, so a caller can wait for quiet.
#[derive(Default)]
struct Tasks {
    running: Cell<usize>,
    idle: Notify,
    /// The first background panic nobody has taken yet ([`Bot::take_panic`]).
    panic: RefCell<Option<String>>,
}

/// One counted task: counted while its future exists, so a task that
/// panics, or is dropped unpolled, still lets [`Bot::settled`] resolve.
struct Running(Rc<Inner>);

impl Running {
    fn new(inner: Rc<Inner>) -> Self {
        inner.tasks.running.set(inner.tasks.running.get() + 1);
        Self(inner)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let tasks = &self.0.tasks;
        let running = tasks.running.get() - 1;
        tasks.running.set(running);
        if running == 0 {
            tasks.idle.notify_waiters();
        }
    }
}

fn panic_message(panic: &(dyn Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic without a message".to_owned())
}

struct Inner {
    api: Api,
    deps: BotDeps,
    registry: Registry,
    boundary: RefCell<BoundaryState>,
    sequence: Sequence,
    locks: ActionLocks,
    tasks: Tasks,
    info: RefCell<Option<User>>,
}

/// One bot; clones share it. Lives on one thread inside a tokio `LocalSet`.
#[derive(Clone)]
pub struct Bot {
    inner: Rc<Inner>,
}

impl Bot {
    /// `createBot`: registers every area's screens and configures the command
    /// menu in the background (the description is the `ru` one, see
    /// docs/decisions.md). Must be called inside a `LocalSet`.
    pub fn new(deps: BotDeps) -> Self {
        let mut registry = Registry::default();
        publication::register_shared_actions(&mut registry);
        screens::register(&mut registry);
        let bot = Self {
            inner: Rc::new(Inner {
                api: Api::new(deps.telegram.clone()),
                deps,
                registry,
                boundary: RefCell::default(),
                sequence: Sequence::default(),
                locks: ActionLocks::default(),
                tasks: Tasks::default(),
                info: RefCell::new(None),
            }),
        };
        let api = bot.api().clone();
        bot.spawn(async move {
            match api.set_my_commands(&[("start", &t(Key::BotCommandStart, &[]))]).await {
                Ok(_) => log(LogLevel::Info, "Telegram commands menu configured", None),
                Err(error) => log(
                    LogLevel::Error,
                    "Failed to configure Telegram commands menu",
                    Some(json!({"error": error.js_string()})),
                ),
            }
        });
        bot
    }

    pub fn api(&self) -> &Api {
        &self.inner.api
    }

    pub fn deps(&self) -> &BotDeps {
        &self.inner.deps
    }

    pub fn registry(&self) -> &Registry {
        &self.inner.registry
    }

    pub fn action_locks(&self) -> &ActionLocks {
        &self.inner.locks
    }

    pub(crate) fn boundary(&self) -> &RefCell<BoundaryState> {
        &self.inner.boundary
    }

    /// Who the bot is (`bot.botInfo`), once known.
    pub fn info(&self) -> Option<User> {
        self.inner.info.borrow().clone()
    }

    pub fn set_info(&self, info: User) {
        *self.inner.info.borrow_mut() = Some(info);
    }

    /// `bot.init()`: asks `getMe` unless the bot already knows itself.
    pub async fn init(&self) -> crate::Result<()> {
        if self.info().is_none() {
            let me = self.api().get_me().await?;
            self.set_info(me);
        }
        Ok(())
    }

    /// Starts background work the bot owns (an acknowledgement, a download, a
    /// deploy request), counted by [`Bot::settled`] until it ends.
    pub fn spawn<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: Future + 'static,
        F::Output: 'static,
    {
        let running = Running::new(Rc::clone(&self.inner));
        let watched = self.watched(future);
        tokio::task::spawn_local(async move {
            let _running = running;
            watched.await
        })
    }

    /// Starts background work no caller waits for and [`Bot::settled`] does
    /// not count (a Story-card waiter outlives the update that started it).
    pub fn spawn_detached<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: Future + 'static,
        F::Output: 'static,
    {
        tokio::task::spawn_local(self.watched(future))
    }

    /// The future, with a panic logged and kept for [`Bot::take_panic`]
    /// before it unwinds into the task's `JoinHandle` as before.
    fn watched<F: Future>(&self, future: F) -> impl Future<Output = F::Output> + use<F> {
        let inner = Rc::clone(&self.inner);
        async move {
            match AssertUnwindSafe(future).catch_unwind().await {
                Ok(output) => output,
                Err(panic) => {
                    let message = panic_message(&*panic);
                    log(
                        LogLevel::Error,
                        "background task panicked",
                        Some(json!({"error": message})),
                    );
                    inner.tasks.panic.borrow_mut().get_or_insert(message);
                    std::panic::resume_unwind(panic)
                }
            }
        }
    }

    /// The first background task panic since the last call. Tokio keeps a
    /// task's panic in a `JoinHandle` nobody awaits; this is how a caller
    /// waiting for quiet learns that the quiet came from a crash.
    pub fn take_panic(&self) -> Option<String> {
        self.inner.tasks.panic.borrow_mut().take()
    }

    /// The dependencies back once this is the last handle on the bot (the
    /// runner stopped, its tasks gone): how the owner closes the database.
    pub fn into_deps(self) -> Result<BotDeps, Self> {
        Rc::try_unwrap(self.inner)
            .map(|inner| inner.deps)
            .map_err(|inner| Self { inner })
    }

    /// Resolves once no background task of this bot is running.
    pub async fn settled(&self) {
        loop {
            let idle = self.inner.tasks.idle.notified();
            if self.inner.tasks.running.get() == 0 {
                return;
            }
            idle.await;
        }
    }

    /// `bot.handleUpdate(update)`: the whole middleware chain. A failure is
    /// logged as `bot.catch` logs it and goes no further.
    pub async fn handle_update(&self, update: Update) {
        let ctx = Rc::new(Ctx::new(self.clone(), update));
        let account = tap::new_tap();
        let measured = Rc::clone(&account);
        tap::scope(account, async move {
            let started_at = Instant::now();
            let result = self.chain(&ctx).await;
            let measurement = measured.borrow();
            let answered_at = measurement.answered_at.unwrap_or_else(Instant::now);
            let answer_ms = answered_at.saturating_duration_since(started_at).as_secs_f64() * 1000.0;
            self.deps().host.publishing().usage.record(
                ctx.db(),
                "telegram.update.handle",
                result.is_ok(),
                answer_ms as u64,
            );
            let mut details = json!({
                "operation": "telegram.update.handle",
                "updateId": ctx.update.update_id,
                "updateType": ctx.update.kind(),
                "success": result.is_ok(),
                "apiSumMs": measurement.api_sum_ms.round() as i64,
                "apiCalls": measurement.api_calls,
            });
            if let Some(methods) = measurement.api_methods_json() {
                details["apiMethods"] = methods;
            }
            details["unchangedEdits"] = measurement.unchanged_edits.into();
            details["providerMs"] = (measurement.provider_ms.round() as i64).into();
            details["providerCalls"] = measurement.provider_calls.into();
            details["answerMs"] = (answer_ms.round() as i64).into();
            if let Err(error) = &result {
                details["error"] = error.to_string().into();
            }
            drop(measurement);
            let level = if result.is_ok() { LogLevel::Info } else { LogLevel::Warn };
            log(level, "operation timing", Some(details));
            if let Err(error) = result {
                log(
                    LogLevel::Error,
                    "grammY handler failed",
                    Some(json!({"error": crate::effects::error_js_string(&*error)})),
                );
            }
        })
        .await;
    }

    async fn chain(&self, ctx: &Rc<Ctx>) -> crate::Result<()> {
        let config = &ctx.config;
        let admin = ctx
            .update
            .from_id()
            .is_some_and(|id| id != 0 && config.controller_admin_ids.contains(&id));
        if !admin {
            if ctx.callback_data().is_some() {
                ctx.answer_callback_query_now(None, false).await?;
            }
            return Ok(());
        }
        boundary::acknowledge(ctx);
        // `sequentialize` waits on a promise even when the chat is free, which
        // lets every update that arrived with this one take its acknowledgement
        // and its place in the queue first.
        crate::sequentialize::yield_now().await;
        let _turn = self.inner.sequence.turn(ctx.chat_id().map(|id| id.to_string())).await;
        if ctx.callback_data().is_some() {
            boundary::run(ctx, Box::pin(self.handlers(ctx))).await
        } else {
            self.handlers(ctx).await
        }
    }

    /// Everything after the boundary: menus, commands, text triggers, the
    /// message router and the callback router.
    async fn handlers(&self, ctx: &Ctx) -> crate::Result<()> {
        if ctx.callback_data().is_some() && menu::handle_callback(ctx).await? {
            return Ok(());
        }
        if let Some(handler) = self.command_handler(ctx) {
            return handler(ctx).await;
        }
        if let Some(message) = ctx.update.text_message() {
            let text = message.text.as_deref().or(message.caption.as_deref());
            if let Some(handler) = text.and_then(|text| self.registry().hears_handler(text)) {
                return handler(ctx).await;
            }
        }
        if ctx.update.message.is_some() {
            return self.route_message(ctx).await;
        }
        if ctx.callback_data().is_some() {
            return self.route_callback(ctx).await;
        }
        Ok(())
    }

    /// `bot.command(name)`: a `bot_command` entity at offset 0 naming a
    /// registered command, alone or addressed to this bot (`/start@bot`).
    fn command_handler(&self, ctx: &Ctx) -> Option<crate::registry::Handler> {
        let message = ctx.update.message.as_ref().or(ctx.update.channel_post.as_ref())?;
        let text: Vec<u16> = message
            .text
            .as_deref()
            .or(message.caption.as_deref())?
            .encode_utf16()
            .collect();
        message.entities.as_ref()?.iter().find_map(|entity| {
            if entity.kind != "bot_command" || entity.offset != 0 {
                return None;
            }
            let end = usize::try_from(entity.length).ok()?.min(text.len());
            let command = String::from_utf16_lossy(text.get(1..end)?);
            if let Some(handler) = self.registry().command_handler(&command) {
                return Some(handler);
            }
            let (name, target) = command.split_once('@')?;
            let me = self.info()?.username?;
            if target.to_lowercase() != me.to_lowercase() {
                return None;
            }
            self.registry().command_handler(name)
        })
    }

    /// `bot.on("message")`.
    async fn route_message(&self, ctx: &Ctx) -> crate::Result<()> {
        for stage in self.registry().message_stages() {
            let result = stage(ctx).await?;
            if !result.effects.is_empty() {
                crate::effects::execute(ctx, result.effects).await?;
            }
            if result.handled {
                return Ok(());
            }
        }
        publication::handle_publication_message(ctx).await?;
        Ok(())
    }

    /// `bot.on("callback_query:data")`.
    async fn route_callback(&self, ctx: &Ctx) -> crate::Result<()> {
        let data = ctx.callback_data().unwrap_or_default();
        if crate::callback::parse_session_callback(data).callback.is_some() {
            publication::handle_publication_callback(ctx).await?;
            return Ok(());
        }
        let handled = match parse_screen_callback(data) {
            Some(callback) => {
                let route = self.registry().screen_route(callback.id).ok_or_else(|| {
                    crate::error(format!(
                        "screen {} is not routed (area {})",
                        callback.id.name(),
                        callback.id.area()
                    ))
                })?;
                route(ctx, &callback).await?
            }
            None => false,
        };
        if !handled {
            ctx.answer_callback_query(Some(&t(Key::ActionUnknown, &[])), false)
                .await?;
        }
        Ok(())
    }
}
