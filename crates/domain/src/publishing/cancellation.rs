//! "Cancel the rest" of a publication: a declaration of its own, outliving the
//! call that made it. A worker that already claimed a target checks for it in
//! the `WHERE` of the write that would start the next delivery, so cancelling
//! no longer depends on catching the queue at the right instant.

use db::rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::json;

use super::Publishing;
use super::delivery_payload::has_resume_state;
use super::queue_state::{insert_event, parse_payload};
use crate::Result;
use crate::application::publication_ref::{PublicationRefKind, publication_ref};
use crate::repositories::transaction;

/// What cancelling did, in the operator's terms: which targets will not be
/// delivered, and which were already far enough along to be finished instead.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CancellationReport {
    pub stopped: Vec<String>,
    pub finishing: Vec<String>,
}

/// A target still to be delivered, and whether cancelling would stop it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingTarget {
    pub target: String,
    pub started: bool,
}

/// The condition a delivery write carries so it cannot start work the
/// operator has already cancelled; binds the publication key.
pub(crate) const DELIVERY_NOT_CANCELLED: &str =
    r#"not exists (select 1 from "publication_cancellations" where "publication_cancellations"."publication_key" = ?)"#;

pub(crate) fn publication_id(sqlite: &Connection, draft_id: i64) -> Result<Option<i64>> {
    Ok(sqlite
        .query_row(
            r#"select "post_id" from "drafts" where "drafts"."id" = ?"#,
            [draft_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten())
}

/// Whether the declaration exists, for the one caller that already lost a
/// write to it and has to say why.
pub fn is_cancellation_declared(sqlite: &Connection, publication_key: &str) -> Result<bool> {
    Ok(sqlite
        .query_row(
            r#"select "publication_key" from "publication_cancellations" where "publication_cancellations"."publication_key" = ?"#,
            [publication_key],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// A publication being planned again is not the cancelled one.
pub fn clear_delivery_cancellation(sqlite: &Connection, publication_key: &str) -> Result<()> {
    sqlite.execute(
        r#"delete from "publication_cancellations" where "publication_cancellations"."publication_key" = ?"#,
        [publication_key],
    )?;
    Ok(())
}

pub(crate) fn declare_cancellation(sqlite: &Connection, publication_key: &str, actor_id: i64, now: &str) -> Result<()> {
    sqlite.execute(
        r#"insert into "publication_cancellations" ("publication_key", "actor_id", "requested_at") values (?, ?, ?) on conflict do nothing"#,
        params![publication_key, actor_id, now],
    )?;
    Ok(())
}

fn mark_target_cancelled(sqlite: &Connection, publication_key: &str, target: &str, now: &str) -> Result<()> {
    sqlite.execute(
        r#"update "publication_targets" set "status" = ?, "updated_at" = ? where ("publication_targets"."publication_key" = ? and "publication_targets"."target" = ?)"#,
        params!["cancelled", now, publication_key, target],
    )?;
    Ok(())
}

impl Publishing<'_> {
    pub fn pending_delivery_targets(&self, draft_id: i64) -> Result<Vec<PendingTarget>> {
        let Some(post_id) = publication_id(self.sqlite, draft_id)? else {
            return Ok(Vec::new());
        };
        let key = publication_ref(PublicationRefKind::Post, post_id);
        let mut pending: Vec<PendingTarget> = self
            .sqlite
            .prepare(
                r#"select "target", "status", "payload_json" from "publish_jobs" where ("publish_jobs"."publication_key" = ? and "publish_jobs"."status" in (?, ?))"#,
            )?
            .query_map(params![key, "queued", "publishing"], |row| {
                let (target, status, payload): (String, String, Option<String>) = (row.get(0)?, row.get(1)?, row.get(2)?);
                Ok(PendingTarget {
                    started: status == "publishing" || has_resume_state(&parse_payload(payload.as_deref())),
                    target,
                })
            })?
            .collect::<db::rusqlite::Result<_>>()?;
        let site: Vec<PendingTarget> = self
            .sqlite
            .prepare(
                r#"select "reason" from "site_jobs" where ("site_jobs"."publication_key" = ? and "site_jobs"."status" in (?, ?))"#,
            )?
            .query_map(params![key, "queued", "rendering"], |row| {
                Ok(PendingTarget {
                    target: row.get(0)?,
                    started: false,
                })
            })?
            .collect::<db::rusqlite::Result<_>>()?;
        pending.extend(site);
        Ok(pending)
    }

    /// Declares the rest of a publication cancelled. Queued work that has
    /// published nothing stops here; anything already part-way to a platform
    /// is left to finish. The declaration, every stopped job, its target row
    /// and the journal entry are one transaction.
    pub fn cancel_remaining_delivery(&self, draft_id: i64, actor_id: i64) -> Result<CancellationReport> {
        let now = self.now();
        let Some(post_id) = publication_id(self.sqlite, draft_id)? else {
            return Ok(CancellationReport::default());
        };
        let key = publication_ref(PublicationRefKind::Post, post_id);
        let sqlite = self.sqlite;
        transaction(sqlite, || {
            declare_cancellation(sqlite, &key, actor_id, &now)?;
            let mut report = CancellationReport::default();
            let social: Vec<(i64, String, String, Option<String>)> = sqlite
                .prepare(
                    r#"select "job_id", "target", "status", "payload_json" from "publish_jobs" where ("publish_jobs"."publication_key" = ? and "publish_jobs"."status" in (?, ?, ?))"#,
                )?
                .query_map(params![key, "queued", "publishing", "failed"], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<db::rusqlite::Result<_>>()?;
            for (job_id, target, status, payload) in social {
                // A claimed job and a job carrying what it already published
                // are the same case: something of this target may be live.
                if status == "publishing" || has_resume_state(&parse_payload(payload.as_deref())) {
                    report.finishing.push(target);
                    continue;
                }
                let cancelled = sqlite
                    .query_row(
                        r#"update "publish_jobs" set "status" = ?, "next_attempt_at" = null, "locked_by" = null, "locked_at" = null, "current_phase" = null, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ?) returning "job_id""#,
                        params!["cancelled", now, job_id, status],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                if cancelled.is_none() {
                    report.finishing.push(target);
                    continue;
                }
                mark_target_cancelled(sqlite, &key, &target, &now)?;
                report.stopped.push(target);
            }
            let site: Vec<(i64, String, String)> = sqlite
                .prepare(
                    r#"select "job_id", "reason", "status" from "site_jobs" where ("site_jobs"."publication_key" = ? and "site_jobs"."status" in (?, ?))"#,
                )?
                .query_map(params![key, "queued", "failed"], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<db::rusqlite::Result<_>>()?;
            for (job_id, target, status) in site {
                let cancelled = sqlite
                    .query_row(
                        r#"update "site_jobs" set "status" = ?, "next_attempt_at" = null, "locked_by" = null, "locked_at" = null, "updated_at" = ? where ("site_jobs"."job_id" = ? and "site_jobs"."status" = ?) returning "job_id""#,
                        params!["cancelled", now, job_id, status],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                if cancelled.is_none() {
                    continue;
                }
                mark_target_cancelled(sqlite, &key, &target, &now)?;
                report.stopped.push(target);
            }
            let stopped = if report.stopped.is_empty() {
                "nothing left to stop".to_owned()
            } else {
                report.stopped.join(", ")
            };
            let finishing = if report.finishing.is_empty() {
                String::new()
            } else {
                format!("; finishing {}", report.finishing.join(", "))
            };
            insert_event(
                sqlite,
                Some(&key),
                None,
                "publish.remaining.cancelled",
                "warn",
                &format!("Remaining delivery cancelled: {stopped}{finishing}"),
                &json!({ "actor_id": actor_id, "stopped": report.stopped, "finishing": report.finishing }),
                &now,
            )?;
            Ok(report)
        })
    }
}
