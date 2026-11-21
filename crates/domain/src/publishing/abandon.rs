//! The one way a delivery target that did not land is given up on. Nothing is
//! sent and nothing is removed from a platform: the job stops asking to be
//! dealt with, and the publication can settle. Only a target the operator was
//! already being asked about qualifies — `failed`, or `verification_required`,
//! which is ambiguous and settled here as such.

use db::rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use super::Publishing;
use super::queue_state::insert_event;
use super::requeue::RequeueScope;
use crate::Result;
use crate::repositories::transaction;
use crate::targets::is_site_target;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AbandonOutcome {
    Abandoned,
    NotAbandonable,
}

impl AbandonOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Abandoned => "abandoned",
            Self::NotAbandonable => "not_abandonable",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AbandonResult {
    pub target: String,
    pub outcome: AbandonOutcome,
    pub status: Option<String>,
}

const ABANDONABLE_STATUSES: [&str; 2] = ["failed", "verification_required"];

fn refused(target: &str, status: Option<String>) -> AbandonResult {
    AbandonResult {
        target: target.to_owned(),
        outcome: AbandonOutcome::NotAbandonable,
        status,
    }
}

impl Publishing<'_> {
    pub fn abandon_publication_targets(&self, scope: &RequeueScope, targets: &[&str]) -> Result<Vec<AbandonResult>> {
        let now = self.now();
        let sqlite = self.sqlite;
        transaction(sqlite, || {
            let mut seen: Vec<&str> = Vec::new();
            let mut results = Vec::new();
            for target in targets.iter().copied() {
                if seen.contains(&target) {
                    continue;
                }
                seen.push(target);
                results.push(if is_site_target(target) {
                    abandon_site_target(sqlite, scope, target, &now)?
                } else {
                    abandon_social_target(sqlite, scope, target, &now)?
                });
            }
            Ok(results)
        })
    }
}

fn abandon_site_target(sqlite: &Connection, scope: &RequeueScope, target: &str, now: &str) -> Result<AbandonResult> {
    let row: Option<(i64, String)> = sqlite
        .query_row(
            r#"select "job_id", "status" from "site_jobs" where ("site_jobs"."publication_key" = ? and "site_jobs"."reason" = ?) order by "site_jobs"."job_id" desc"#,
            params![scope.publication_key, target],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((job_id, status)) = row else {
        return Ok(refused(target, None));
    };
    if !ABANDONABLE_STATUSES.contains(&status.as_str()) {
        return Ok(refused(target, Some(status)));
    }
    // Fenced on the status the decision was made from, so a worker or
    // reconciliation that moved the job in between keeps it.
    let abandoned = sqlite
        .query_row(
            r#"update "site_jobs" set "status" = ?, "next_attempt_at" = null, "locked_by" = null, "locked_at" = null, "updated_at" = ? where ("site_jobs"."job_id" = ? and "site_jobs"."status" = ?) returning "job_id""#,
            params!["cancelled", now, job_id, status],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if abandoned.is_none() {
        return Ok(refused(target, Some(status)));
    }
    settle(sqlite, &scope.publication_key, target, status, now)
}

fn abandon_social_target(sqlite: &Connection, scope: &RequeueScope, target: &str, now: &str) -> Result<AbandonResult> {
    let row: Option<(i64, String, String)> = sqlite
        .query_row(
            r#"select "job_id", "status", "publication_key" from "publish_jobs" where ("publish_jobs"."publication_key" = ? and "publish_jobs"."target" = ?) order by "publish_jobs"."job_id" desc"#,
            params![scope.publication_key, target],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((job_id, status, publication_key)) = row else {
        return Ok(refused(target, None));
    };
    if !ABANDONABLE_STATUSES.contains(&status.as_str()) {
        return Ok(refused(target, Some(status)));
    }
    let abandoned = sqlite
        .query_row(
            r#"update "publish_jobs" set "status" = ?, "next_attempt_at" = null, "locked_by" = null, "locked_at" = null, "current_phase" = null, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ?) returning "job_id""#,
            params!["cancelled", now, job_id, status],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if abandoned.is_none() {
        return Ok(refused(target, Some(status)));
    }
    settle(sqlite, &publication_key, target, status, now)
}

/// The mirrored target row and the journal entry, in the transaction that
/// abandoned the job: an ambiguous target given up on is the one state worth
/// reading back later, so it is never only a status change.
fn settle(
    sqlite: &Connection,
    publication_key: &str,
    target: &str,
    previous_status: String,
    now: &str,
) -> Result<AbandonResult> {
    sqlite.execute(
        r#"update "publication_targets" set "status" = ?, "updated_at" = ? where ("publication_targets"."publication_key" = ? and "publication_targets"."target" = ?)"#,
        params!["cancelled", now, publication_key, target],
    )?;
    insert_event(
        sqlite,
        Some(publication_key),
        Some(target),
        "publish.target.abandoned",
        "warn",
        &format!("{target} was abandoned by the operator and will not be published"),
        &json!({ "previous_status": previous_status }),
        now,
    )?;
    Ok(AbandonResult {
        target: target.to_owned(),
        outcome: AbandonOutcome::Abandoned,
        status: Some(previous_status),
    })
}
