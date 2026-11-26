use std::cell::RefCell;
use std::rc::Rc;

use db::rusqlite::{Connection, OptionalExtension, params};

use super::{stamp, stamp_offset};
use crate::Result;
use crate::application::ports::{Clock, DomainEventInput};
use crate::json;

thread_local! {
    static EVENT_BELL: RefCell<Option<Rc<dyn Fn()>>> = const { RefCell::new(None) };
}

/// What [`record_event`] rings once a row is written: every stored event
/// reaches the Telegram consumer, which otherwise waits out its poll. Set by
/// whoever starts that loop; `None` unhooks it. Per thread, as the process's
/// single-threaded runtime is.
pub fn set_event_bell(bell: Option<Rc<dyn Fn()>>) {
    EVENT_BELL.with_borrow_mut(|current| *current = bell);
}

/// The durable event journal behind the application event port.
pub struct EventStore<'a> {
    sqlite: &'a Connection,
    clock: &'a dyn Clock,
}

impl<'a> EventStore<'a> {
    pub fn new(sqlite: &'a Connection, clock: &'a dyn Clock) -> Self {
        Self { sqlite, clock }
    }

    pub fn record(&self, input: &DomainEventInput) -> Result<bool> {
        record_event(self.sqlite, self.clock, input)
    }
}

/// Journals one event unless the same one (publication, type, target) was
/// journalled within its cooldown; `true` when a row was written. Takes any
/// connection, so a caller's transaction journals inside itself.
pub fn record_event(sqlite: &Connection, clock: &dyn Clock, input: &DomainEventInput) -> Result<bool> {
    let now = stamp(clock);
    let cutoff = input
        .cooldown_seconds
        .filter(|seconds| *seconds > 0)
        .map(|seconds| stamp_offset(clock, -(seconds as i64) * 1000));
    let details = input
        .details
        .as_ref()
        .map_or_else(|| "{}".to_string(), json::stringify_object);
    let inserted = sqlite
        .query_row(
            r#"
    INSERT INTO "publication_events"
      (publication_key, event_type, severity, target, message, details_json, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
    WHERE ?8 IS NULL OR NOT EXISTS (
      SELECT 1 FROM "publication_events"
      WHERE publication_key IS ?1
        AND event_type = ?2
        AND target IS ?4
        AND created_at >= ?8
    )
    RETURNING 1 AS inserted
  "#,
            params![
                input.publication_ref,
                input.event_type,
                input.severity.as_str(),
                input.target,
                input.message,
                details,
                now,
                cutoff
            ],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let inserted = inserted == Some(1);
    // A suppressed duplicate has nothing to wake the consumer for.
    if inserted {
        // Cloned out first: the bell may journal again.
        let bell = EVENT_BELL.with_borrow(Clone::clone);
        if let Some(bell) = bell {
            bell();
        }
    }
    Ok(inserted)
}
