//! The audit, the backup and restore of the
//! database file, and the publication consistency report with its repair.
//! (The retention sweep is `delivery::maintenance`.)

use std::path::{Path, PathBuf};

use db::BackendDb;
use db::rusqlite::{Connection, params};
use domain::application::publication_ref::{PublicationRefKind, parse_publication_ref, publication_ref};
use domain::channels::registered_post_target_ids;
use domain::observability::dates::date_integrity;
use domain::publishing::Publishing;
use domain::publishing::state::effective_publication_status;
use foundation::time::to_iso_string;
use jiff::{SignedDuration, Timestamp};
use serde_json::{Map, Value, json};

use crate::context::{OpError, to_value};
use crate::handlers::rows::{self, Row};

/// How far back `audit` counts journal events.
const AUDIT_EVENT_WINDOW_DAYS: i64 = 30;

/// `backupDatabase`: a consistent copy named after the source and the moment.
pub(super) fn backup_database(
    backend_db: &BackendDb,
    source_path: &Path,
    destination_directory: Option<&str>,
    now: Timestamp,
) -> Result<String, OpError> {
    if source_path.as_os_str() == ":memory:" {
        return Err(OpError::failed("cannot back up an in-memory database"));
    }
    let directory = match destination_directory {
        Some(directory) => PathBuf::from(directory),
        None => source_path.parent().unwrap_or(Path::new("")).join("backups"),
    };
    std::fs::create_dir_all(&directory)?;
    let stamp = to_iso_string(now).replace(['-', ':'], "");
    let stamp = match stamp.strip_suffix('Z').and_then(|rest| rest.rsplit_once('.')) {
        Some((whole, millis)) if millis.len() == 3 && millis.bytes().all(|b| b.is_ascii_digit()) => format!("{whole}Z"),
        _ => stamp,
    };
    let stem = source_path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let destination = directory.join(format!("{stem}-{stamp}.db")).display().to_string();
    backend_db.backup(&destination)?;
    Ok(destination)
}

/// `restoreDatabase`: replaces the database file, its WAL and shared memory
/// with the backup. Nothing may have the database open.
pub(super) fn restore_database(source: &str, destination: &Path, force: bool) -> Result<(), OpError> {
    if !force {
        return Err(OpError::failed("restore requires --force"));
    }
    if !Path::new(source).exists() {
        return Err(OpError::failed(format!("backup does not exist: {source}")));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    for suffix in ["", "-wal", "-shm"] {
        let path = PathBuf::from(format!("{}{suffix}", destination.display()));
        match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    std::fs::copy(source, destination)?;
    Ok(())
}

/// `auditOperations`.
pub(super) fn audit_operations(
    sqlite: &Connection,
    publishing: &Publishing<'_>,
    now: Timestamp,
) -> Result<Value, OpError> {
    // The journal keeps a year; the window is what an audit is asking about.
    let events_since = to_iso_string(now - SignedDuration::from_hours(AUDIT_EVENT_WINDOW_DAYS * 24));
    let mut out = Map::new();
    out.insert("eventsSince".into(), json!(events_since));
    out.insert("storedDates".into(), to_value(date_integrity(sqlite)?)?);
    out.insert(
        "postEventsByType".into(),
        json!(rows::all(
            sqlite,
            r#"select "severity", "event_type", count(*), max("publication_events"."created_at") from "publication_events" where "publication_events"."created_at" >= ? group by "publication_events"."severity", "publication_events"."event_type" order by "publication_events"."severity", "publication_events"."event_type""#,
            [&events_since],
        )
        .map(|found| rename(found, &["severity", "eventType", "count", "latest"]))?),
    );
    out.insert(
        "recentPostEvents".into(),
        json!(rows::all(
            sqlite,
            r#"select "severity", "event_type", "target", "message", "created_at" from "publication_events" order by "publication_events"."created_at" desc limit ?"#,
            [20],
        )
        .map(|found| rename(found, &["severity", "eventType", "target", "message", "createdAt"]))?),
    );
    out.insert(
        "deliveryIssues".into(),
        json!(rows::all(
            sqlite,
            "SELECT 'publish_job' AS source,status,target,count(*) AS count,max(updated_at) AS latest
         FROM publish_jobs
         WHERE status IN ('failed','verification_required')
         GROUP BY status,target
         UNION ALL
         SELECT 'post_target' AS source,status,target,count(*) AS count,max(updated_at) AS latest
         FROM publication_targets
         WHERE status IN ('failed','verification_required')
         GROUP BY status,target
         ORDER BY status,source,target",
            [],
        )?),
    );
    out.insert(
        "publicationConsistency".into(),
        publication_consistency_report(sqlite, publishing, None)?,
    );
    out.insert(
        "metricScheduleErrors".into(),
        json!(rows::all(
            sqlite,
            r#"select "target", count(*), max("metric_schedule"."updated_at") from "metric_schedule" where ("metric_schedule"."frozen_at" is null and "metric_schedule"."last_error" is not null and "metric_schedule"."last_error" != '') group by "metric_schedule"."target" order by "metric_schedule"."target""#,
            [],
        )
        .map(|found| rename(found, &["target", "count", "latest"]))?),
    );
    // Only actionable delivery failures belong here. Cancelled targets and
    // unfinished/deleted drafts are lifecycle history, not production noise.
    out.insert(
        "recentVideoFailures".into(),
        json!(rows::all(
            sqlite,
            r#"select "video_targets"."video_draft_id", "video_drafts"."label", "video_targets"."target", "video_targets"."status", "video_targets"."last_error", "video_targets"."scheduled_at", "video_targets"."updated_at" from "video_targets" inner join "video_drafts" on "video_drafts"."id" = "video_targets"."video_draft_id" where ("video_targets"."status" = ? and "video_drafts"."status" not in (?, ?, ?)) order by "video_targets"."updated_at" desc limit ?"#,
            params!["failed", "draft", "editing", "cancelled", 20],
        )
        .map(|found| rename(
            found,
            &["videoDraftId", "label", "target", "status", "lastError", "scheduledAt", "updatedAt"]
        ))?),
    );
    out.insert(
        "recentVideoVerificationRequired".into(),
        json!(rows::all(
            sqlite,
            r#"select "video_targets"."video_draft_id", "video_drafts"."label", "video_targets"."target", "video_targets"."last_error", "video_targets"."provider_post_id", "video_targets"."external_id", "video_targets"."scheduled_at", "video_targets"."updated_at" from "video_targets" inner join "video_drafts" on "video_drafts"."id" = "video_targets"."video_draft_id" where ("video_targets"."status" = ? and "video_drafts"."status" not in (?, ?, ?)) order by "video_targets"."updated_at" desc limit ?"#,
            params!["verification_required", "draft", "editing", "cancelled", 20],
        )
        .map(|found| rename(
            found,
            &[
                "videoDraftId",
                "label",
                "target",
                "lastError",
                "providerPostId",
                "externalId",
                "scheduledAt",
                "updatedAt"
            ]
        ))?),
    );
    Ok(Value::Object(out))
}

/// Drizzle's selection object: each column under the name it was selected as.
fn rename(found: Vec<Row>, names: &[&str]) -> Vec<Row> {
    found
        .into_iter()
        .map(|row| {
            row.into_iter()
                .zip(names)
                .map(|((_, value), name)| ((*name).to_owned(), value))
                .collect()
        })
        .collect()
}

#[derive(Clone, Copy)]
enum Scope {
    Post { id: i64 },
    Video { id: i64 },
}

fn consistency_scope(publication: Option<&str>) -> Result<Option<Scope>, OpError> {
    let Some(publication) = publication.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parsed = parse_publication_ref(Some(publication)).filter(|parsed| parsed.id > 0);
    match parsed {
        Some(parsed) if parsed.kind == PublicationRefKind::Post => Ok(Some(Scope::Post { id: parsed.id })),
        Some(parsed) if parsed.kind == PublicationRefKind::Video => Ok(Some(Scope::Video { id: parsed.id })),
        _ => Err(OpError::failed("--ref must look like post:1 or video:1")),
    }
}

struct Report {
    foreign_key_violations: Vec<Row>,
    stale_targets: Vec<Row>,
    target_mismatches: Vec<Row>,
    publication_mismatches: Vec<Row>,
    video_draft_mismatches: Vec<Row>,
    video_target_job_mismatches: Vec<Row>,
}

impl Report {
    fn to_json(&self) -> Value {
        json!({
            "foreignKeyViolations": self.foreign_key_violations,
            "staleTargets": self.stale_targets,
            "targetMismatches": self.target_mismatches,
            "publicationMismatches": self.publication_mismatches,
            "videoDraftMismatches": self.video_draft_mismatches,
            "videoTargetJobMismatches": self.video_target_job_mismatches,
        })
    }
}

fn is_post(scope: Option<Scope>, publication_key: &str) -> bool {
    match scope {
        None => true,
        Some(Scope::Post { id }) => publication_key == publication_ref(PublicationRefKind::Post, id),
        Some(Scope::Video { .. }) => false,
    }
}

fn is_video(scope: Option<Scope>, draft_id: i64) -> bool {
    match scope {
        None => true,
        Some(Scope::Video { id }) => draft_id == id,
        Some(Scope::Post { .. }) => false,
    }
}

fn report(sqlite: &Connection, publishing: &Publishing<'_>, scope: Option<Scope>) -> Result<Report, OpError> {
    let foreign_key_violations = rows::all(sqlite, "PRAGMA foreign_key_check", [])?;
    let mut stale_targets = rows::all(
        sqlite,
        "SELECT t.publication_key,t.target,t.status,t.error,t.updated_at
       FROM publication_targets t
       WHERE t.status IN ('queued','publishing')
         AND NOT EXISTS (
           SELECT 1 FROM publish_jobs j
           WHERE j.publication_key=t.publication_key AND j.target=t.target AND j.status IN ('queued','publishing')
       )
       ORDER BY t.updated_at",
        [],
    )?;
    stale_targets.retain(|row| is_post(scope, rows::text(row, "publication_key")));
    let mut target_mismatches = target_state_mismatches(sqlite)?;
    target_mismatches.retain(|row| is_post(scope, rows::text(row, "publication_key")));
    let mut publication_mismatches = publication_state_mismatches(sqlite, publishing)?;
    publication_mismatches.retain(|row| match scope {
        None => true,
        Some(Scope::Post { id }) => rows::int(row, "post_id") == id,
        Some(Scope::Video { .. }) => false,
    });
    let mut video_draft_mismatches = rows::all(
        sqlite,
        "SELECT d.id,d.status,group_concat(t.status) AS target_statuses
       FROM video_drafts d JOIN video_targets t ON t.video_draft_id=d.id
       GROUP BY d.id
       HAVING (d.status='published' AND sum(t.status!='published')>0)
          OR (d.status='partial' AND sum(t.status IN ('failed','cancelled'))=0)
          OR (d.status='scheduled' AND sum(t.status NOT IN ('published','failed','cancelled','verification_required'))=0)
       ORDER BY d.id",
        [],
    )?;
    video_draft_mismatches.retain(|row| is_video(scope, rows::int(row, "id")));
    // A target awaiting verification is only ever answered through its job: a
    // target left waiting without a job in the same state waits forever.
    let mut video_target_job_mismatches = rows::all(
        sqlite,
        "SELECT t.video_draft_id,t.id AS video_target_id,t.target,t.status AS target_status,
              j.id AS publish_job_id,j.status AS job_status,j.last_error,
              t.provider_post_id,t.external_id
       FROM video_targets t
       JOIN video_jobs j ON j.video_target_id=t.id AND j.kind='publish'
       WHERE (t.status='published' AND j.status NOT IN ('completed','cancelled'))
          OR (t.status='failed' AND j.status='completed')
          OR (t.status='verification_required' AND j.status<>'verification_required')
       ORDER BY t.video_draft_id,t.id",
        [],
    )?;
    video_target_job_mismatches.retain(|row| is_video(scope, rows::int(row, "video_draft_id")));
    Ok(Report {
        foreign_key_violations,
        stale_targets,
        target_mismatches,
        publication_mismatches,
        video_draft_mismatches,
        video_target_job_mismatches,
    })
}

/// `publicationConsistencyReport`.
pub(super) fn publication_consistency_report(
    sqlite: &Connection,
    publishing: &Publishing<'_>,
    publication: Option<&str>,
) -> Result<Value, OpError> {
    let scope = consistency_scope(publication)?;
    Ok(report(sqlite, publishing, scope)?.to_json())
}

/// `repairPublicationConsistency`: every write carries the state it read in
/// its own `WHERE`.
pub(super) fn repair_publication_consistency(
    sqlite: &Connection,
    publishing: &Publishing<'_>,
    publication: Option<&str>,
    now: Timestamp,
) -> Result<Value, OpError> {
    let scope = consistency_scope(publication)?;
    let before = report(sqlite, publishing, scope)?;
    let now = to_iso_string(now);
    let mut deleted_orphans = 0;
    let mut repaired_targets = 0;
    let mut repaired_publications = 0;
    let mut repaired_video_jobs = 0;
    let mut skipped_video_jobs = 0;
    domain::repositories::transaction(sqlite, || {
        if scope.is_none() {
            for statement in [
                "DELETE FROM social_comments WHERE video_target_id NOT IN (SELECT id FROM video_targets) OR video_target_id IN (SELECT id FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts))",
                "DELETE FROM video_metric_snapshots WHERE video_target_id NOT IN (SELECT id FROM video_targets) OR video_target_id IN (SELECT id FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts))",
                "DELETE FROM video_metric_schedule WHERE video_target_id NOT IN (SELECT id FROM video_targets) OR video_target_id IN (SELECT id FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts))",
                "DELETE FROM video_jobs WHERE video_draft_id NOT IN (SELECT id FROM video_drafts) OR (video_target_id IS NOT NULL AND video_target_id NOT IN (SELECT id FROM video_targets))",
                "DELETE FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts)",
                "DELETE FROM metric_schedule WHERE publication_key LIKE 'post:%' AND publication_key NOT IN (SELECT 'post:' || post_id FROM drafts WHERE post_id IS NOT NULL)",
                "DELETE FROM publication_targets WHERE publication_key LIKE 'post:%' AND publication_key NOT IN (SELECT 'post:' || post_id FROM drafts WHERE post_id IS NOT NULL)",
                "DELETE FROM post_locales WHERE draft_id NOT IN (SELECT id FROM drafts)",
            ] {
                deleted_orphans += sqlite.execute(statement, [])?;
            }
        }
        for mismatch in &before.target_mismatches {
            let normalized = normalize_archived_job_status(rows::text(mismatch, "job_status"));
            let error = if normalized == "failed" {
                mismatch.get("last_error").and_then(Value::as_str)
            } else {
                None
            };
            repaired_targets += sqlite.execute(
                "UPDATE publication_targets
           SET status=?, error=?, skipped=?, updated_at=?
           WHERE publication_key=? AND target=? AND status=?",
                params![
                    normalized,
                    error,
                    i64::from(normalized == "skipped" || normalized == "cancelled"),
                    now,
                    rows::text(mismatch, "publication_key"),
                    rows::text(mismatch, "target"),
                    rows::text(mismatch, "target_status"),
                ],
            )?;
        }
        for mismatch in &before.publication_mismatches {
            repaired_publications += sqlite.execute(
                "UPDATE drafts SET status=?, updated_at=? WHERE post_id=? AND status=?",
                params![
                    rows::text(mismatch, "expected"),
                    now,
                    rows::int(mismatch, "post_id"),
                    rows::text(mismatch, "status")
                ],
            )?;
        }
        if matches!(scope, Some(Scope::Video { .. })) {
            for mismatch in &before.video_target_job_mismatches {
                let present = |name: &str| {
                    mismatch
                        .get(name)
                        .and_then(Value::as_str)
                        .is_some_and(|v| !v.is_empty())
                };
                if rows::text(mismatch, "target_status") != "published"
                    || (!present("provider_post_id") && !present("external_id"))
                {
                    skipped_video_jobs += 1;
                    continue;
                }
                let changed = sqlite.execute(
                    "UPDATE video_jobs SET status='completed', last_error=NULL, locked_at=NULL, locked_by=NULL, updated_at=? WHERE id=? AND status=?",
                    params![
                        now,
                        rows::int(mismatch, "publish_job_id"),
                        rows::text(mismatch, "job_status")
                    ],
                )?;
                if changed == 0 {
                    continue;
                }
                sqlite.execute(
                    "UPDATE video_targets SET last_error=NULL, updated_at=? WHERE id=? AND status='published'",
                    params![now, rows::int(mismatch, "video_target_id")],
                )?;
                repaired_video_jobs += changed;
            }
        }
        Ok(())
    })?;
    Ok(json!({
        "foreignKeyViolations": before.foreign_key_violations.len(),
        "deletedOrphans": deleted_orphans,
        "repairedTargets": repaired_targets,
        "repairedPublications": repaired_publications,
        "repairedVideoJobs": repaired_video_jobs,
        "skippedVideoJobs": skipped_video_jobs,
    }))
}

fn target_state_mismatches(sqlite: &Connection) -> Result<Vec<Row>, OpError> {
    let mut found = rows::all(
        sqlite,
        "WITH latest AS (
         SELECT p.publication_key,p.target,p.status,p.last_error
         FROM publish_jobs p
         JOIN (
           SELECT publication_key,target,max(job_id) AS job_id
           FROM publish_jobs WHERE publication_key IS NOT NULL GROUP BY publication_key,target
         ) x ON x.job_id=p.job_id
       )
       SELECT t.publication_key,t.target,t.status AS target_status,l.status AS job_status,l.last_error
       FROM publication_targets t JOIN latest l ON l.publication_key=t.publication_key AND l.target=t.target
       WHERE t.target NOT IN ('site_ru','site_en')
         -- A target attached from an analytics export was never delivered by
         -- this queue, and its old job says nothing about the live post.
         AND coalesce(json_extract(t.raw_json,'$.source'),'') <> 'x_csv_export'
       ORDER BY t.publication_key,t.target",
        [],
    )?;
    found
        .retain(|row| rows::text(row, "target_status") != normalize_archived_job_status(rows::text(row, "job_status")));
    Ok(found)
}

fn publication_state_mismatches(sqlite: &Connection, publishing: &Publishing<'_>) -> Result<Vec<Row>, OpError> {
    // Target and status together, because the pending-locale rule has to know
    // which targets already carry a job.
    let found = rows::all(
        sqlite,
        "SELECT d.post_id,d.status,
              group_concat(x.target || ' ' || x.status, char(10)) AS jobs
       FROM drafts d
       LEFT JOIN (
         SELECT publication_key,target,status FROM publish_jobs
         UNION ALL
         SELECT publication_key,reason AS target,status FROM site_jobs
       ) x ON x.publication_key='post:'||d.post_id
       WHERE d.post_id IS NOT NULL
       GROUP BY d.post_id
       ORDER BY d.post_id",
        [],
    )?;
    let registered = registered_post_target_ids(sqlite)?;
    let mut mismatches = Vec::new();
    for row in found {
        let status = rows::text(&row, "status");
        if status == "cancelled" {
            continue;
        }
        let post_id = rows::int(&row, "post_id");
        let jobs: Vec<(String, String)> = rows::text(&row, "jobs")
            .split('\n')
            .filter(|entry| !entry.is_empty())
            .map(|entry| {
                // `indexOf(" ")`: a missing separator slices off the last character.
                let (target, rest) = match entry.find(' ') {
                    Some(at) => (&entry[..at], &entry[at + 1..]),
                    None => (&entry[..entry.char_indices().last().map_or(0, |(at, _)| at)], entry),
                };
                (target.to_owned(), normalize_archived_job_status(rest).to_owned())
            })
            .collect();
        let plan = publishing.publication_plan_from_db(post_id, &registered)?;
        let expected = effective_publication_status(&jobs, plan.as_ref(), &registered);
        if let Some(expected) = expected.filter(|expected| *expected != status) {
            mismatches.push(
                [
                    ("post_id".to_owned(), json!(post_id)),
                    ("status".to_owned(), json!(status)),
                    ("expected".to_owned(), json!(expected)),
                ]
                .into_iter()
                .collect(),
            );
        }
    }
    Ok(mismatches)
}

fn normalize_archived_job_status(status: &str) -> &str {
    if status == "failed_archived" {
        "cancelled"
    } else {
        status
    }
}
