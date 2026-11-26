//! A due sync is reserved for one worker
//! instance atomically; refresh cadence and crash recovery are independent, so
//! a daily job does not hold a two-day lease.

use db::rusqlite::{Connection, OptionalExtension, params};

use crate::Result;
use crate::application::ports::Clock;
use crate::repositories::{stamp, stamp_offset};

const DEFAULT_SYNC_LEASE_SECONDS: i64 = 15 * 60;

/// `claimSync(backendDb, source, { intervalSeconds, owner })` with the default lease.
pub fn claim_sync(
    sqlite: &Connection,
    clock: &dyn Clock,
    source: &str,
    interval_seconds: i64,
    owner: &str,
) -> Result<bool> {
    let now = stamp(clock);
    let due_before = stamp_offset(clock, -interval_seconds * 1000);
    let stale_before = stamp_offset(clock, -DEFAULT_SYNC_LEASE_SECONDS * 1000);
    sqlite.execute(
        r#"insert into "analytics_sync" ("source", "last_synced_at", "last_success_at", "last_error", "locked_by", "locked_at") values (?, '1970-01-01T00:00:00.000Z', null, null, null, null) on conflict do nothing"#,
        [source],
    )?;
    let claimed = sqlite
        .query_row(
            r#"update "analytics_sync" set "locked_by" = ?1, "locked_at" = ?2 where ("analytics_sync"."source" = ?3 and "analytics_sync"."last_synced_at" <= ?4 and ("analytics_sync"."locked_by" is null or "analytics_sync"."locked_at" is null or "analytics_sync"."locked_at" < ?5)) returning "source""#,
            params![owner, now, source, due_before, stale_before],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(claimed.is_some())
}

/// `markSynced(backendDb, source, error, owner)`: settles the claim this owner holds.
pub fn mark_synced(
    sqlite: &Connection,
    clock: &dyn Clock,
    source: &str,
    error: Option<&str>,
    owner: &str,
) -> Result<()> {
    let last_synced_at = stamp(clock);
    match error {
        Some(error) => sqlite.execute(
            r#"update "analytics_sync" set "last_synced_at" = ?1, "last_error" = ?2, "locked_by" = null, "locked_at" = null where ("analytics_sync"."source" = ?3 and "analytics_sync"."locked_by" = ?4)"#,
            params![last_synced_at, error, source, owner],
        )?,
        None => sqlite.execute(
            r#"update "analytics_sync" set "last_synced_at" = ?1, "last_success_at" = ?1, "last_error" = null, "locked_by" = null, "locked_at" = null where ("analytics_sync"."source" = ?2 and "analytics_sync"."locked_by" = ?3)"#,
            params![last_synced_at, source, owner],
        )?,
    };
    Ok(())
}
