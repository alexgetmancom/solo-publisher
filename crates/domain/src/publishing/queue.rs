//! The publish queue: claiming a due job under a lease, and settling what the
//! delivery attempt answered. Every settlement is fenced by the lease that
//! started it, so a worker that lost its job writes nothing.

use db::rusqlite::{OptionalExtension, Row, params};
use foundation::logger::{LogLevel, log};
use serde_json::{Map, Value, json};

use super::Publishing;
use super::cancellation::{DELIVERY_NOT_CANCELLED, is_cancellation_declared};
use super::delivery_payload::{DeliveryPayload, deferred_delivery_payload, has_resume_state, resumed_delivery_payload};
use super::errors::{
    PublishErrorClass, PublishFailure, PublishResult, classify_message, classify_publish_error,
    normalize_publish_result, present,
};
use super::job_policy::{
    failed_job_transition, may_have_reached_audience, partial_publication_transition, partial_retry_policy,
    publish_retry_policy,
};
use super::publication_owner::refresh_publication_owner;
use super::queue_state::{
    Columns, FencedPatch, JournalEntry, delete_superseded_jobs, duration_since, external_ids, flag, insert_event, int,
    json_text, opt_text, parse_payload, publication_confirmation_source, settle_job, strings_json, text,
    upsert_post_target, verification_status,
};
use super::{iso_at, parse_ms};
use crate::json::js_string;
use crate::repositories::{random_uuid, transaction};
use crate::{Error, Result};

pub const PUBLISH_CLAIM_LIMIT: i64 = 20;

/// A job a worker holds: what it delivers, and the lease that earns its settlement.
#[derive(Clone, Debug, PartialEq)]
pub struct ClaimedPublishJob {
    pub job_id: i64,
    pub publication_key: String,
    pub target: String,
    pub payload: Map<String, Value>,
    pub attempt_count: i64,
    pub lock_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DuePublishJob {
    pub job_id: i64,
    pub target: String,
}

/// A `publish_jobs` row.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PublishJobRow {
    pub job_id: i64,
    pub publication_key: String,
    pub target: String,
    pub status: String,
    pub current_phase: Option<String>,
    pub payload_json: Option<String>,
    pub attempt_count: i64,
    pub locked_by: Option<String>,
    pub locked_at: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: String,
}

pub(crate) const SELECT_PUBLISH_JOB: &str = r#"select "job_id", "publication_key", "target", "status", "current_phase", "payload_json", "attempt_count", "locked_by", "locked_at", "last_error", "updated_at" from "publish_jobs""#;

pub(crate) fn publish_job_row(row: &Row<'_>) -> db::rusqlite::Result<PublishJobRow> {
    Ok(PublishJobRow {
        job_id: row.get(0)?,
        publication_key: row.get(1)?,
        target: row.get(2)?,
        status: row.get(3)?,
        current_phase: row.get(4)?,
        payload_json: row.get(5)?,
        attempt_count: row.get(6)?,
        locked_by: row.get(7)?,
        locked_at: row.get(8)?,
        last_error: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

/// `<prefix>:<hostname>:<pid>`, the worker part of a lease.
pub fn worker_id(prefix: &str) -> String {
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default();
    format!("{prefix}:{}:{}", host.trim(), std::process::id())
}

fn fresh_worker() -> String {
    format!("{}:{}", worker_id("backend"), random_uuid())
}

impl Publishing<'_> {
    fn publish_job(&self, job_id: i64) -> Result<Option<PublishJobRow>> {
        Ok(self
            .sqlite
            .query_row(
                &format!(r#"{SELECT_PUBLISH_JOB} where "publish_jobs"."job_id" = ?"#),
                [job_id],
                publish_job_row,
            )
            .optional()?)
    }

    /// The due jobs, then a claim of each; `worker` defaults to a fresh lease.
    pub fn claim_due_publish_jobs(&self, limit: i64, worker: Option<&str>) -> Result<Vec<ClaimedPublishJob>> {
        let worker = worker.map_or_else(fresh_worker, str::to_owned);
        let mut claimed = Vec::new();
        for job in self.due_publish_jobs(limit)? {
            if let Some(job) = self.claim_publish_job(job.job_id, Some(&worker))? {
                claimed.push(job);
            }
        }
        Ok(claimed)
    }

    pub fn due_publish_jobs(&self, limit: i64) -> Result<Vec<DuePublishJob>> {
        let now = self.now();
        let mut statement = self.sqlite.prepare(
            r#"select "job_id", "target" from "publish_jobs" where ("publish_jobs"."status" = ? and ("publish_jobs"."publish_at" is null or "publish_jobs"."publish_at" <= ?) and ("publish_jobs"."next_attempt_at" is null or "publish_jobs"."next_attempt_at" <= ?)) order by "publish_jobs"."created_at", "publish_jobs"."job_id" limit ?"#,
        )?;
        let rows = statement.query_map(params!["queued", now, now, limit], |row| {
            Ok(DuePublishJob {
                job_id: row.get(0)?,
                target: row.get(1)?,
            })
        })?;
        Ok(rows.collect::<db::rusqlite::Result<_>>()?)
    }

    /// Claims one selected due job immediately before its target lane starts it.
    pub fn claim_publish_job(&self, job_id: i64, worker: Option<&str>) -> Result<Option<ClaimedPublishJob>> {
        let worker = worker.map_or_else(fresh_worker, str::to_owned);
        let now = self.now();
        let sqlite = self.sqlite;
        transaction(sqlite, || {
            let row = sqlite
                .query_row(
                    &format!(
                        r#"{SELECT_PUBLISH_JOB} where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ? and ("publish_jobs"."publish_at" is null or "publish_jobs"."publish_at" <= ?) and ("publish_jobs"."next_attempt_at" is null or "publish_jobs"."next_attempt_at" <= ?))"#
                    ),
                    params![job_id, "queued", now, now],
                    publish_job_row,
                )
                .optional()?;
            let Some(row) = row else { return Ok(None) };
            let payload = parse_payload(row.payload_json.as_deref());
            let resuming = has_resume_state(&payload);
            // The last gate before a delivery runs, and the only one no caller
            // can go around: a job whose target already names a post on the
            // platform, and which carries nothing saying which part of it went
            // out, cannot be delivered.
            let delivered: Option<Option<String>> = sqlite
                .query_row(
                    r#"select "external_id" from "publication_targets" where ("publication_targets"."publication_key" = ? and "publication_targets"."target" = ?)"#,
                    params![row.publication_key, row.target],
                    |found| found.get(0),
                )
                .optional()?;
            if let Some(external_id) = delivered.flatten().filter(|id| !id.is_empty())
                && !resuming
            {
                let error = format!(
                    "duplicate_refused: {} already published {external_id} and this job carries nothing to continue from",
                    row.target
                );
                sqlite.execute(
                    r#"update "publish_jobs" set "status" = ?, "next_attempt_at" = null, "locked_by" = null, "locked_at" = null, "last_error" = ?, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ?)"#,
                    params!["verification_required", error, now, job_id, "queued"],
                )?;
                upsert_post_target(
                    sqlite,
                    &row.publication_key,
                    &row.target,
                    &vec![
                        ("status", text("verification_required")),
                        ("external_id", text(external_id.as_str())),
                        ("error", text(error.as_str())),
                        ("skipped", int(0)),
                        ("updated_at", text(now.as_str())),
                        (
                            "raw_json",
                            text(crate::json::stringify(
                                &json!({ "job_id": row.job_id, "duplicate_refused": true }),
                            )),
                        ),
                    ],
                )?;
                insert_event(
                    sqlite,
                    Some(&row.publication_key),
                    Some(&row.target),
                    "publish.job.duplicate_refused",
                    "error",
                    &error,
                    &json!({ "job_id": row.job_id, "external_id": external_id }),
                    &now,
                )?;
                return Ok(None);
            }
            // An operator's "cancel the rest" binds here: the claim itself
            // refuses to start a cancelled delivery. A job carrying what it
            // already published is exempt — a severed chain is worse than one
            // more reply.
            let cancelled_guard = if resuming {
                String::new()
            } else {
                format!(" and {DELIVERY_NOT_CANCELLED}")
            };
            let mut values = vec![
                text("publishing"),
                text(worker.as_str()),
                text(now.as_str()),
                text(now.as_str()),
                int(job_id),
                text("queued"),
            ];
            if !resuming {
                values.push(text(row.publication_key.as_str()));
            }
            // `current_phase` belongs to the attempt, not to the job: a new
            // claim starts without one.
            let locked = sqlite
                .query_row(
                    &format!(
                        r#"update "publish_jobs" set "status" = ?, "locked_by" = ?, "locked_at" = ?, "current_phase" = null, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ?{cancelled_guard}) returning "job_id""#
                    ),
                    db::rusqlite::params_from_iter(values),
                    |found| found.get::<_, i64>(0),
                )
                .optional()?;
            if locked.is_none() {
                // Losing the claim to another worker leaves the job to it;
                // losing it to the cancellation is this job's ending.
                if resuming || !is_cancellation_declared(sqlite, &row.publication_key)? {
                    return Ok(None);
                }
                let stopped = sqlite
                    .query_row(
                        r#"update "publish_jobs" set "status" = ?, "next_attempt_at" = null, "locked_by" = null, "locked_at" = null, "current_phase" = null, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ?) returning "job_id""#,
                        params!["cancelled", now, job_id, "queued"],
                        |found| found.get::<_, i64>(0),
                    )
                    .optional()?;
                if stopped.is_none() {
                    return Ok(None);
                }
                let message = format!(
                    "{} was not published: the operator cancelled the rest of this publication",
                    row.target
                );
                upsert_post_target(
                    sqlite,
                    &row.publication_key,
                    &row.target,
                    &vec![
                        ("status", text("cancelled")),
                        ("error", opt_text(None::<String>)),
                        ("skipped", int(0)),
                        ("updated_at", text(now.as_str())),
                        (
                            "raw_json",
                            text(crate::json::stringify(
                                &json!({ "job_id": row.job_id, "cancelled_by_operator": true }),
                            )),
                        ),
                    ],
                )?;
                insert_event(
                    sqlite,
                    Some(&row.publication_key),
                    Some(&row.target),
                    "publish.job.cancelled",
                    "warn",
                    &message,
                    &json!({ "job_id": row.job_id }),
                    &now,
                )?;
                return Ok(None);
            }
            upsert_post_target(
                sqlite,
                &row.publication_key,
                &row.target,
                &vec![
                    ("status", text("publishing")),
                    ("error", opt_text(None::<String>)),
                    ("skipped", int(0)),
                    ("updated_at", text(now.as_str())),
                    (
                        "raw_json",
                        text(crate::json::stringify(
                            &json!({ "job_id": row.job_id, "worker": worker }),
                        )),
                    ),
                ],
            )?;
            insert_event(
                sqlite,
                Some(&row.publication_key),
                Some(&row.target),
                "publish.job.claimed",
                "info",
                &format!("Publishing {}", row.target),
                &json!({ "job_id": row.job_id, "worker": worker }),
                &now,
            )?;
            Ok(Some(ClaimedPublishJob {
                job_id: row.job_id,
                publication_key: row.publication_key,
                target: row.target,
                payload,
                attempt_count: row.attempt_count,
                lock_id: worker.clone(),
            }))
        })
    }

    /// Runs a settlement transaction and reports whether it stuck. One fenced
    /// by a lease since taken over rolls itself back: a normal outcome of a
    /// slow provider call, not an error for the worker loop.
    fn with_lease(&self, job_id: i64, settle: impl FnOnce() -> Result<()>) -> Result<bool> {
        match transaction(self.sqlite, settle) {
            Ok(()) => Ok(true),
            Err(Error::PublishLockLost(_)) => {
                log(
                    LogLevel::Warn,
                    "publish settlement discarded: lock lost",
                    Some(json!({ "jobId": job_id })),
                );
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    /// A lost worker's job: back to the queue when it never reached the
    /// provider, held for verification when it may have.
    pub fn recover_stale_publish_jobs(&self, max_lock_age_seconds: u64) -> Result<usize> {
        let cutoff = iso_at(self.now_ms() - max_lock_age_seconds as i64 * 1000);
        let now = self.now();
        let sqlite = self.sqlite;
        let stale: Vec<PublishJobRow> = sqlite
            .prepare(&format!(
                r#"{SELECT_PUBLISH_JOB} where ("publish_jobs"."status" = ? and "publish_jobs"."locked_at" < ?)"#
            ))?
            .query_map(params!["publishing", cutoff], publish_job_row)?
            .collect::<db::rusqlite::Result<_>>()?;
        transaction(sqlite, || {
            for job in &stale {
                let Some(locked_at) = &job.locked_at else { continue };
                let error = job
                    .last_error
                    .clone()
                    .filter(|error| !error.is_empty())
                    .unwrap_or_else(|| "worker_lost: publishing lock expired before completion".into());
                let ambiguous = may_have_reached_audience(job.current_phase.as_deref());
                let recovered = if ambiguous { "verification_required" } else { "queued" };
                let next_attempt_at = (!ambiguous).then_some(now.as_str());
                let updated = sqlite
                    .query_row(
                        r#"update "publish_jobs" set "status" = ?, "attempt_count" = ?, "locked_by" = null, "locked_at" = null, "next_attempt_at" = ?, "current_phase" = null, "updated_at" = ?, "last_error" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ? and "publish_jobs"."locked_at" = ?) returning "job_id""#,
                        params![
                            recovered,
                            job.attempt_count + 1,
                            next_attempt_at,
                            now,
                            error,
                            job.job_id,
                            "publishing",
                            locked_at
                        ],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                // Another worker settled this job between the read and the
                // write, so it owns the outcome — and the rows its result
                // superseded.
                if updated.is_none() {
                    continue;
                }
                delete_superseded_jobs(sqlite, &job.target, job.job_id, &job.publication_key)?;
                settle_job(
                    sqlite,
                    job.job_id,
                    None,
                    &job.publication_key,
                    &job.target,
                    &vec![
                        ("status", text(recovered)),
                        ("error", text(error.as_str())),
                        ("skipped", int(0)),
                        ("updated_at", text(now.as_str())),
                        (
                            "raw_json",
                            text(crate::json::stringify(&json!({
                                "job_id": job.job_id, "recovered_stale_lock": true, "phase": job.current_phase,
                            }))),
                        ),
                    ],
                    &now,
                    JournalEntry {
                        event_type: if ambiguous {
                            "publish.job.verification_required"
                        } else {
                            "publish.job.recovered"
                        },
                        severity: "warn",
                        message: &error,
                        details: json!({
                            "job_id": job.job_id,
                            "recovered_stale_lock": true,
                            "error_class": if ambiguous { "ambiguous" } else { "interrupted" },
                            "phase": job.current_phase,
                            "attempt": job.attempt_count + 1,
                            "next_attempt_at": next_attempt_at,
                        }),
                    },
                )?;
            }
            Ok(())
        })?;
        for job in &stale {
            refresh_publication_owner(self, &job.publication_key)?;
        }
        Ok(stale.len())
    }

    /// Settles what a delivery attempt answered. `provider_answered_at` is
    /// when this target's provider last answered anything, supplied by the
    /// caller that already reads the credential breaker.
    pub fn complete_publish_job(
        &self,
        job_id: i64,
        result: &PublishResult,
        lock_id: &str,
        provider_answered_at: Option<&str>,
    ) -> Result<()> {
        let now = self.now();
        let Some(job) = self.publish_job(job_id)? else {
            return Ok(());
        };
        if job.status != "publishing" || job.locked_by.as_deref() != Some(lock_id) {
            return Ok(());
        }
        if flag(result, "deferred")
            && let Some(Value::String(progress_key)) = result.get("progressKey")
            && result.contains_key("progressValue")
        {
            return self.settle_deferred_publication(&job, result, progress_key, &now, lock_id);
        }
        // A publication that got part of the way out comes back to finish it,
        // from the ids the adapter names on its own key.
        if flag(result, "partial")
            && let Some(Value::String(resume_key)) = result.get("resumeKey")
            && !resume_key.is_empty()
        {
            let ids: Vec<String> = match result.get("ids") {
                Some(Value::Array(ids)) => ids.iter().map(js_string).filter(|id| !id.is_empty()).collect(),
                _ => Vec::new(),
            };
            let retry =
                self.settle_partial_publication(&job, &ids, resume_key, result, &now, lock_id, provider_answered_at)?;
            if !retry {
                refresh_publication_owner(self, &job.publication_key)?;
            }
            return Ok(());
        }
        // A retryable failure that nevertheless produced an external id is not
        // a delivery to run again: something may already be live. It belongs
        // to the reconciliation sweep, which asks the provider.
        let reconciliation_ids = external_ids(result);
        if flag(result, "retryable")
            && !flag(result, "ok")
            && !flag(result, "skipped")
            && !reconciliation_ids.is_empty()
        {
            return self.settle_for_reconciliation(&job, &reconciliation_ids, result, &now, lock_id);
        }
        let normalized = normalize_publish_result(result);
        let published = normalized.status == "published";
        let sqlite = self.sqlite;
        let settled = self.with_lease(job_id, || {
            settle_job(
                sqlite,
                job_id,
                Some(FencedPatch {
                    patch: vec![
                        ("status", text(normalized.status)),
                        ("current_phase", opt_text(None::<String>)),
                        ("locked_by", opt_text(None::<String>)),
                        ("locked_at", opt_text(None::<String>)),
                        ("last_error", opt_text(normalized.error.clone())),
                        ("updated_at", text(now.as_str())),
                    ],
                    fence: lock_id,
                }),
                &job.publication_key,
                &job.target,
                &vec![
                    ("status", text(normalized.status)),
                    (
                        "external_id",
                        opt_text(normalized.external_id.clone().filter(|_| published)),
                    ),
                    (
                        "external_ids_json",
                        match (&normalized.external_ids, published) {
                            (Some(ids), true) => strings_json(ids),
                            _ => opt_text(None::<String>),
                        },
                    ),
                    ("url", opt_text(normalized.url.clone().filter(|_| published))),
                    ("error", opt_text(normalized.error.clone())),
                    ("skipped", int(normalized.skipped)),
                    // The per-target delivery time, which analytics scopes by.
                    ("published_at", opt_text(published.then_some(now.as_str()))),
                    (
                        "confirmation_source",
                        opt_text(published.then(|| publication_confirmation_source(result))),
                    ),
                    (
                        "verified_at",
                        opt_text(
                            (published && verification_status(result) == Some("verified")).then_some(now.as_str()),
                        ),
                    ),
                    ("updated_at", text(now.as_str())),
                    ("raw_json", text(normalized.raw_json.as_str())),
                ],
                &now,
                JournalEntry {
                    event_type: &format!("publish.job.{}", normalized.status),
                    severity: if normalized.status == "failed" { "error" } else { "info" },
                    message: &format!("{} {}", job.target, normalized.status),
                    details: json!({
                        "job_id": job_id,
                        "attempt": job.attempt_count,
                        "phase": "delivery.total",
                        "duration_ms": duration_since(job.locked_at.as_deref(), &now),
                        "result": result,
                    }),
                },
            )?;
            delete_superseded_jobs(sqlite, &job.target, job_id, &job.publication_key)
        })?;
        if !settled {
            return Ok(());
        }
        let circuit = self.boundaries.auth_circuit;
        if published {
            circuit.record_success(sqlite, &job.target)?;
        } else if normalized.status == "failed"
            && classify_message(normalized.error.as_deref()) == PublishErrorClass::Auth
        {
            circuit.record_failure(sqlite, &job.target)?;
        }
        refresh_publication_owner(self, &job.publication_key)
    }

    /// Persists an adapter's pre-publication state without spending a retry.
    fn settle_deferred_publication(
        &self,
        job: &PublishJobRow,
        result: &PublishResult,
        progress_key: &str,
        now: &str,
        lock_id: &str,
    ) -> Result<()> {
        let delay_ms = js_number(result.get("retryAfterMs"))
            .filter(|ms| *ms != 0.0)
            .unwrap_or(0.0);
        let delay_ms = delay_ms.clamp(0.0, 60_000.0) as u64;
        let next_attempt_at = iso_at(parse_ms(now).expect("the clock writes ISO instants") + delay_ms as i64);
        let published = match (result.get("resumeKey"), result.get("resumeValue")) {
            (Some(Value::String(key)), Some(value)) => Some((key.as_str(), value.clone())),
            _ => None,
        };
        let payload: DeliveryPayload = deferred_delivery_payload(
            &parse_payload(job.payload_json.as_deref()),
            progress_key,
            result.get("progressValue").cloned().unwrap_or(Value::Null),
            published,
        )?;
        let state = result.get("state").and_then(Value::as_str).unwrap_or("processing");
        let sqlite = self.sqlite;
        let settled = self.with_lease(job.job_id, || {
            settle_job(
                sqlite,
                job.job_id,
                Some(FencedPatch {
                    patch: vec![
                        ("status", text("queued")),
                        ("current_phase", opt_text(None::<String>)),
                        ("next_attempt_at", text(next_attempt_at.as_str())),
                        ("locked_by", opt_text(None::<String>)),
                        ("locked_at", opt_text(None::<String>)),
                        ("payload_json", json_text(&Value::Object(payload.fields().clone()))),
                        ("last_error", opt_text(None::<String>)),
                        ("updated_at", text(now)),
                    ],
                    fence: lock_id,
                }),
                &job.publication_key,
                &job.target,
                &vec![
                    ("status", text("queued")),
                    ("error", opt_text(None::<String>)),
                    ("skipped", int(0)),
                    ("updated_at", text(now)),
                    ("raw_json", text(crate::json::stringify_object(result))),
                ],
                now,
                JournalEntry {
                    event_type: "publish.job.deferred",
                    severity: "info",
                    message: &format!("{} {state}", job.target),
                    details: json!({ "job_id": job.job_id, "state": state, "next_attempt_at": next_attempt_at }),
                },
            )
        })?;
        if settled {
            self.boundaries.bell.ring_publish_after(delay_ms);
        }
        Ok(())
    }

    /// Hands an ambiguous outcome to the reconciliation sweep: the ids go on
    /// the target so the sweep has something to ask about, and the job stops
    /// being a delivery. Nothing here re-enters the publish queue.
    fn settle_for_reconciliation(
        &self,
        job: &PublishJobRow,
        ids: &[String],
        result: &PublishResult,
        now: &str,
        lock_id: &str,
    ) -> Result<()> {
        let error = present(result, "error")
            .map_or_else(|| "external publication requires reconciliation".to_owned(), js_string);
        let sqlite = self.sqlite;
        let settled = self.with_lease(job.job_id, || {
            delete_superseded_jobs(sqlite, &job.target, job.job_id, &job.publication_key)?;
            settle_job(
                sqlite,
                job.job_id,
                Some(FencedPatch {
                    patch: vec![
                        ("status", text("verification_required")),
                        ("current_phase", opt_text(None::<String>)),
                        ("next_attempt_at", opt_text(None::<String>)),
                        ("locked_by", opt_text(None::<String>)),
                        ("locked_at", opt_text(None::<String>)),
                        ("last_error", text(error.as_str())),
                        ("updated_at", text(now)),
                    ],
                    fence: lock_id,
                }),
                &job.publication_key,
                &job.target,
                &vec![
                    ("status", text("verification_required")),
                    ("external_id", opt_text(ids.first().cloned())),
                    ("external_ids_json", strings_json(ids)),
                    ("error", text(error.as_str())),
                    ("skipped", int(0)),
                    ("updated_at", text(now)),
                    ("raw_json", text(crate::json::stringify_object(result))),
                ],
                now,
                JournalEntry {
                    event_type: "publish.job.verification_required",
                    severity: "warn",
                    message: &error,
                    details: json!({
                        "job_id": job.job_id, "ids": ids, "attempt": job.attempt_count, "error_class": "ambiguous",
                    }),
                },
            )
        })?;
        if settled {
            refresh_publication_owner(self, &job.publication_key)?;
        }
        Ok(())
    }

    /// Puts a half-finished publication back in the queue carrying what it
    /// already published, and reports whether it is going to run again.
    #[allow(clippy::too_many_arguments)]
    fn settle_partial_publication(
        &self,
        job: &PublishJobRow,
        ids: &[String],
        payload_key: &str,
        result: &PublishResult,
        now: &str,
        lock_id: &str,
        provider_answered_at: Option<&str>,
    ) -> Result<bool> {
        let transition = partial_publication_transition(
            job.attempt_count as u32,
            partial_retry_policy(),
            self.now_ms(),
            self.boundaries.jitter,
        );
        // The long budget is patience for a platform that is down, not for one
        // that is up and refusing this one call: anything the platform
        // answered since the last attempt says the outage theory is wrong.
        let answered_since = match self.published_on_target_since(&job.target, Some(&job.updated_at))? {
            Some(at) => Some(at),
            None => answered_since(provider_answered_at, Some(&job.updated_at)),
        };
        let attempt = transition.attempt;
        let retry = transition.status == "queued" && answered_since.is_none();
        let status = if retry { "queued" } else { "failed" };
        let next_attempt_at = if retry {
            transition.next_attempt_at.clone()
        } else {
            None
        };
        let base = present(result, "error").map_or_else(|| format!("{} partial publication", job.target), js_string);
        let error = match &answered_since {
            Some(at) => format!(
                "{base} (stopped early: {} published something else at {at}, so this is not the platform being down)",
                job.target
            ),
            None => base,
        };
        let ids_value = Value::Array(ids.iter().cloned().map(Value::String).collect());
        let payload = resumed_delivery_payload(&parse_payload(job.payload_json.as_deref()), payload_key, ids_value);
        let mut details =
            json!({ "job_id": job.job_id, "ids": ids, "attempt": attempt, "next_attempt_at": next_attempt_at });
        if let Some(at) = &answered_since {
            details["stopped_early"] = json!(at);
        }
        let sqlite = self.sqlite;
        let settled = self.with_lease(job.job_id, || {
            // A queued row is unique per (publication_key, target): clear any
            // competing one before this job re-enters the queue.
            delete_superseded_jobs(sqlite, &job.target, job.job_id, &job.publication_key)?;
            settle_job(
                sqlite,
                job.job_id,
                Some(FencedPatch {
                    patch: vec![
                        ("status", text(status)),
                        ("current_phase", opt_text(None::<String>)),
                        ("attempt_count", int(i64::from(attempt))),
                        ("next_attempt_at", opt_text(next_attempt_at.clone())),
                        ("locked_by", opt_text(None::<String>)),
                        ("locked_at", opt_text(None::<String>)),
                        ("payload_json", json_text(&Value::Object(payload.fields().clone()))),
                        ("last_error", text(error.as_str())),
                        ("updated_at", text(now)),
                    ],
                    fence: lock_id,
                }),
                &job.publication_key,
                &job.target,
                &vec![
                    ("status", text(status)),
                    ("external_id", opt_text(ids.first().cloned())),
                    ("external_ids_json", strings_json(ids)),
                    ("error", text(error.as_str())),
                    ("skipped", int(0)),
                    ("updated_at", text(now)),
                    ("raw_json", text(crate::json::stringify_object(result))),
                ],
                now,
                JournalEntry {
                    event_type: if retry {
                        "publish.job.partial"
                    } else {
                        "publish.job.failed"
                    },
                    // The first one is news and the last one is the outcome;
                    // the ones in between are a delivery doing what it said.
                    severity: match (retry, attempt <= 1) {
                        (true, true) => "warn",
                        (true, false) => "info",
                        (false, _) => "error",
                    },
                    message: &error,
                    details: details.clone(),
                },
            )
        })?;
        if !settled {
            return Ok(false);
        }
        if !retry && classify_message(Some(&error)) == PublishErrorClass::Auth {
            self.boundaries.auth_circuit.record_failure(sqlite, &job.target)?;
        }
        Ok(retry)
    }

    /// When this target last put something in front of an audience after the
    /// given moment: evidence about the platform, not about this publication.
    fn published_on_target_since(&self, target: &str, since: Option<&str>) -> Result<Option<String>> {
        let Some(since) = since else { return Ok(None) };
        Ok(self
            .sqlite
            .query_row(
                r#"select "published_at" from "publication_targets" where ("publication_targets"."target" = ? and "publication_targets"."status" = ? and "publication_targets"."published_at" > ?) order by "publication_targets"."published_at" desc"#,
                params![target, "published", since],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    pub fn fail_publish_job(&self, job_id: i64, error: &PublishFailure, lock_id: &str) -> Result<()> {
        let now = self.now();
        let Some(job) = self.publish_job(job_id)? else {
            return Ok(());
        };
        if job.status != "publishing" || job.locked_by.as_deref() != Some(lock_id) {
            return Ok(());
        }
        let transition = failed_job_transition(
            error,
            job.attempt_count as u32,
            publish_retry_policy(),
            self.now_ms(),
            self.boundaries.jitter,
        );
        let should_retry = transition.status == "queued";
        let error_text = error.message.as_str();
        let error_class = transition.error_class.as_str();
        let sqlite = self.sqlite;
        let settled = self.with_lease(job_id, || {
            delete_superseded_jobs(sqlite, &job.target, job_id, &job.publication_key)?;
            settle_job(
                sqlite,
                job_id,
                Some(FencedPatch {
                    patch: vec![
                        ("status", text(transition.status)),
                        ("current_phase", opt_text(None::<String>)),
                        ("attempt_count", int(i64::from(transition.attempt))),
                        ("next_attempt_at", opt_text(transition.next_attempt_at.clone())),
                        ("locked_by", opt_text(None::<String>)),
                        ("locked_at", opt_text(None::<String>)),
                        ("last_error", text(error_text)),
                        ("updated_at", text(now.as_str())),
                    ],
                    fence: lock_id,
                }),
                &job.publication_key,
                &job.target,
                &vec![
                    ("status", text(transition.status)),
                    ("error", text(error_text)),
                    ("skipped", int(0)),
                    ("updated_at", text(now.as_str())),
                    (
                        "raw_json",
                        text(crate::json::stringify(&json!({
                            "job_id": job_id, "error_class": error_class, "attempt": transition.attempt,
                            "next_attempt_at": transition.next_attempt_at,
                        }))),
                    ),
                ],
                &now,
                JournalEntry {
                    event_type: if should_retry {
                        "publish.job.retry"
                    } else {
                        "publish.job.failed"
                    },
                    severity: if should_retry { "warn" } else { "error" },
                    message: error_text,
                    details: json!({
                        "job_id": job_id,
                        "error_class": error_class,
                        "attempt": transition.attempt,
                        "next_attempt_at": transition.next_attempt_at,
                        "phase": "delivery.total",
                        "duration_ms": duration_since(job.locked_at.as_deref(), &now),
                    }),
                },
            )
        })?;
        if !settled {
            return Ok(());
        }
        if classify_publish_error(error) == PublishErrorClass::Auth {
            self.boundaries.auth_circuit.record_failure(sqlite, &job.target)?;
        }
        if !should_retry {
            refresh_publication_owner(self, &job.publication_key)?;
        }
        Ok(())
    }

    pub fn require_publish_verification(&self, job_id: i64, error: &str, lock_id: &str) -> Result<bool> {
        let now = self.now();
        let Some(job) = self.publish_job(job_id)? else {
            return Ok(false);
        };
        if job.status != "publishing" || job.locked_by.as_deref() != Some(lock_id) {
            return Ok(false);
        }
        let sqlite = self.sqlite;
        let updated = self.with_lease(job_id, || {
            delete_superseded_jobs(sqlite, &job.target, job_id, &job.publication_key)?;
            settle_job(
                sqlite,
                job_id,
                Some(FencedPatch {
                    patch: vec![
                        ("status", text("verification_required")),
                        ("attempt_count", int(job.attempt_count + 1)),
                        ("next_attempt_at", opt_text(None::<String>)),
                        ("current_phase", opt_text(None::<String>)),
                        ("locked_by", opt_text(None::<String>)),
                        ("locked_at", opt_text(None::<String>)),
                        ("last_error", text(error)),
                        ("updated_at", text(now.as_str())),
                    ],
                    fence: lock_id,
                }),
                &job.publication_key,
                &job.target,
                &vec![
                    ("status", text("verification_required")),
                    ("error", text(error)),
                    ("skipped", int(0)),
                    ("updated_at", text(now.as_str())),
                ],
                &now,
                JournalEntry {
                    event_type: "publish.job.verification_required",
                    severity: "warn",
                    message: error,
                    details: json!({
                        "job_id": job_id,
                        "attempt": job.attempt_count + 1,
                        "phase": "provider.publish",
                        "duration_ms": duration_since(job.locked_at.as_deref(), &now),
                    }),
                },
            )
        })?;
        if updated {
            refresh_publication_owner(self, &job.publication_key)?;
        }
        Ok(updated)
    }

    /// Last-resort settlement for an ambiguous worker failure. It avoids the
    /// journal because this path runs when normal settlement itself failed;
    /// verification is safer than retrying an audience mutation.
    pub fn force_publish_job_verification(
        &self,
        job_id: i64,
        error: &str,
        lock_id: &str,
        result: Option<&PublishResult>,
    ) -> Result<bool> {
        let now = self.now();
        let Some(job) = self.publish_job(job_id)? else {
            return Ok(false);
        };
        if job.status != "publishing" || job.locked_by.as_deref() != Some(lock_id) {
            return Ok(false);
        }
        let evidence = result.map(normalize_publish_result);
        let sqlite = self.sqlite;
        let updated = transaction(sqlite, || {
            let row = sqlite
                .query_row(
                    r#"update "publish_jobs" set "status" = ?, "attempt_count" = ?, "next_attempt_at" = null, "current_phase" = null, "locked_by" = null, "locked_at" = null, "last_error" = ?, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ? and "publish_jobs"."locked_by" = ?) returning "job_id""#,
                    params![
                        "verification_required",
                        job.attempt_count + 1,
                        error,
                        now,
                        job_id,
                        "publishing",
                        lock_id
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if row.is_none() {
                return Ok(false);
            }
            let mut patch: Columns = vec![
                ("status", text("verification_required")),
                ("error", text(error)),
                ("skipped", int(0)),
                ("updated_at", text(now.as_str())),
                (
                    "raw_json",
                    text(crate::json::stringify(&json!({ "job_id": job_id, "emergency": true }))),
                ),
            ];
            if let Some(evidence) = &evidence {
                patch.push(("external_id", opt_text(evidence.external_id.clone())));
                patch.push((
                    "external_ids_json",
                    evidence
                        .external_ids
                        .as_ref()
                        .map_or_else(|| opt_text(None::<String>), |ids| strings_json(ids)),
                ));
                patch.push(("url", opt_text(evidence.url.clone())));
            }
            upsert_post_target(sqlite, &job.publication_key, &job.target, &patch)?;
            Ok(true)
        })?;
        if updated {
            refresh_publication_owner(self, &job.publication_key)?;
        }
        Ok(updated)
    }
}

/// `Number(value) || 0` before the clamp: `None` for NaN.
fn js_number(value: Option<&Value>) -> Option<f64> {
    let number = match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => foundation::js::number(text),
        Some(Value::Array(items)) if items.is_empty() => 0.0,
        Some(Value::Array(items)) if items.len() == 1 => js_number(items.first()).unwrap_or(f64::NAN),
        Some(_) => f64::NAN,
    };
    (!number.is_nan()).then_some(number)
}

/// The provider's last answer, but only when it lands after this job's last
/// attempt: an older one says nothing about whether the platform is up now.
fn answered_since(answered_at: Option<&str>, since: Option<&str>) -> Option<String> {
    let (answered_at, since) = (
        answered_at.filter(|at| !at.is_empty())?,
        since.filter(|at| !at.is_empty())?,
    );
    (parse_ms(answered_at)? > parse_ms(since)?).then(|| answered_at.to_owned())
}

/// A new publish job, or a refresh of the queued one for the same target:
/// adopting the existing row keeps the whole publication transaction alive.
pub struct EnqueuePublishJob<'a> {
    pub publication_key: &'a str,
    pub target: &'a str,
    /// Only a [`DeliveryPayload`]: its author has said what the delivery has
    /// already published.
    pub payload: &'a DeliveryPayload,
    pub publish_at: Option<&'a str>,
}

pub fn enqueue_publish_job_tx(publishing: &Publishing<'_>, input: &EnqueuePublishJob<'_>) -> Result<i64> {
    let now = publishing.now();
    let payload = crate::json::stringify_object(input.payload.fields());
    let job_id = publishing.sqlite.query_row(
        r#"insert into "publish_jobs" ("publication_key", "target", "status", "publish_at", "payload_json", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?, ?) on conflict ("publish_jobs"."publication_key", "publish_jobs"."target", "publish_jobs"."status") do update set "publish_at" = ?, "payload_json" = ?, "updated_at" = ? returning "job_id""#,
        params![
            input.publication_key,
            input.target,
            "queued",
            input.publish_at,
            payload,
            now,
            now,
            input.publish_at,
            payload,
            now
        ],
        |row| row.get::<_, i64>(0),
    )?;
    // One funnel, so no enqueue path can forget to ring.
    publishing.boundaries.bell.ring_publish();
    Ok(job_id)
}
