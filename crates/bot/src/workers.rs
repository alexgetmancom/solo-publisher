//! The Telegram side's worker loops (`interfaces/telegram/worker.ts`): one
//! task per loop, each the body the loop runs on every tick, and
//! [`start_telegram_workers`], which starts them as TypeScript did. What each
//! tick sends lives with the messages ([`crate::screens::notices`],
//! [`crate::albums`]); the scheduler, single flight and heartbeats are
//! `runtime`'s.
//!
//! | loop | interval | task |
//! |---|---|---|
//! | `telegram-translations` | 1 s | [`telegram_translations`] |
//! | `telegram-albums` | 1 s | [`telegram_albums`] |
//! | `telegram-events` | `IDLE_POLL_INTERVAL_SECONDS`, rung by every journalled event | [`telegram_events`] |
//! | `telegram-alerts` | `IDLE_POLL_INTERVAL_SECONDS` | [`telegram_alerts`] |
//! | `telegram-daily-backup` | 60 s | [`telegram_daily_backup`] |

mod translations;

use std::rc::Rc;
use std::time::Duration;

use foundation::logger::{LogLevel, log};
use runtime::http::HttpClient;
use runtime::scheduler::ScheduledLoop;
use runtime::worker_signal::{WorkerQueue, ring_worker, set_worker_wake};
use runtime::worker_state::HeartbeatLoops;
use serde_json::json;

use crate::albums::finalize_pending_albums;
use crate::api::payload::Payload;
use crate::bot::Bot;
use crate::context::Ctx;
use crate::screens::notices::{BackupDeliveryStatus, consume_telegram_events, send_daily_backup};
use crate::screens::post::refresh_post_preview_card;

pub use translations::run_translation_cycle;

pub const TRANSLATIONS_INTERVAL: Duration = Duration::from_secs(1);
pub const ALBUMS_INTERVAL: Duration = Duration::from_secs(1);
/// `DAILY_INTERFACE_POLL_INTERVAL_SECONDS`.
pub const DAILY_BACKUP_INTERVAL: Duration = Duration::from_secs(60);

/// `startTelegramWorkers`: the five loops, in TypeScript's order, each
/// through `loops` so it records its heartbeat. The event loop is rung the
/// moment a domain event is journalled rather than waiting out its poll: the
/// card an operator is watching changes when it runs. Must be called inside
/// the process's `LocalSet`.
pub fn start_telegram_workers<D: 'static>(
    bot: &Bot,
    http: HttpClient,
    loops: &HeartbeatLoops<D>,
) -> Vec<ScheduledLoop> {
    let poll = Duration::from_secs(bot.deps().config.load().idle_poll_interval_seconds);
    let task = |run: for<'a> fn(&'a Bot) -> crate::Fut<'a, crate::Result<()>>| {
        let bot = bot.clone();
        move || {
            let bot = bot.clone();
            async move { run(&bot).await }
        }
    };
    let events = loops.start("telegram-events", poll, task(|bot| Box::pin(telegram_events(bot))));
    set_worker_wake(WorkerQueue::TelegramEvents, Some(events.waker()));
    domain::repositories::set_event_bell(Some(Rc::new(|| ring_worker(WorkerQueue::TelegramEvents))));
    let http = Rc::new(http);
    let translations = {
        let bot = bot.clone();
        move || {
            let (bot, http) = (bot.clone(), Rc::clone(&http));
            async move { telegram_translations(&bot, &http).await }
        }
    };
    vec![
        loops.start("telegram-translations", TRANSLATIONS_INTERVAL, translations),
        loops.start(
            "telegram-albums",
            ALBUMS_INTERVAL,
            task(|bot| Box::pin(telegram_albums(bot))),
        ),
        events,
        loops.start("telegram-alerts", poll, task(|bot| Box::pin(telegram_alerts(bot)))),
        loops.start(
            "telegram-daily-backup",
            DAILY_BACKUP_INTERVAL,
            task(|bot| Box::pin(telegram_daily_backup(bot))),
        ),
    ]
}

/// `telegram-events`: durable domain events rendered as Telegram messages.
pub async fn telegram_events(bot: &Bot) -> crate::Result<()> {
    let events = consume_telegram_events(bot).await?;
    if events > 0 {
        log(
            LogLevel::Debug,
            "telegram event loop tick",
            Some(json!({"events": events})),
        );
    }
    Ok(())
}

/// `telegram-translations`: a draft's English is made here rather than in
/// the tap that created it; the card is already on screen, and this puts the
/// translation into it.
pub async fn telegram_translations(bot: &Bot, http: &HttpClient) -> crate::Result<()> {
    let translated = run_translation_cycle(bot, http).await?;
    let ctx = Ctx::worker(bot);
    for &draft_id in &translated {
        refresh_post_preview_card(&ctx, draft_id).await?;
    }
    if !translated.is_empty() {
        log(
            LogLevel::Info,
            "draft translations settled",
            Some(json!({"drafts": translated})),
        );
    }
    Ok(())
}

/// `telegram-albums`: media groups whose settle window has passed become drafts.
pub async fn telegram_albums(bot: &Bot) -> crate::Result<()> {
    let completed = finalize_pending_albums(bot).await?;
    if completed > 0 {
        log(
            LogLevel::Info,
            "album drafts finalized",
            Some(json!({"completed": completed})),
        );
    }
    Ok(())
}

/// `telegram-alerts`: Observability's pending alerts, sent to the first
/// administrator (none configured: the alerts wait).
pub async fn telegram_alerts(bot: &Bot) -> crate::Result<()> {
    let ctx = Ctx::worker(bot);
    let api = ctx.bot.api();
    let send = ctx.config.controller_admin_ids.first().map(|&actor_id| {
        move |text: String| async move {
            api.send_message(actor_id, &text, Payload::new())
                .await
                .map(|_| ())
                .map_err(|error| error.js_string())
        }
    });
    let alerts = domain::observability::alerts::deliver_pending_alerts(ctx.db(), ctx.clock(), send).await?;
    if alerts > 0 {
        log(
            LogLevel::Debug,
            "telegram alert loop tick",
            Some(json!({"alerts": alerts})),
        );
    }
    Ok(())
}

/// `telegram-daily-backup`: the day's database copy, once the hour is reached.
pub async fn telegram_daily_backup(bot: &Bot) -> crate::Result<()> {
    let backup = send_daily_backup(bot).await?;
    if !matches!(backup, BackupDeliveryStatus::NotDue | BackupDeliveryStatus::Disabled) {
        log(
            LogLevel::Debug,
            "telegram daily backup tick",
            Some(json!({"status": backup.as_str()})),
        );
    }
    Ok(())
}
