//! The routines the operational-retention loop
//! runs: derived history pruned under the maintenance lock.

use db::rusqlite::{Connection, OptionalExtension as _, params};
use domain::application::ports::Clock;
use domain::repositories::transaction;
use serde::Serialize;

use crate::{Error, Result, iso_at};

const RETENTION_BATCH_SIZE: usize = 2_000;
const POST_EVENTS_RETENTION_DAYS: i64 = 365;
const SITE_PAGEVIEWS_RETENTION_DAYS: i64 = 730;
const RUNTIME_USAGE_RETENTION_DAYS: i64 = 365;
const LOCK_NAME: &str = "metrics_maintenance";
const LOCK_MINUTES: i64 = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationalRetentionResult {
    pub publication_events: usize,
    pub site_pageviews: usize,
    pub runtime_usage: usize,
    pub total: usize,
}

/// `pruneOperationalHistory`: derived operational history past its window,
/// keeping milestones and every unresolved warning or error.
pub fn prune_operational_history(sqlite: &Connection, clock: &dyn Clock) -> Result<OperationalRetentionResult> {
    let now = clock.now().as_millisecond();
    let cutoff = |days: i64| iso_at(now - days * 24 * 60 * 60 * 1000);
    let cutoff_day = |days: i64| cutoff(days)[..10].to_owned();
    // In batches, so the write lock is never held for a whole year of rows.
    // `DELETE … LIMIT` needs a build option the bundled SQLite does not have;
    // the rowid subquery deletes the same rows.
    let delete_batched = |table: &str, condition: &str, parameter: String| -> Result<usize> {
        let statement = format!(
            r#"DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} WHERE {condition} LIMIT {RETENTION_BATCH_SIZE})"#
        );
        let mut deleted = 0;
        loop {
            let changes = sqlite.execute(&statement, [&parameter])?;
            deleted += changes;
            if changes < RETENTION_BATCH_SIZE {
                return Ok(deleted);
            }
        }
    };
    let publication_events = delete_batched(
        "publication_events",
        "created_at < ?
       AND event_type != 'analytics.milestone.reached'
       AND NOT (severity IN ('warn', 'error') AND acked_at IS NULL)",
        cutoff(POST_EVENTS_RETENTION_DAYS),
    )?;
    let site_pageviews = delete_batched("site_pageviews", "day < ?", cutoff_day(SITE_PAGEVIEWS_RETENTION_DAYS))?;
    let runtime_usage = delete_batched(
        "runtime_usage",
        "bucket_day < ?",
        cutoff_day(RUNTIME_USAGE_RETENTION_DAYS),
    )?;
    Ok(OperationalRetentionResult {
        publication_events,
        site_pageviews,
        runtime_usage,
        total: publication_events + site_pageviews + runtime_usage,
    })
}

/// `withMaintenanceLock`: the operation under the named lease, refused while
/// another process holds an unexpired one, and released afterwards.
pub fn with_maintenance_lock<T>(
    sqlite: &Connection,
    clock: &dyn Clock,
    operation: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default();
    let owner = format!("{}:{}", host.trim(), std::process::id());
    let now_ms = clock.now().as_millisecond();
    let now = iso_at(now_ms);
    let expires = iso_at(now_ms + LOCK_MINUTES * 60_000);
    transaction(sqlite, || {
        sqlite.execute(
            r#"delete from "maintenance_locks" where ("maintenance_locks"."name" = ? and "maintenance_locks"."expires_at" < ?)"#,
            params![LOCK_NAME, now],
        )?;
        sqlite.execute(
            r#"insert into "maintenance_locks" ("name", "owner", "expires_at", "created_at") values (?, ?, ?, ?) on conflict do nothing"#,
            params![LOCK_NAME, owner, expires, now],
        )?;
        let holder: Option<String> = sqlite
            .query_row(
                r#"select "owner" from "maintenance_locks" where "maintenance_locks"."name" = ?"#,
                [LOCK_NAME],
                |row| row.get(0),
            )
            .optional()?;
        match holder {
            None => Err(Error::message("maintenance lock could not be acquired")),
            Some(holder) if holder != owner => Err(Error::message(format!("maintenance lock is held by {holder}"))),
            Some(_) => Ok(()),
        }
    })?;
    let outcome = operation();
    let released = sqlite.execute(
        r#"delete from "maintenance_locks" where ("maintenance_locks"."name" = ? and "maintenance_locks"."owner" = ?)"#,
        params![LOCK_NAME, owner],
    );
    let value = outcome?;
    released?;
    Ok(value)
}
