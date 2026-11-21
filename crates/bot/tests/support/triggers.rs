//! Steps the recorder drove without an update (`h.trigger(name, …)`): a
//! worker tick, a background repaint. Each has a name in the golden; its
//! Rust replay is one row here, added by the area that ports the worker.
//! A ported case reaching a trigger with no row fails with that name.

use serde_json::Value;

use super::Harness;
use bot::Fut;

/// Runs the trigger on the harness's bot and returns the calls it made.
pub type Trigger = for<'a> fn(&'a Harness) -> Fut<'a, Result<Vec<Value>, String>>;

pub const TRIGGERS: &[(&str, Trigger)] = &[];

pub fn find(name: &str) -> Option<Trigger> {
    TRIGGERS
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, trigger)| *trigger)
}
