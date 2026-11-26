//! The row-level vocabulary the queue settles with: the target row that
//! mirrors a job, the journal entry, and the fenced job update that ties them
//! to the lease that earned them.

use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use foundation::js::{present, string_of, truthy};
use foundation::time::parse_iso_ms;
use serde_json::{Map, Value};

use super::errors::PublishResult;
use crate::json;
use crate::{Error, Result};

/// Column assignments in the order the statements name them.
pub(crate) type Columns = Vec<(&'static str, SqlValue)>;

pub(crate) fn text(value: impl Into<String>) -> SqlValue {
    SqlValue::Text(value.into())
}

pub(crate) fn opt_text(value: Option<impl Into<String>>) -> SqlValue {
    value.map_or(SqlValue::Null, |value| SqlValue::Text(value.into()))
}

pub(crate) fn int(value: i64) -> SqlValue {
    SqlValue::Integer(value)
}

/// A Drizzle JSON column write: `JSON.stringify(value)`.
pub(crate) fn json_text(value: &Value) -> SqlValue {
    SqlValue::Text(json::stringify(value))
}

pub(crate) fn strings_json(values: &[String]) -> SqlValue {
    json_text(&Value::Array(values.iter().cloned().map(Value::String).collect()))
}

pub(crate) fn assignments(columns: &[(&'static str, SqlValue)]) -> String {
    columns
        .iter()
        .map(|(column, _)| format!(r#""{column}" = ?"#))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn publication_confirmation_source(result: &PublishResult) -> &'static str {
    if verification_status(result) == Some("verified") {
        return "provider_verify";
    }
    if let Some(Value::Object(raw)) = result.get("raw")
        && raw.contains_key("existingPost")
    {
        return "idempotency_replay";
    }
    "publish_response"
}

pub fn verification_status(result: &PublishResult) -> Option<&str> {
    match result.get("verification") {
        Some(Value::Object(verification)) => verification.get("status").and_then(Value::as_str),
        _ => None,
    }
}

pub fn duration_since(started_at: Option<&str>, finished_at: &str) -> Option<i64> {
    let duration = parse_iso_ms(finished_at)? - parse_iso_ms(started_at?)?;
    (duration >= 0).then_some(duration)
}

/// No other queued, failed or verification-required row for the same target
/// may remain once this job re-enters the queue or becomes its target's record.
pub fn delete_superseded_jobs(sqlite: &Connection, target: &str, job_id: i64, publication_key: &str) -> Result<()> {
    sqlite.execute(
        r#"delete from "publish_jobs" where ("publish_jobs"."target" = ? and "publish_jobs"."job_id" <> ? and "publish_jobs"."status" in (?, ?, ?) and "publish_jobs"."publication_key" = ?)"#,
        params![target, job_id, "queued", "failed", "verification_required", publication_key],
    )?;
    Ok(())
}

/// A job's payload column as an object: anything else reads as empty.
pub fn parse_payload(value: Option<&str>) -> Map<String, Value> {
    match value.map(serde_json::from_str::<Value>) {
        Some(Ok(Value::Object(object))) => object,
        _ => Map::new(),
    }
}

/// The external ids a result names, distinct and in order; the single `id`
/// when it names no list.
pub fn external_ids(result: &PublishResult) -> Vec<String> {
    if let Some(Value::Array(ids)) = result.get("ids") {
        let mut distinct: Vec<String> = Vec::new();
        for id in ids.iter().map(string_of).filter(|id| !id.is_empty()) {
            if !distinct.contains(&id) {
                distinct.push(id);
            }
        }
        if !distinct.is_empty() {
            return distinct;
        }
    }
    present(result.get("id")).map(string_of).into_iter().collect()
}

/// `{ ...record }.field` read for its truthiness.
pub(crate) fn flag(result: &PublishResult, key: &str) -> bool {
    result.get(key).is_some_and(truthy)
}

/// Keeps target state updates consistent across claim, completion and
/// recovery: the columns given are written on insert and on conflict alike;
/// the rest keep their defaults (insert) or their values (update).
pub fn upsert_post_target(sqlite: &Connection, publication_key: &str, target: &str, patch: &Columns) -> Result<()> {
    let columns: Vec<String> = ["publication_key", "target"]
        .into_iter()
        .chain(patch.iter().map(|(column, _)| *column))
        .map(|column| format!(r#""{column}""#))
        .collect();
    let placeholders = vec!["?"; columns.len()].join(", ");
    let values = [text(publication_key), text(target)]
        .into_iter()
        .chain(patch.iter().map(|(_, value)| value.clone()))
        .chain(patch.iter().map(|(_, value)| value.clone()));
    sqlite.execute(
        &format!(
            r#"insert into "publication_targets" ({}) values ({placeholders}) on conflict ("publication_targets"."publication_key", "publication_targets"."target") do update set {}"#,
            columns.join(", "),
            assignments(patch)
        ),
        params_from_iter(values),
    )?;
    Ok(())
}

pub struct JournalEntry<'a> {
    pub event_type: &'a str,
    pub severity: &'a str,
    pub message: &'a str,
    pub details: Value,
}

#[allow(clippy::too_many_arguments)]
pub fn insert_event(
    sqlite: &Connection,
    publication_key: Option<&str>,
    target: Option<&str>,
    event_type: &str,
    severity: &str,
    message: &str,
    details: &Value,
    created_at: &str,
) -> Result<()> {
    sqlite.execute(
        r#"insert into "publication_events" ("id", "publication_key", "event_type", "severity", "target", "message", "details_json", "created_at", "acked_at") values (null, ?, ?, ?, ?, ?, ?, ?, null)"#,
        params![
            publication_key,
            event_type,
            severity,
            target,
            message,
            json::stringify(details),
            created_at
        ],
    )?;
    Ok(())
}

/// A job update and the lease that earns it. The fence travels with the
/// patch, so there is no way to ask for a job update without naming a lease.
pub struct FencedPatch<'a> {
    pub patch: Columns,
    pub fence: &'a str,
}

/// A settlement updates the job, mirrors target state, and journals the event
/// atomically. `job` is `None` only on the stale-lock path, which already won
/// the job row on its own `locked_at` fence. A lost lease is
/// [`Error::PublishLockLost`], which rolls the caller's transaction back.
#[allow(clippy::too_many_arguments)]
pub fn settle_job(
    sqlite: &Connection,
    job_id: i64,
    job: Option<FencedPatch<'_>>,
    publication_key: &str,
    target: &str,
    target_patch: &Columns,
    updated_at: &str,
    event: JournalEntry<'_>,
) -> Result<()> {
    if let Some(job) = job {
        let values = job
            .patch
            .iter()
            .map(|(_, value)| value.clone())
            .chain([int(job_id), text(job.fence)]);
        let updated = sqlite
            .query_row(
                &format!(
                    r#"update "publish_jobs" set {} where ("publish_jobs"."job_id" = ? and "publish_jobs"."locked_by" = ?) returning "job_id""#,
                    assignments(&job.patch)
                ),
                params_from_iter(values),
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if updated.is_none() {
            return Err(Error::PublishLockLost(job_id));
        }
    }
    upsert_post_target(sqlite, publication_key, target, target_patch)?;
    insert_event(
        sqlite,
        Some(publication_key),
        Some(target),
        event.event_type,
        event.severity,
        event.message,
        &event.details,
        updated_at,
    )
}
