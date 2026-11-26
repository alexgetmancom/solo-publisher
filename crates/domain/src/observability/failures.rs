//! Delivery failures recorded as durable domain
//! events; no alert transport is used here.

use db::rusqlite::{Connection, params};
use foundation::config::PUBLISH_LOCK_TIMEOUT_SECONDS;
use serde_json::{Map, Value, json};

use crate::Result;
use crate::application::ports::{Clock, DomainEventInput, Severity};
use crate::observability::alerts::ALERT_COOLDOWN_SECONDS;
use crate::repositories::{record_event, stamp_offset};

/// `recordPublicationFailures`.
pub fn record_publication_failures(sqlite: &Connection, clock: &dyn Clock) -> Result<()> {
    let stale_before = stamp_offset(clock, -(PUBLISH_LOCK_TIMEOUT_SECONDS as i64) * 1000);
    let stale: Vec<(i64, String, String, Option<String>)> = sqlite
        .prepare(
            r#"select "job_id", "publication_key", "target", "status", "current_phase", "reconcile_attempt_count", "publish_at", "payload_json", "attempt_count", "next_attempt_at", "locked_by", "locked_at", "last_error", "created_at", "updated_at" from "publish_jobs" where ("publish_jobs"."status" = ? and "publish_jobs"."locked_at" < ?)"#,
        )?
        .query_map(params!["publishing", stale_before], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(11)?))
        })?
        .collect::<db::rusqlite::Result<_>>()?;
    // Bounded by the alert cooldown: a failed site job is terminal, so
    // without a cutoff every old failure would alert again once per window
    // forever. Only failures that moved recently are worth reporting.
    let site_window_start = stamp_offset(clock, -ALERT_COOLDOWN_SECONDS * 1000);
    let failed_site: Vec<(i64, String, String, Option<String>)> = sqlite
        .prepare(
            r#"select "job_id", "publication_key", "reason", "status", "attempt_count", "next_attempt_at", "locked_by", "locked_at", "last_error", "created_at", "updated_at" from "site_jobs" where ("site_jobs"."status" = ? and "site_jobs"."updated_at" >= ?) order by "site_jobs"."updated_at" desc limit ?"#,
        )?
        .query_map(params!["failed", site_window_start, 100], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(8)?))
        })?
        .collect::<db::rusqlite::Result<_>>()?;
    for (job_id, publication_key, target, locked_at) in stale {
        record_event(
            sqlite,
            clock,
            &DomainEventInput {
                publication_ref: Some(publication_key),
                event_type: "queue.stale".into(),
                severity: Severity::Error,
                target: Some(target),
                message: format!("Publish job {job_id} exceeded lock timeout"),
                details: Some(object(json!({"jobId": job_id, "lockedAt": locked_at}))),
                cooldown_seconds: Some(ALERT_COOLDOWN_SECONDS as u64),
            },
        )?;
    }
    // A social job records its own `publish.job.failed` event in the
    // transaction that moves it to the terminal state; rediscovering terminal
    // jobs here would alert on one failure every cooldown window forever.
    for (job_id, publication_key, reason, last_error) in failed_site {
        record_event(
            sqlite,
            clock,
            &DomainEventInput {
                publication_ref: Some(publication_key),
                event_type: "site.build.failed".into(),
                severity: Severity::Error,
                target: Some("site".into()),
                message: last_error.unwrap_or_else(|| format!("Site job {job_id} failed")),
                details: Some(object(json!({"jobId": job_id, "reason": reason}))),
                cooldown_seconds: Some(ALERT_COOLDOWN_SECONDS as u64),
            },
        )?;
    }
    Ok(())
}

fn object(value: Value) -> Map<String, Value> {
    let Value::Object(object) = value else {
        unreachable!("built as an object")
    };
    object
}
