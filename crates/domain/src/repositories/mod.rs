//! SQLite repositories behind the application ports, one module per
//! TypeScript repository. Statements keep the Drizzle text they replace —
//! bound parameters, column order, ordering — so a query without an `ORDER BY`
//! still returns its rows in the order the TypeScript side sees.

mod actionable_issues;
mod channels;
mod conversation_sessions;
mod draft_translations;
mod drafts;
mod entity_enrichment;
mod events;
mod studio_media_assets;
mod studio_posts;
mod studio_queue;
mod studio_settings;
mod studio_videos;
mod thread_parts;

pub use actionable_issues::ActionableIssueStore;
pub use channels::ChannelStore;
pub use conversation_sessions::ConversationSessionStore;
pub use draft_translations::DraftTranslationStore;
pub use drafts::DraftStore;
pub use entity_enrichment::EntityEnrichmentStore;
pub use events::{EventStore, record_event, set_event_bell};
pub use studio_media_assets::StudioMediaAssetStore;
pub use studio_posts::StudioPostStore;
pub use studio_queue::StudioQueueStore;
pub use studio_settings::StudioSettingsStore;
pub use studio_videos::StudioVideoStore;
pub use thread_parts::ThreadPartStore;

use db::rusqlite::Connection;
use db::rusqlite::types::Value as SqlValue;
use serde::de::DeserializeOwned;

use crate::Result;
use crate::application::ports::Clock;

/// The delivery targets that are the public site. Site cards are rendered, not
/// published: their only terminal failure is the site job's.
pub(crate) const SITE_TARGETS: [&str; 2] = ["site_ru", "site_en"];

pub(crate) fn stamp(clock: &dyn Clock) -> String {
    foundation::time::to_iso_string(clock.now())
}

/// `clock.now() + offset_ms` as an ISO instant.
pub(crate) fn stamp_offset(clock: &dyn Clock, offset_ms: i64) -> String {
    let at = clock.now().as_millisecond() + offset_ms;
    foundation::time::to_iso_string(jiff::Timestamp::from_millisecond(at).expect("instant within year ±9999"))
}

/// Drizzle's `inArray`: a placeholder per value, and `false` for none.
pub(crate) fn in_list(column: &str, count: usize) -> String {
    if count == 0 {
        return "false".into();
    }
    format!("{column} in ({})", vec!["?"; count].join(", "))
}

pub(crate) fn integers(values: &[i64]) -> impl Iterator<Item = SqlValue> + '_ {
    values.iter().map(|value| SqlValue::Integer(*value))
}

/// A Drizzle `json` column on read: `JSON.parse` of the text, `None` for NULL.
pub(crate) fn json_column<T: DeserializeOwned>(text: Option<String>) -> Result<Option<T>> {
    text.map(|text| serde_json::from_str(&text))
        .transpose()
        .map_err(Into::into)
}

/// `crypto.randomUUID()`: a version 4 UUID in lowercase hex.
pub fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the operating system has no randomness source");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// bun:sqlite's `db.transaction(work)` as Drizzle calls it: `BEGIN` (deferred)
/// on a connection in autocommit, a savepoint inside a transaction the caller
/// already holds. Any error, or a panic, rolls the work back.
pub fn transaction<T>(sqlite: &Connection, work: impl FnOnce() -> Result<T>) -> Result<T> {
    run_transaction(sqlite, "BEGIN", work)
}

/// Drizzle's `transaction(work, { behavior: "immediate" })`: `BEGIN IMMEDIATE`
/// takes the write lock up front, so what the work reads still holds when it
/// writes. Nested, it is a savepoint like any other.
pub fn immediate_transaction<T>(sqlite: &Connection, work: impl FnOnce() -> Result<T>) -> Result<T> {
    run_transaction(sqlite, "BEGIN IMMEDIATE", work)
}

fn run_transaction<T>(sqlite: &Connection, top_level: &'static str, work: impl FnOnce() -> Result<T>) -> Result<T> {
    struct Open<'a> {
        sqlite: &'a Connection,
        rollback: &'static str,
        done: bool,
    }
    impl Drop for Open<'_> {
        fn drop(&mut self) {
            if !self.done {
                // The original error is what the caller needs; a failed
                // rollback leaves SQLite to roll back when the handle closes.
                let _ = self.sqlite.execute_batch(self.rollback);
            }
        }
    }
    let nested = !sqlite.is_autocommit();
    let (begin, commit, rollback) = if nested {
        (
            "SAVEPOINT domain_transaction",
            "RELEASE domain_transaction",
            "ROLLBACK TO domain_transaction; RELEASE domain_transaction",
        )
    } else {
        (top_level, "COMMIT", "ROLLBACK")
    };
    sqlite.execute_batch(begin)?;
    let mut open = Open {
        sqlite,
        rollback,
        done: false,
    };
    let value = work()?;
    sqlite.execute_batch(commit)?;
    open.done = true;
    Ok(value)
}
