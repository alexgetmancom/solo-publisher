use db::rusqlite::{Connection, OptionalExtension, params};

use super::{stamp, stamp_offset};
use crate::Result;
use crate::application::ports::{Clock, DomainEventInput};
use crate::json;

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
    Ok(inserted == Some(1))
}
