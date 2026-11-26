//! The readiness report persisted per target
//! in `credential_checks`, independently of alerting.

use db::rusqlite::{Connection, params};
use foundation::config::Config;

use crate::Result;
use crate::application::ports::Clock;
use crate::observability::capabilities::capability_report;
use crate::repositories::{stamp, stamp_offset};

/// `updateCredentialChecks`: one row per reported target; how many there were.
pub fn update_credential_checks(config: &Config, sqlite: &Connection, clock: &dyn Clock) -> Result<usize> {
    let now = stamp(clock);
    let report = capability_report(config, sqlite)?;
    for entry in &report {
        let next_check_at = stamp_offset(clock, 3_600_000);
        let required = serde_json::to_string(&entry.required)?;
        let missing = serde_json::to_string(&entry.missing)?;
        sqlite.execute(
            r#"insert into "credential_checks" ("target", "status", "required_env_json", "missing_env_json", "expires_at", "last_checked_at", "next_check_at", "last_error", "details_json") values (?1, ?2, ?3, ?4, null, ?5, ?6, null, '{}') on conflict ("credential_checks"."target") do update set "status" = ?2, "required_env_json" = ?3, "missing_env_json" = ?4, "last_checked_at" = ?5, "next_check_at" = ?6, "last_error" = null"#,
            params![entry.target, entry.status.as_str(), required, missing, now, next_check_at],
        )?;
    }
    Ok(report.len())
}
