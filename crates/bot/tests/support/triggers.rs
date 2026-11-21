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
];

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
