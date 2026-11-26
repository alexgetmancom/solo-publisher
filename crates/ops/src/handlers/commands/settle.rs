//! A target reconciliation cannot settle by itself,
//! answered with what the operator saw on the platform.

use db::rusqlite::{OptionalExtension, params};
use domain::application::ports::{DomainEventInput, Severity};
use domain::publishing::publication_owner::refresh_publication_owner;
use domain::repositories::{record_event, transaction};
use serde_json::{Value, json};

use super::super::publication_ref::ResolvedPublicationRef;
use super::{CommandHandle, latest_job, object, refusal};
use crate::context::OpResult;

pub(crate) struct SettleInput<'i> {
    pub reference: ResolvedPublicationRef,
    pub target: &'i str,
    /// The id the operator read off the platform, or nothing if it is not there.
    pub external_id: Option<&'i str>,
    pub url: Option<&'i str>,
    pub apply: bool,
    pub actor_type: &'i str,
}

/// `settleAmbiguousTarget`. Naming the id is evidence the post is live;
/// reporting it absent puts the job back in the queue, which is a
/// publication, so it is gated behind `apply` like every other.
pub(crate) fn settle_ambiguous_target(handle: &CommandHandle<'_>, input: &SettleInput<'_>) -> OpResult {
    let sqlite = handle.publishing.sqlite;
    let key = &input.reference.publication_key;
    let Some(job) = latest_job(sqlite, key, input.target)? else {
        return Err(refusal(format!("{} has no publish job on {key}", input.target)).into());
    };
    if job.status != "verification_required" {
        return Err(refusal(format!(
            "{} is {}, not verification_required; settle only answers an ambiguous target",
            input.target, job.status
        ))
        .into());
    }
    let found = input.external_id.is_some();
    let mut plan = object(json!({
        "ok": true,
        "action": "settle",
        "publication_key": key,
        "target": input.target,
        "job_id": job.job_id,
        "outcome": if found { "published" } else { "requeued" },
    }));
    if let Some(external_id) = input.external_id {
        plan.insert("external_id".into(), json!(external_id));
    }
    if !input.apply {
        plan.insert("applied".into(), json!(false));
        plan.insert("hint".into(), json!("re-run with apply to record it"));
        return Ok(Value::Object(plan));
    }

    let now = handle.now();
    let settled = transaction(sqlite, || {
        // Fenced on the state this decision was made from: reconciliation may
        // have resolved the target between the operator looking and answering.
        let won: Option<i64> = sqlite
            .query_row(
                r#"update "publish_jobs" set "status" = ?, "attempt_count" = ?, "next_attempt_at" = null, "locked_by" = null, "locked_at" = null, "current_phase" = null, "last_error" = null, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ?) returning "job_id""#,
                params![
                    if found { "published" } else { "queued" },
                    0,
                    now,
                    job.job_id,
                    "verification_required"
                ],
                |row| row.get(0),
            )
            .optional()?;
        if won.is_none() {
            return Ok(false);
        }
        let ids = input
            .external_id
            .filter(|id| !id.is_empty())
            .map(|id| domain::json::stringify(&json!([id])));
        sqlite.execute(
            r#"update "publication_targets" set "status" = ?, "external_id" = ?, "external_ids_json" = ?, "url" = ?, "error" = null, "published_at" = ?, "confirmation_source" = ?, "verified_at" = null, "updated_at" = ? where ("publication_targets"."publication_key" = ? and "publication_targets"."target" = ?)"#,
            params![
                if found { "published" } else { "queued" },
                input.external_id,
                ids,
                input.url,
                found.then_some(now.as_str()),
                found.then_some("operator"),
                now,
                key,
                input.target
            ],
        )?;
        let mut details = serde_json::Map::new();
        details.insert("job_id".into(), json!(job.job_id));
        details.insert("external_id".into(), json!(input.external_id));
        details.insert("actor_type".into(), json!(input.actor_type));
        record_event(
            sqlite,
            handle.publishing.clock,
            &DomainEventInput {
                publication_ref: Some(key.clone()),
                event_type: if found {
                    "publish.job.settled_published"
                } else {
                    "publish.job.settled_absent"
                }
                .into(),
                severity: Severity::Info,
                target: Some(input.target.to_owned()),
                message: if found {
                    format!("{} was confirmed live by the operator", input.target)
                } else {
                    format!("{} was reported absent and requeued", input.target)
                },
                details: Some(details),
                cooldown_seconds: None,
            },
        )?;
        Ok(true)
    })?;
    if !settled {
        return Err(refusal(format!(
            "{} left verification_required before this could settle it; read its state again",
            input.target
        ))
        .into());
    }
    refresh_publication_owner(&handle.publishing, &job.publication_key)?;
    plan.insert("applied".into(), json!(true));
    Ok(Value::Object(plan))
}
