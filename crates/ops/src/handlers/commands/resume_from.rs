//! `operations/resume-from.ts`: a half-published target told which post it
//! is continuing, so the ordinary retry finishes the publication onto it.

use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{OptionalExtension, params};
use domain::application::ports::{DomainEventInput, Severity};
use domain::publishing::delivery_payload::{resume_state, resumed_delivery_payload};
use domain::publishing::publication_owner::refresh_publication_owner;
use domain::publishing::queue_state::{parse_payload, upsert_post_target};
use domain::repositories::{record_event, transaction};
use serde_json::{Value, json};

use super::super::publication_ref::ResolvedPublicationRef;
use super::{CommandHandle, latest_job, object, refusal};
use crate::context::OpResult;

pub(crate) struct ResumeFromInput<'i> {
    pub reference: ResolvedPublicationRef,
    pub target: &'i str,
    /// The post the rest of the publication should be attached to.
    pub external_id: &'i str,
    pub apply: bool,
    pub actor_type: &'i str,
}

/// `resumeTargetFrom`. Aimed only at a target that already carries resume
/// state: a platform that publishes in one call has no chain to continue.
pub(crate) fn resume_target_from(handle: &CommandHandle<'_>, input: &ResumeFromInput<'_>) -> OpResult {
    let sqlite = handle.publishing.sqlite;
    let key = &input.reference.publication_key;
    let Some(job) = latest_job(sqlite, key, input.target)? else {
        return Err(refusal(format!("{} has no publish job on {key}", input.target)).into());
    };
    let payload = parse_payload(job.payload_json.as_deref());
    let resume = resume_state(&payload);
    let Some((resume_key, was)) = domain::json::object_entries(&resume).next() else {
        return Err(refusal(format!(
            "{} carries nothing it has already published; there is no unfinished publication to continue",
            input.target
        ))
        .into());
    };
    let (resume_key, was) = (resume_key.clone(), was.clone());
    if job.status == "publishing" {
        return Err(refusal(format!(
            "{} is being delivered right now; read its state again",
            input.target
        ))
        .into());
    }
    let mut plan = object(json!({
        "ok": true,
        "action": "resume-from",
        "publication_key": key,
        "target": input.target,
        "job_id": job.job_id,
        "resume_key": resume_key,
        "was": was,
        "now": [input.external_id],
    }));
    if !input.apply {
        plan.insert("applied".into(), json!(false));
        plan.insert(
            "hint".into(),
            json!("re-run with apply to point it at this post and finish the publication"),
        );
        return Ok(Value::Object(plan));
    }

    let now = handle.now();
    let settled = transaction(sqlite, || {
        // Fenced on the status this decision was read from: a worker that
        // claimed the job in between owns the delivery.
        let next = resumed_delivery_payload(&payload, &resume_key, json!([input.external_id]));
        let won: Option<i64> = sqlite
            .query_row(
                r#"update "publish_jobs" set "status" = ?, "attempt_count" = ?, "publish_at" = ?, "next_attempt_at" = null, "locked_by" = null, "locked_at" = null, "payload_json" = ?, "last_error" = null, "current_phase" = null, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ?) returning "job_id""#,
                params![
                    "queued",
                    0,
                    now,
                    domain::json::stringify_object(next.fields()),
                    now,
                    job.job_id,
                    job.status
                ],
                |row| row.get(0),
            )
            .optional()?;
        if won.is_none() {
            return Ok(false);
        }
        upsert_post_target(
            sqlite,
            key,
            input.target,
            &vec![
                ("status", SqlValue::Text("queued".into())),
                ("external_id", SqlValue::Text(input.external_id.into())),
                (
                    "external_ids_json",
                    SqlValue::Text(domain::json::stringify(&json!([input.external_id]))),
                ),
                ("error", SqlValue::Null),
                ("updated_at", SqlValue::Text(now.clone())),
            ],
        )?;
        let mut details = serde_json::Map::new();
        details.insert("job_id".into(), json!(job.job_id));
        details.insert("resume_key".into(), json!(resume_key));
        details.insert("was".into(), was.clone());
        details.insert("now".into(), json!([input.external_id]));
        details.insert("actor_type".into(), json!(input.actor_type));
        record_event(
            sqlite,
            handle.publishing.clock,
            &DomainEventInput {
                publication_ref: Some(key.clone()),
                event_type: "publish.target.resumed_from".into(),
                severity: Severity::Warn,
                target: Some(input.target.to_owned()),
                message: format!(
                    "{} will finish its publication onto {}",
                    input.target, input.external_id
                ),
                details: Some(details),
                cooldown_seconds: None,
            },
        )?;
        Ok(true)
    })?;
    if !settled {
        return Err(refusal(format!(
            "{} left {} before this could point it at a post; read its state again",
            input.target, job.status
        ))
        .into());
    }
    refresh_publication_owner(&handle.publishing, &job.publication_key)?;
    plan.insert("applied".into(), json!(true));
    Ok(Value::Object(plan))
}
