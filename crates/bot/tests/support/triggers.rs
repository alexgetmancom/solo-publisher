//! Steps the recorder drove without an update (`h.trigger(name, …)`): a
//! worker tick, a background repaint. Each has a name in the golden; its
//! Rust replay is one row here, added by the area that owns the worker.
//! A registered case reaching a trigger with no row fails with that name.

use std::path::Path;

use db::rusqlite::{Connection, params};
use serde_json::Value;

use super::Harness;
use bot::Fut;

/// Runs the trigger on the harness's bot and returns the calls it made.
pub(crate) type Trigger = for<'a> fn(&'a Harness) -> Fut<'a, Result<Vec<Value>, String>>;

pub(crate) const TRIGGERS: &[(&str, Trigger)] = &[
    ("album worker tick (+5 s)", telegram_albums),
    (
        "Story worker finishes the cards while the bot waits",
        story_worker_finishes,
    ),
    ("telegram-events tick", telegram_events),
    ("telegram-alerts tick", telegram_alerts),
    ("notification jobs cycle", notifications),
    ("telegram-translations tick", telegram_translations),
    ("telegram-daily-backup tick (12:00 MSK)", telegram_daily_backup),
    ("telegram-daily-backup tick (again the same day)", telegram_daily_backup),
    ("telegram-daily-backup tick (next day)", telegram_daily_backup),
    // loops/: each loop's own task (`bot::workers`).
    ("telegram-events loop", telegram_events),
    ("telegram-translations loop", telegram_translations),
    ("telegram-albums loop", telegram_albums),
    ("telegram-alerts loop", telegram_alerts),
    ("telegram-daily-backup loop", telegram_daily_backup),
    ("notifications loop", notifications),
];

fn failed(error: bot::Error) -> String {
    error.to_string()
}

/// One tick of a loop's task, then the calls it made once the bot is quiet.
async fn tick(harness: &Harness, task: impl Future<Output = bot::Result<()>>) -> Result<Vec<Value>, String> {
    task.await.map_err(failed)?;
    harness.bot.settled().await;
    Ok(harness.telegram.take_calls())
}

fn telegram_events(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(tick(harness, bot::workers::telegram_events(&harness.bot)))
}

fn telegram_alerts(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(tick(harness, bot::workers::telegram_alerts(&harness.bot)))
}

/// The translation loop, its DeepSeek the golden one.
fn telegram_translations(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(tick(
        harness,
        bot::workers::telegram_translations(&harness.bot, &harness.http),
    ))
}

fn telegram_daily_backup(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(tick(harness, bot::workers::telegram_daily_backup(&harness.bot)))
}

/// The step's clock is already past the settle window.
fn telegram_albums(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(tick(harness, bot::workers::telegram_albums(&harness.bot)))
}

/// `runNotificationCycle`: the Notifications worker, which sends nothing itself.
fn notifications(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(async move {
        let deps = harness.bot.deps();
        domain::notifications::run_notification_cycle(db::unsafe_db(&deps.db), &*deps.clock)
            .map_err(|error| error.to_string())?;
        Ok(harness.telegram.take_calls())
    })
}

/// `renderStoryCards(h, 1)` while the Story-card waiter polls; the step
/// lasts until the waiter has sent the choice.
fn story_worker_finishes(harness: &Harness) -> Fut<'_, Result<Vec<Value>, String>> {
    Box::pin(async move {
        let now = foundation::time::to_iso_string(harness.clock.0.get());
        let fixture = super::recorder_tmp().join("fixtures/photo.jpg");
        render_story_cards(db::unsafe_db(&harness.bot.deps().db), &fixture, 1, &now);
        bot::screens::post::story_card_waiters_settled().await;
        harness.bot.settled().await;
        Ok(harness.telegram.take_calls())
    })
}

/// The recorder's `renderStoryCards(h, draftId)`: every card of the draft
/// rendered, its file the 1x1 JPEG fixture.
fn render_story_cards(sqlite: &Connection, fixture: &Path, draft_id: i64, now: &str) {
    sqlite
        .execute(
            r#"update "draft_story_cards" set "status" = 'ready', "local_path" = ?, "updated_at" = ? where "draft_story_cards"."draft_id" = ?"#,
            params![fixture.display().to_string(), now, draft_id],
        )
        .unwrap();
}

pub(crate) fn find(name: &str) -> Option<Trigger> {
    TRIGGERS
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, trigger)| *trigger)
}
