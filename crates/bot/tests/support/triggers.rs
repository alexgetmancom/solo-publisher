//! Steps the recorder drove without an update (`h.trigger(name, …)`): a
//! worker tick, a background repaint. Each has a name in the golden; its
//! Rust replay is one row here, added by the area that ports the worker.
//! A ported case reaching a trigger with no row fails with that name.

use serde_json::Value;

use super::Harness;
use bot::Fut;

/// Runs the trigger on the harness's bot and returns the calls it made.
pub type Trigger = for<'a> fn(&'a Harness) -> Fut<'a, Result<Vec<Value>, String>>;

pub const TRIGGERS: &[(&str, Trigger)] = &[
    ("album worker tick (+5 s)", album_worker_tick),
    (
        "Story worker finishes the cards while the bot waits",
        story_worker_finishes,
    ),
    ("telegram-events tick", telegram_events_tick),
    ("telegram-alerts tick", telegram_alerts_tick),
    ("notification jobs cycle", notification_jobs_cycle),
    ("telegram-translations tick", telegram_translations_tick),
    ("telegram-daily-backup tick (12:00 MSK)", telegram_daily_backup_tick),
    (
        "telegram-daily-backup tick (again the same day)",
        telegram_daily_backup_tick,
    ),
    ("telegram-daily-backup tick (next day)", telegram_daily_backup_tick),
];

fn failed(error: bot::Error) -> String {
    error.to_string()
}

/// One `consumeTelegramEvents` pass (the `telegram-events` loop).
fn telegram_events_tick(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(async move {
        bot::screens::notices::consume_telegram_events(&harness.bot)
            .await
            .map_err(failed)?;
        harness.bot.settled().await;
        Ok(harness.telegram.take_calls())
    })
}

/// One `deliverPendingAlerts` pass with the worker's transport (the
/// `telegram-alerts` loop).
fn telegram_alerts_tick(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(async move {
        bot::screens::notices::deliver_alerts(&harness.bot)
            .await
            .map_err(failed)?;
        harness.bot.settled().await;
        Ok(harness.telegram.take_calls())
    })
}

/// `runNotificationCycle`: the Notifications worker, which sends nothing itself.
fn notification_jobs_cycle(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(async move {
        let deps = harness.bot.deps();
        super::reminders::run_notification_cycle(db::unsafe_db(&deps.db), &*deps.clock)
            .map_err(|error| error.to_string())?;
        Ok(harness.telegram.take_calls())
    })
}

/// `runTranslationCycle`, then each translated draft's card repainted.
fn telegram_translations_tick(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(async move {
        let translated = super::translations::run_translation_cycle(harness, &harness.seed)?;
        bot::screens::notices::refresh_translated_drafts(&harness.bot, &translated)
            .await
            .map_err(failed)?;
        harness.bot.settled().await;
        Ok(harness.telegram.take_calls())
    })
}

/// One `sendDailyBackup` pass (the `telegram-daily-backup` loop).
fn telegram_daily_backup_tick(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(async move {
        bot::screens::notices::send_daily_backup(&harness.bot)
            .await
            .map_err(failed)?;
        harness.bot.settled().await;
        Ok(harness.telegram.take_calls())
    })
}

/// One `telegram-albums` pass (`finalizePendingAlbums`); the step's clock is
/// already past the settle window.
fn album_worker_tick(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(async move {
        bot::albums::finalize_pending_albums(&harness.bot)
            .await
            .map_err(|error| error.to_string())?;
        harness.bot.settled().await;
        Ok(harness.telegram.take_calls())
    })
}

/// `renderStoryCards(h, 1)` while the Story-card waiter polls; the step
/// lasts until the waiter has sent the choice.
fn story_worker_finishes(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(async move {
        let now = foundation::time::to_iso_string(harness.clock.0.get());
        let fixture = super::recorder_tmp().join("fixtures/photo.jpg");
        super::story_cards::render_story_cards(db::unsafe_db(&harness.bot.deps().db), &fixture, 1, &now);
        bot::screens::post::story_card_waiters_settled().await;
        harness.bot.settled().await;
        Ok(harness.telegram.take_calls())
    })
}

pub fn find(name: &str) -> Option<Trigger> {
    TRIGGERS
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, trigger)| *trigger)
}
