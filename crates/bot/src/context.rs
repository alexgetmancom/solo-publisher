//! One update being handled: grammY's `Context` with the bot's dependencies.
//!
//! Every Bot API call an update makes goes through [`Ctx::call`], which plays
//! the two per-update transformers grammY installs on `ctx.api`: the menu
//! plugin's navigation injection and its rendering of `reply_markup` menus.

use std::cell::{Cell, RefCell};
use std::sync::Arc;

use db::rusqlite::Connection;
use domain::application::ports::{ApplicationPorts, Clock};
use domain::publishing::Publishing;
use domain::studio::Studio;
use domain::studio::services::{StudioServices, create_studio_services};
use foundation::config::Config;
use jiff::Timestamp;
use providers::adapters::ProviderCalls;
use serde_json::Value;

use crate::api::FileSource;
use crate::api::payload::{Field, Payload};
use crate::api::types::{Message, Update};
use crate::bot::Bot;
use crate::boundary::TapState;
use crate::menu::{self, MenuId};
use crate::session::Sessions;

/// The menu plugin's navigation for the tapped menu message (`makeNavInstaller`):
/// which menu an edit of that message without a keyboard of its own gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Nav {
    /// A `nav`/`back`/`update` asked for a keyboard nobody has drawn yet.
    pub pending: bool,
    /// `None` after `close()`: the edit then carries no keyboard.
    pub target: Option<MenuId>,
}

pub struct Ctx {
    pub bot: Bot,
    pub update: Update,
    /// The configuration as of this update's arrival.
    pub config: Arc<Config>,
    /// After the acknowledgement, a later answer becomes a chat message.
    pub(crate) redirect_answers: Cell<bool>,
    pub(crate) nav: RefCell<Option<Nav>>,
    pub(crate) tap: RefCell<Option<TapState>>,
}

impl Ctx {
    pub(crate) fn new(bot: Bot, update: Update) -> Self {
        let config = bot.deps().config.load();
        Self {
            bot,
            update,
            config,
            redirect_answers: Cell::new(false),
            nav: RefCell::new(None),
            tap: RefCell::new(None),
        }
    }

    /// A context for work no update started (a worker tick): no tapped
    /// message and no chat of its own, only the bot's dependencies.
    pub(crate) fn worker(bot: &Bot) -> Self {
        Self::new(
            bot.clone(),
            Update {
                update_id: 0,
                message: None,
                edited_message: None,
                channel_post: None,
                edited_channel_post: None,
                callback_query: None,
                extra: serde_json::Map::new(),
            },
        )
    }

    // ---- dependencies ----

    pub fn db(&self) -> &Connection {
        db::unsafe_db(&self.bot.deps().db)
    }

    pub fn clock(&self) -> &dyn Clock {
        &*self.bot.deps().clock
    }

    pub fn now(&self) -> Timestamp {
        self.clock().now()
    }

    pub fn ports(&self) -> ApplicationPorts<'_> {
        ApplicationPorts::within(self.db(), self.clock())
    }

    pub fn sessions(&self) -> Sessions<'_> {
        Sessions::new(self.db(), self.clock())
    }

    pub fn studio(&self) -> Studio<'_> {
        let host = &*self.bot.deps().host;
        Studio::new(
            Publishing::new(self.db(), self.clock(), host.publishing()),
            &self.config,
            host.studio(),
        )
    }

    pub fn services(&self) -> StudioServices<'_, ProviderCalls> {
        create_studio_services(self.studio(), &self.bot.deps().adapters)
    }

    // ---- what the update is about ----

    /// `Number(ctx.from?.id)`: the actor, for every update past the admin gate.
    pub fn actor_id(&self) -> i64 {
        self.update.from_id().unwrap_or_default()
    }

    /// `ctx.chat?.id`.
    pub fn chat_id(&self) -> Option<i64> {
        self.update.chat_id()
    }

    /// `ctx.msg?.message_id`: for a callback, the tapped message.
    pub fn msg_id(&self) -> Option<i64> {
        self.update.msg().map(|message| message.message_id)
    }

    pub fn callback_data(&self) -> Option<&str> {
        self.update.callback_data()
    }

    // ---- the Bot API, through this update's transformers ----

    /// One call with the menu plugin's per-update transformers applied: the
    /// navigation injection (outermost, installed last) and then the menu
    /// rendering.
    pub async fn call(&self, method: &str, mut payload: Payload) -> crate::Result<Value> {
        self.inject_nav(method, &mut payload);
        for field in payload.entries_mut() {
            if let Field::Menu(id) = *field {
                *field = Field::Json(menu::render_markup(self, id)?);
            }
        }
        Ok(self.bot.api().call(method, payload).await?)
    }

    fn inject_nav(&self, method: &str, payload: &mut Payload) {
        const INJECT_METHODS: [&str; 5] = [
            "editMessageText",
            "editMessageCaption",
            "editMessageMedia",
            "editMessageReplyMarkup",
            "stopPoll",
        ];
        let mut nav = self.nav.borrow_mut();
        let Some(nav) = nav.as_mut() else { return };
        if !INJECT_METHODS.contains(&method) || payload.contains("reply_markup") {
            return;
        }
        let same_chat = matches!((payload.get_json("chat_id"), self.chat_id()), (Some(Value::Number(chat)), Some(id)) if chat.as_i64() == Some(id));
        let same_message = matches!((payload.get_json("message_id"), self.msg_id()), (Some(Value::Number(message)), Some(id)) if message.as_i64() == Some(id));
        if !(same_chat && same_message) {
            return;
        }
        nav.pending = false;
        if let Some(target) = nav.target {
            payload.insert("reply_markup", Field::Menu(target));
        }
    }

    fn require_chat(&self, method: &str) -> Result<i64, crate::Error> {
        self.chat_id()
            .ok_or_else(|| crate::error(format!("Missing information for API call to {method}")))
    }

    /// The fields `ctx.reply` and `ctx.replyWith*` put before the caller's
    /// options: the topic of the message being answered, when it has one.
    pub(crate) fn reply_fields(&self, payload: Payload) -> Payload {
        let Some(message) = self.update.msg() else {
            return payload;
        };
        let mut payload = payload;
        if message.is_topic_message == Some(true)
            && let Some(thread) = message.message_thread_id
        {
            payload = payload.set("message_thread_id", thread);
        }
        if let Some(topic) = message.direct_messages_topic_id() {
            payload = payload.set("direct_messages_topic_id", topic.clone());
        }
        payload
    }

    /// `ctx.reply(text, other)`.
    pub async fn reply(&self, text: &str, other: Payload) -> crate::Result<Message> {
        let chat = self.require_chat("sendMessage")?;
        let payload = self.reply_fields(Payload::new().set("chat_id", chat).set("text", text));
        let value = self.call("sendMessage", payload.extend(other)).await?;
        Ok(serde_json::from_value(value)?)
    }

    /// `ctx.replyWithPhoto` and the like: `{ chat_id, <key>: file, ...other }`.
    pub async fn reply_with_file(
        &self,
        method: &str,
        key: &str,
        file: FileSource,
        other: Payload,
    ) -> crate::Result<Message> {
        let chat = self.require_chat(method)?;
        let payload = self.reply_fields(file.into_field(Payload::new().set("chat_id", chat), key));
        let value = self.call(method, payload.extend(other)).await?;
        Ok(serde_json::from_value(value)?)
    }

    /// `ctx.editMessageText(text, other)` on the tapped message.
    pub async fn edit_message_text(&self, text: &str, other: Payload) -> crate::Result<Value> {
        let chat = self.require_chat("editMessageText")?;
        let message = self
            .msg_id()
            .ok_or_else(|| crate::error("Missing information for API call to editMessageText"))?;
        let payload = Payload::new()
            .set("chat_id", chat)
            .set("message_id", message)
            .set("text", text);
        self.call("editMessageText", payload.extend(other)).await
    }

    /// `ctx.editMessageReplyMarkup(other)` on the tapped message.
    pub async fn edit_message_reply_markup(&self, other: Payload) -> crate::Result<Value> {
        let chat = self.require_chat("editMessageReplyMarkup")?;
        let message = self
            .msg_id()
            .ok_or_else(|| crate::error("Missing information for API call to editMessageReplyMarkup"))?;
        let payload = Payload::new().set("chat_id", chat).set("message_id", message);
        self.call("editMessageReplyMarkup", payload.extend(other)).await
    }

    /// `ctx.answerCallbackQuery(...)`. Once the boundary has acknowledged the
    /// tap, a text becomes a new chat message (Telegram takes one answer per
    /// callback) and an empty answer does nothing.
    pub async fn answer_callback_query(&self, text: Option<&str>, show_alert: bool) -> crate::Result<()> {
        if self.redirect_answers.get() {
            if let Some(text) = text.filter(|text| !text.is_empty()) {
                crate::effects::reply_safely(self, text).await;
            }
            return Ok(());
        }
        self.answer_callback_query_now(text, show_alert).await?;
        Ok(())
    }

    /// The real answer, whatever the redirect says.
    pub(crate) async fn answer_callback_query_now(&self, text: Option<&str>, show_alert: bool) -> crate::Result<Value> {
        let id = self
            .update
            .callback_query
            .as_ref()
            .map(|query| query.id.clone())
            .ok_or_else(|| crate::error("Missing information for API call to answerCallbackQuery"))?;
        let mut other = Payload::new();
        if let Some(text) = text {
            other = other.set("text", text);
        }
        if show_alert {
            other = other.set("show_alert", true);
        }
        let payload = Payload::new().set("callback_query_id", id).extend(other);
        self.call("answerCallbackQuery", payload).await
    }
}
