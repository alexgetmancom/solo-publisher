//! The publication timeline: jobs, targets and the
//! event log of one publication, in order. `media-job` reads its media
//! events out of it.

use db::rusqlite::{Connection, OptionalExtension, Row};
use domain::application::publication_ref::{PublicationRefKind, parse_publication_ref};
use foundation::time::parse_iso_ms;
use serde_json::{Map, Value, json};

use super::rows;
use crate::context::OpError;

fn cell(row: &Row<'_>, index: usize) -> db::rusqlite::Result<Value> {
    Ok(rows::cell(row.get_ref(index)?))
}

/// Every row of `sql` as an object with `names`, in order.
fn records(
    sqlite: &Connection,
    sql: &str,
    param: &dyn db::rusqlite::ToSql,
    names: &[&str],
) -> Result<Vec<Map<String, Value>>, OpError> {
    let mut statement = sqlite.prepare(sql)?;
    let rows = statement.query_map([param], |row| {
        let mut record = Map::new();
        for (index, name) in names.iter().enumerate() {
            record.insert((*name).to_owned(), cell(row, index)?);
        }
        Ok(record)
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// `jsonObject`.
pub(crate) fn json_object(value: &Value) -> Map<String, Value> {
    let parsed = match value {
        Value::String(text) if text.is_empty() => Value::Null,
        Value::String(text) => serde_json::from_str(text).unwrap_or(Value::Null),
        other => other.clone(),
    };
    match parsed {
        Value::Object(object) => object,
        _ => Map::new(),
    }
}

/// `elapsed(start, end)`: milliseconds, or null when either end is missing.
fn elapsed(start: &Value, end: &Value) -> Value {
    let present = |value: &Value| value.as_str().is_some_and(|text| !text.is_empty());
    if !present(start) || !present(end) {
        return Value::Null;
    }
    match (
        start.as_str().and_then(parse_iso_ms),
        end.as_str().and_then(parse_iso_ms),
    ) {
        (Some(start), Some(end)) if end >= start => json!(end - start),
        _ => Value::Null,
    }
}

fn with_duration(mut job: Map<String, Value>) -> Value {
    let start = match job.get("lockedAt") {
        Some(Value::Null) | None => job.get("createdAt").cloned().unwrap_or(Value::Null),
        Some(locked) => locked.clone(),
    };
    let duration = elapsed(&start, job.get("updatedAt").unwrap_or(&Value::Null));
    job.insert("durationMs".into(), duration);
    Value::Object(job)
}

/// `publicationTimeline`.
pub(crate) fn publication_timeline(sqlite: &Connection, reference: &str) -> Result<Value, OpError> {
    match parse_publication_ref(Some(reference)) {
        // Video publications carry their own ref, and it is the ref their
        // events are journalled under.
        Some(parsed) if parsed.kind == PublicationRefKind::Video => video_timeline(sqlite, reference, parsed.id),
        Some(parsed) if parsed.kind == PublicationRefKind::Post => post_timeline(sqlite, reference),
        _ => Err(OpError::failed("--ref must look like post:106 or video:12")),
    }
}

fn post_timeline(sqlite: &Connection, reference: &str) -> Result<Value, OpError> {
    let events = timeline_events(sqlite, reference)?;
    let jobs: Vec<Value> = records(
        sqlite,
        r#"select "job_id", "target", "status", "attempt_count", "publish_at", "created_at", "locked_at", "updated_at", "last_error" from "publish_jobs" where "publish_jobs"."publication_key" = ? order by "publish_jobs"."created_at" asc, "publish_jobs"."job_id" asc"#,
        &reference,
        &[
            "jobId",
            "target",
            "status",
            "attemptCount",
            "publishAt",
            "createdAt",
            "lockedAt",
            "updatedAt",
            "lastError",
        ],
    )?
    .into_iter()
    .map(with_duration)
    .collect();
    let targets = records(
        sqlite,
        r#"select "target", "status", "url", "error", "published_at", "updated_at" from "publication_targets" where "publication_targets"."publication_key" = ? order by "publication_targets"."target""#,
        &reference,
        &["target", "status", "url", "error", "publishedAt", "updatedAt"],
    )?;
    Ok(json!({"ref": reference, "jobs": jobs, "targets": targets, "events": events}))
}

fn video_timeline(sqlite: &Connection, reference: &str, video_draft_id: i64) -> Result<Value, OpError> {
    let draft = sqlite
        .query_row(
            r#"select "locale", "label", "status", "scheduled_at", "created_at" from "video_drafts" where "video_drafts"."id" = ?"#,
            [video_draft_id],
            |row| {
                Ok(json!({
                    "locale": cell(row, 0)?,
                    "label": cell(row, 1)?,
                    "status": cell(row, 2)?,
                    "scheduledAt": cell(row, 3)?,
                    "createdAt": cell(row, 4)?,
                }))
            },
        )
        .optional()?;
    let mut targets = records(
        sqlite,
        r#"select "video_targets"."id", "video_targets"."target", "video_targets"."status", "video_targets"."metadata_json", "video_targets"."delivery_provider", "video_targets"."provider_post_id", "video_targets"."confirmation_source", "video_targets"."external_id", "video_targets"."external_url", "video_targets"."last_error", "video_targets"."published_at", "video_targets"."verified_at", "video_targets"."updated_at", "video_metric_schedule"."frozen_at", "video_metric_schedule"."checkpoint_index", "video_metric_schedule"."last_checked_at", "video_metric_schedule"."last_error" from "video_targets" left join "video_metric_schedule" on "video_metric_schedule"."video_target_id" = "video_targets"."id" where "video_targets"."video_draft_id" = ? order by "video_targets"."target""#,
        &video_draft_id,
        &[
            "id",
            "target",
            "status",
            "metadata",
            "deliveryProvider",
            "providerPostId",
            "confirmationSource",
            "externalId",
            "url",
            "error",
            "publishedAt",
            "verifiedAt",
            "updatedAt",
            "metricsFrozenAt",
            "metricsCheckpointIndex",
            "metricsLastCheckedAt",
            "metricsLastError",
        ],
    )?;
    for target in &mut targets {
        let metadata = rows::json_column(target["metadata"].as_str())?;
        target.insert("metadata".into(), metadata);
    }
    let jobs: Vec<Value> = records(
        sqlite,
        r#"select "id", "video_target_id", "kind", "status", "attempt_count", "run_at", "created_at", "locked_at", "updated_at", "last_error" from "video_jobs" where "video_jobs"."video_draft_id" = ? order by "video_jobs"."created_at" asc, "video_jobs"."id" asc"#,
        &video_draft_id,
        &[
            "jobId",
            "videoTargetId",
            "kind",
            "status",
            "attemptCount",
            "runAt",
            "createdAt",
            "lockedAt",
            "updatedAt",
            "lastError",
        ],
    )?
    .into_iter()
    .map(with_duration)
    .collect();
    Ok(json!({
        "ref": reference,
        "draft": draft,
        "jobs": jobs,
        "targets": targets,
        "events": timeline_events(sqlite, reference)?,
    }))
}

fn timeline_events(sqlite: &Connection, reference: &str) -> Result<Vec<Value>, OpError> {
    Ok(records(
        sqlite,
        r#"select "created_at", "severity", "event_type", "target", "message", "details_json" from "publication_events" where "publication_events"."publication_key" = ? order by "publication_events"."created_at" asc, "publication_events"."id" asc"#,
        &reference,
        &["at", "severity", "type", "target", "message", "details"],
    )?
    .into_iter()
    .map(|mut event| {
        let details = json_object(&event["details"]);
        event.insert("details".into(), Value::Object(details));
        Value::Object(event)
    })
    .collect())
}
