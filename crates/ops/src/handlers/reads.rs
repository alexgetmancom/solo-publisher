//! The read-only reports: `status.ts`, `recent.ts`, `post-text.ts`,
//! `timeline.ts`, `journal.ts`, `video-library.ts`, `verify.ts`,
//! `settings-report.ts`, `format-support.ts` (summary), the Studio profile and
//! channel reports, and the usage report.

use std::collections::HashSet;
use std::time::Duration;

use db::rusqlite::types::{Value as SqlValue, ValueRef};
use db::rusqlite::{Connection, Params, params, params_from_iter};
use domain::application::ports::{LocalizedProfiles, LocalizedText};
use domain::application::publication_ref::{PublicationRefKind, parse_publication_ref, publication_ref};
use domain::publishing::state::is_partial_delivery;
use domain::repositories::ActionableIssueStore;
use domain::studio::services::settings::StudioProfileInput;
use foundation::js;
use foundation::time::{parse_iso_instant, to_iso_string};
use runtime::http::HttpRequest;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::publication_ref::resolve_publication_ref;
use super::usage::usage_report;
use crate::context::{Fut, Input, OpError, OpResult, OperationContext, to_value};

type Row = Map<String, Value>;

fn cell(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
        ValueRef::Integer(number) => json!(number),
        ValueRef::Real(number) => crate::schema::number_value(number),
        ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text).into_owned()),
    }
}

/// Every row of `sql` as an object keyed by its column names, in order.
fn select(sqlite: &Connection, sql: &str, values: impl Params) -> db::rusqlite::Result<Vec<Row>> {
    let mut statement = sqlite.prepare(sql)?;
    let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
    statement
        .query_map(values, |row| {
            let mut out = Map::new();
            for (index, name) in names.iter().enumerate() {
                out.insert(name.clone(), cell(row.get_ref(index)?));
            }
            Ok(out)
        })?
        .collect()
}

/// A drizzle `json` column as read: `JSON.parse` of what is stored.
fn json_column(row: &mut Row, name: &str) -> Result<(), OpError> {
    if let Some(Value::String(text)) = row.get(name) {
        let parsed: Value = serde_json::from_str(text)?;
        row.insert(name.to_owned(), parsed);
    }
    Ok(())
}

/// `jsonObject(value)`: the stored text as an object, anything else `{}`.
fn json_object(value: &Value) -> Value {
    match value {
        Value::String(text) if !text.is_empty() => match serde_json::from_str::<Value>(text) {
            Ok(parsed @ Value::Object(_)) => parsed,
            _ => json!({}),
        },
        _ => json!({}),
    }
}

/// `Date.parse(end) - Date.parse(start)`, when both are dates and it is not negative.
fn elapsed(start: &Value, end: &Value) -> Value {
    let (Some(start), Some(end)) = (start.as_str(), end.as_str()) else {
        return Value::Null;
    };
    match (parse_iso_instant(start), parse_iso_instant(end)) {
        (Ok(start), Ok(end)) if end.as_millisecond() >= start.as_millisecond() => {
            json!(end.as_millisecond() - start.as_millisecond())
        }
        _ => Value::Null,
    }
}

// --- settings and profile -------------------------------------------------------

/// `settingsReport`: what the settings screens hold.
pub fn settings<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let settings = context.services(&config)?.settings;
        let profile = settings.studio_profile()?;
        let administrators = config
            .controller_admin_ids
            .iter()
            .map(|actor_id| {
                Ok(json!({
                    "actorId": actor_id,
                    "locale": settings.locale(*actor_id)?.as_str(),
                    "notifications": to_value(settings.notifications(*actor_id)?)?,
                }))
            })
            .collect::<Result<Vec<Value>, OpError>>()?;
        Ok(json!({
            "timezone": profile.timezone,
            "youtubeSignature": settings.youtube_signature()?,
            "backup": to_value(settings.backup()?)?,
            "administrators": administrators,
        }))
    })
}

pub fn studio_profile<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        to_value(context.services(&config)?.settings.studio_profile()?)
    })
}

fn localized<T: serde::de::DeserializeOwned>(input: &Input, name: &str) -> Result<Option<T>, OpError> {
    input
        .get(name)
        .map(|value| serde_json::from_value(value.clone()).map_err(OpError::from))
        .transpose()
}

pub fn studio_profile_set<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let profile = StudioProfileInput {
            timezone: input.opt_str("timezone").map(str::to_owned),
            timezone_label: input.opt_str("timezone_label").map(str::to_owned),
            site_enabled: input.opt_bool("site_enabled"),
            prepare_lead_minutes: input.get("prepare_lead_minutes").and_then(Value::as_f64),
            retention_hours: input.get("retention_hours").and_then(Value::as_f64),
            name: localized::<LocalizedText>(input, "name")?,
            tagline: localized::<LocalizedText>(input, "tagline")?,
            about: localized::<LocalizedText>(input, "about")?,
            bio: localized::<LocalizedText>(input, "bio")?,
            site_timezone: localized::<LocalizedText>(input, "site_timezone")?,
            profiles: localized::<LocalizedProfiles>(input, "profiles")?,
        };
        let config = context.config()?;
        to_value(context.services(&config)?.settings.set_studio_profile(&profile)?)
    })
}

pub fn channels<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        to_value(context.services(&config)?.channels.report(false)?)
    })
}

// --- status -----------------------------------------------------------------------

/// `statusCounts`: rows per status, in status order.
fn status_counts(sqlite: &Connection, table: &str) -> Result<Map<String, Value>, OpError> {
    let mut statement = sqlite.prepare(&format!(
        "SELECT status, count(*) AS count FROM {table} GROUP BY status ORDER BY status"
    ))?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    let mut counts = Map::new();
    for row in rows {
        let (status, count) = row?;
        counts.insert(status, json!(count));
    }
    Ok(counts)
}

fn total(counts: &Map<String, Value>) -> i64 {
    counts.values().filter_map(Value::as_i64).sum()
}

fn counted(counts: Map<String, Value>) -> Value {
    json!({"total": total(&counts), "byStatus": counts})
}

fn count_rows(sqlite: &Connection, sql: &str) -> Result<i64, OpError> {
    Ok(sqlite.query_row(sql, [], |row| row.get(0))?)
}

struct Worker {
    entry: Value,
    ok: bool,
    stale: bool,
}

/// `operationsStatus`: the health summary, with full worker records and
/// timestamps on request.
pub fn status<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let details = input.bool("details");
        let config = context.config()?;
        let sqlite = context.sqlite()?;
        let now = context.now();
        let expected = runtime::worker_state::expected_worker_names(
            config
                .controller_bot_token
                .as_deref()
                .is_some_and(|token| !token.is_empty()),
        );
        let mut workers: Vec<Worker> = Vec::new();
        let mut statement = sqlite.prepare("SELECT name,state_json,updated_at FROM worker_state ORDER BY name")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (name, state_json, updated_at) = row?;
            if !expected.contains(&name.as_str()) {
                continue;
            }
            let state = match serde_json::from_str::<Value>(&state_json)? {
                Value::Object(state) => state,
                _ => Map::new(),
            };
            let scheduler_error = state.get("scheduler_error").unwrap_or(&Value::Null);
            let ok = state.get("ok") != Some(&Value::Bool(false)) && !domain::json::truthy(scheduler_error);
            let last_run_at = match state.get("last_run_at") {
                Some(Value::String(at)) => at.clone(),
                _ => updated_at.clone(),
            };
            let last_error = match (scheduler_error, state.get("last_error")) {
                (Value::String(error), _) | (_, Some(Value::String(error))) => Value::from(error.clone()),
                _ => Value::Null,
            };
            let liveness = runtime::worker_state::worker_liveness(&state, &updated_at, now);
            workers.push(Worker {
                entry: json!({
                    "name": name,
                    "ok": ok,
                    "lastRunAt": last_run_at,
                    "lastError": last_error,
                    "ageSeconds": liveness.age_seconds,
                    "stale": liveness.stale,
                    "lastHeartbeatAt": liveness.last_heartbeat_at,
                }),
                ok,
                stale: liveness.stale,
            });
        }
        drop(statement);
        let observed: HashSet<&str> = workers
            .iter()
            .filter_map(|worker| worker.entry["name"].as_str())
            .collect();
        let mut problems: Vec<Value> = expected
            .iter()
            .filter(|name| !observed.contains(*name))
            .map(|name| json!({"name": name, "reasons": ["missing"], "lastError": null, "ageSeconds": null}))
            .collect();
        for worker in workers.iter().filter(|worker| !worker.ok || worker.stale) {
            let mut reasons = Vec::new();
            if !worker.ok {
                reasons.push("error");
            }
            if worker.stale {
                reasons.push("stale");
            }
            problems.push(json!({
                "name": worker.entry["name"],
                "reasons": reasons,
                "lastError": worker.entry["lastError"],
                "ageSeconds": worker.entry["ageSeconds"],
            }));
        }
        let issues = ActionableIssueStore::new(sqlite).list(None)?;
        let mut by_kind = Map::new();
        for issue in &issues {
            let kind = to_value(issue.kind)?.as_str().unwrap_or_default().to_owned();
            let count = by_kind.get(&kind).and_then(Value::as_i64).unwrap_or(0);
            by_kind.insert(kind, json!(count + 1));
        }
        let video_failures = issues
            .iter()
            .filter(|issue| issue.kind == domain::application::ports::IssueKind::Video)
            .count();
        let schedule = sqlite.query_row(
            "SELECT count(*) AS total,
        sum(CASE WHEN frozen_at IS NOT NULL THEN 1 ELSE 0 END) AS frozen,
        sum(CASE WHEN frozen_at IS NULL AND (next_check_at IS NULL OR next_check_at <= ?) THEN 1 ELSE 0 END) AS due,
        sum(CASE WHEN frozen_at IS NULL AND last_error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
        max(last_checked_at) AS lastCheckedAt
      FROM metric_schedule",
            params![to_iso_string(now)],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )?;
        let healthy = workers.iter().filter(|worker| worker.ok && !worker.stale).count();
        let site_enabled = context.services(&config)?.settings.studio_profile()?.site_enabled;
        let mut report = Map::new();
        report.insert("ok".into(), json!(problems.is_empty() && issues.is_empty()));
        report.insert("gitRevision".into(), json!(runtime::git::git_revision(&context.cwd)));
        report.insert("siteEnabled".into(), json!(site_enabled));
        if details {
            report.insert("generatedAt".into(), json!(to_iso_string(now)));
            report.insert(
                "database".into(),
                json!({
                    "path": config.pipeline_db.display().to_string(),
                    "exists": config.pipeline_db.exists(),
                }),
            );
        }
        let mut workers_report = Map::new();
        workers_report.insert("total".into(), json!(expected.len()));
        workers_report.insert("healthy".into(), json!(healthy));
        workers_report.insert("problems".into(), Value::Array(problems));
        if details {
            workers_report.insert(
                "entries".into(),
                Value::Array(workers.iter().map(|worker| worker.entry.clone()).collect()),
            );
        }
        report.insert("workers".into(), Value::Object(workers_report));
        report.insert("attention".into(), json!({"total": issues.len(), "byKind": by_kind}));
        report.insert(
            "posts".into(),
            json!({
                "total": count_rows(sqlite, "SELECT count(*) AS count FROM drafts WHERE post_id IS NOT NULL")?,
                "targets": counted(status_counts(sqlite, "publication_targets")?),
                "jobs": counted(status_counts(sqlite, "publish_jobs")?),
            }),
        );
        let video_targets = status_counts(sqlite, "video_targets")?;
        report.insert(
            "videos".into(),
            json!({
                "drafts": counted(status_counts(sqlite, "video_drafts")?),
                "targets": {
                    "total": total(&video_targets),
                    "byStatus": video_targets,
                    "actionableFailures": video_failures,
                },
                "jobs": counted(status_counts(sqlite, "video_jobs")?),
            }),
        );
        report.insert(
            "site".into(),
            json!({"jobs": counted(status_counts(sqlite, "site_jobs")?)}),
        );
        let mut schedule_report = Map::new();
        schedule_report.insert("total".into(), json!(schedule.0));
        schedule_report.insert("frozen".into(), json!(schedule.1.unwrap_or(0)));
        schedule_report.insert("due".into(), json!(schedule.2.unwrap_or(0)));
        schedule_report.insert("errors".into(), json!(schedule.3.unwrap_or(0)));
        if details {
            schedule_report.insert("lastCheckedAt".into(), json!(schedule.4));
        }
        report.insert(
            "metrics".into(),
            json!({
                "samples": count_rows(sqlite, "SELECT count(*) AS count FROM metric_samples")?,
                "schedule": schedule_report,
            }),
        );
        Ok(Value::Object(report))
    })
}

// --- the journal --------------------------------------------------------------------

/// `journalEvents`: the journal, read directly, newest first.
pub fn events<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let sqlite = context.sqlite()?;
        let since = input.opt_str("since");
        let event_type = input.opt_str("type");
        let severity = input.opt_str("severity");
        let reference = input.opt_str("ref");
        let limit = input.int("limit");
        let mut filters = Vec::new();
        let mut values: Vec<SqlValue> = Vec::new();
        if let Some(since) = since {
            filters.push("created_at >= ?");
            values.push(SqlValue::Text(since.to_owned()));
        }
        // A prefix: the useful question is about a family of events.
        if let Some(event_type) = event_type {
            filters.push("event_type LIKE ?");
            values.push(SqlValue::Text(format!("{event_type}%")));
        }
        if let Some(severity) = severity {
            filters.push("severity = ?");
            values.push(SqlValue::Text(severity.to_owned()));
        }
        if let Some(reference) = reference {
            filters.push("publication_key = ?");
            values.push(SqlValue::Text(reference.to_owned()));
        }
        values.push(SqlValue::Integer(limit));
        let filter = if filters.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", filters.join(" AND "))
        };
        let rows = select(
            sqlite,
            &format!(
                "SELECT id, publication_key AS ref, event_type AS eventType, severity, target, message,
                        details_json AS details, created_at AS createdAt
                   FROM publication_events{filter}
                  ORDER BY created_at DESC, id DESC LIMIT ?"
            ),
            params_from_iter(values),
        )?;
        let count = rows.len();
        let events: Vec<Value> = rows
            .into_iter()
            .map(|mut row| {
                let details = match row.get("details") {
                    Some(Value::String(text)) if !text.is_empty() => {
                        serde_json::from_str(text).unwrap_or_else(|_| Value::from(text.clone()))
                    }
                    _ => Value::Null,
                };
                row.insert("details".into(), details);
                Value::Object(row)
            })
            .collect();
        Ok(json!({
            "query": {"since": since, "type": event_type, "severity": severity, "ref": reference},
            "count": count,
            // A full page is a truncated answer.
            "truncated": i64::try_from(count).unwrap_or(i64::MAX) == limit,
            "events": events,
        }))
    })
}

// --- the video library --------------------------------------------------------------

/// `videoLibrary`: the authored corpus, without delivery internals,
/// credentials or media paths.
pub fn video_library<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let sqlite = context.sqlite()?;
        let exported_at = to_iso_string(context.now());
        let (targets, videos, mut games) = domain::repositories::transaction(sqlite, || {
            let targets = select(
                sqlite,
                "SELECT id, video_draft_id, target, status, external_id, external_url, published_at
                   FROM video_targets ORDER BY id ASC",
                [],
            )?;
            let videos = select(
                sqlite,
                "SELECT id, locale, label, status, game, script, script_source, opening_line, updated_at
                   FROM video_drafts ORDER BY id ASC",
                [],
            )?;
            let games = select(
                sqlite,
                "SELECT name, steam_app_id, genres, player_modes, release_date, developer, source, captured_at
                   FROM games ORDER BY name ASC",
                [],
            )?;
            Ok((targets, videos, games))
        })?;
        for game in &mut games {
            json_column(game, "genres")?;
            json_column(game, "player_modes")?;
        }
        let videos: Vec<Value> = videos
            .into_iter()
            .map(|mut video| {
                let copies: Vec<Value> = targets
                    .iter()
                    .filter(|target| target["video_draft_id"] == video["id"])
                    .cloned()
                    .map(Value::Object)
                    .collect();
                video.insert("targets".into(), Value::Array(copies));
                Value::Object(video)
            })
            .collect();
        Ok(json!({"exported_at": exported_at, "videos": videos, "games": games}))
    })
}

// --- recent and find ----------------------------------------------------------------

/// How many posts back the "usual" target set is learned from.
const BASELINE_POSTS: i64 = 20;

/// `partial`: the target did not finish and something of it is live all the same.
#[derive(Clone, Serialize)]
struct DeliveredTarget {
    target: String,
    status: String,
    url: Option<String>,
    partial: bool,
}

struct RawRow {
    publication_key: String,
    post_id: i64,
    date_utc: Option<String>,
    status: String,
    text: String,
    targets: Vec<DeliveredTarget>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationRow {
    #[serde(rename = "ref")]
    reference: String,
    post_id: i64,
    at: Option<String>,
    status: String,
    headline: String,
    targets: Vec<DeliveredTarget>,
    /// Targets created for this post that did not reach the audience.
    undelivered: Vec<DeliveredTarget>,
    /// Usual targets this post never had a job for: a choice, not a gap.
    absent_targets: Vec<String>,
}

fn publication_rows(sqlite: &Connection, limit: i64) -> Result<Vec<RawRow>, OpError> {
    let mut statement = sqlite.prepare(
        "SELECT drafts.post_id, coalesce(recent_ru.published_at, drafts.updated_at), drafts.status,
                coalesce(recent_ru.approved_text, recent_ru.source_text, '')
           FROM drafts
           LEFT JOIN post_locales recent_ru ON (recent_ru.draft_id = drafts.id AND recent_ru.locale = 'ru')
          WHERE drafts.post_id is not null
          ORDER BY coalesce(recent_ru.published_at, drafts.updated_at) DESC
          LIMIT ?",
    )?;
    let mut rows: Vec<RawRow> = statement
        .query_map(params![limit], |row| {
            let post_id: i64 = row.get(0)?;
            Ok(RawRow {
                publication_key: publication_ref(PublicationRefKind::Post, post_id),
                post_id,
                date_utc: row.get(1)?,
                status: row.get(2)?,
                text: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                targets: Vec::new(),
            })
        })?
        .collect::<Result<_, _>>()?;
    if rows.is_empty() {
        return Ok(rows);
    }
    let placeholders = vec!["?"; rows.len()].join(", ");
    let keys: Vec<String> = rows.iter().map(|row| row.publication_key.clone()).collect();
    let mut statement = sqlite.prepare(&format!(
        "SELECT publication_key, target, status, url, external_id FROM publication_targets
          WHERE publication_key IN ({placeholders}) ORDER BY target"
    ))?;
    let delivered = statement.query_map(params_from_iter(keys.iter()), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    for target in delivered {
        let (key, target, status, url, external_id) = target?;
        let partial = is_partial_delivery(&status, external_id.as_deref());
        for row in rows.iter_mut().filter(|row| row.publication_key == key) {
            row.targets.push(DeliveredTarget {
                target: target.clone(),
                status: status.clone(),
                url: url.clone(),
                partial,
            });
        }
    }
    Ok(rows)
}

/// A target counts as expected once most of the recent posts carried it.
fn usual_targets(rows: &[RawRow]) -> Vec<String> {
    let baseline = &rows[..rows.len().min(BASELINE_POSTS as usize)];
    let mut seen: Vec<(String, usize)> = Vec::new();
    for target in baseline.iter().flat_map(|row| &row.targets) {
        match seen.iter_mut().find(|(name, _)| *name == target.target) {
            Some((_, count)) => *count += 1,
            None => seen.push((target.target.clone(), 1)),
        }
    }
    let quorum = baseline.len().div_ceil(2).max(1);
    let mut expected: Vec<String> = seen
        .into_iter()
        .filter(|(_, count)| *count >= quorum)
        .map(|(target, _)| target)
        .collect();
    expected.sort();
    expected
}

fn describe(row: &RawRow, expected: &[String]) -> PublicationRow {
    let present: HashSet<&str> = row.targets.iter().map(|target| target.target.as_str()).collect();
    PublicationRow {
        reference: row.publication_key.clone(),
        post_id: row.post_id,
        at: row.date_utc.clone(),
        status: row.status.clone(),
        headline: headline(&row.text),
        targets: row.targets.clone(),
        undelivered: row
            .targets
            .iter()
            .filter(|target| target.status != "published")
            .cloned()
            .collect(),
        absent_targets: expected
            .iter()
            .filter(|target| !present.contains(target.as_str()))
            .cloned()
            .collect(),
    }
}

/// The first line is the post's own headline.
fn headline(text: &str) -> String {
    let first = js::trim(text.split('\n').next().unwrap_or_default());
    if first.encode_utf16().count() > 60 {
        format!("{}…", js::slice_utf16(first, 59))
    } else {
        first.to_owned()
    }
}

/// `recentPublications`: recent publications with their per-target delivery state.
pub fn recent<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let limit = input.int("limit");
        let rows = publication_rows(context.sqlite()?, limit.max(BASELINE_POSTS))?;
        let expected = usual_targets(&rows);
        let posts: Vec<PublicationRow> = rows
            .iter()
            .take(usize::try_from(limit).unwrap_or(0))
            .map(|row| describe(row, &expected))
            .collect();
        Ok(json!({"expectedTargets": expected, "posts": to_value(posts)?}))
    })
}

/// `findPublication`: a post by a fragment of its text, measured against the
/// same baseline `recent` uses.
pub fn find<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let query = input.str("query");
        let needle = js::trim(query).to_lowercase();
        if needle.is_empty() {
            return Err(OpError::failed("--query must not be empty"));
        }
        let sqlite = context.sqlite()?;
        let expected = usual_targets(&publication_rows(sqlite, BASELINE_POSTS)?);
        let matches: Vec<PublicationRow> = publication_rows(sqlite, 400)?
            .iter()
            .filter(|row| row.text.to_lowercase().contains(&needle))
            .take(10)
            .map(|row| describe(row, &expected))
            .collect();
        Ok(json!({"query": query, "expectedTargets": expected, "matches": to_value(matches)?}))
    })
}

fn pad_end(text: &str, width: usize) -> String {
    let length = text.encode_utf16().count();
    format!("{text}{}", " ".repeat(width.saturating_sub(length)))
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

fn publication_line(post: &Value) -> String {
    let undelivered = post["undelivered"].as_array().cloned().unwrap_or_default();
    let failed: Vec<String> = undelivered
        .iter()
        .map(|target| {
            format!(
                "{}={}{}",
                target["target"].as_str().unwrap_or_default(),
                target["status"].as_str().unwrap_or_default(),
                if target["partial"] == true { "+partial" } else { "" }
            )
        })
        .collect();
    let absent = strings(&post["absentTargets"]);
    let trailer = [
        if failed.is_empty() {
            "ok".to_owned()
        } else {
            let partial = undelivered.iter().any(|target| target["partial"] == true);
            format!("{} {}", if partial { "PARTIAL" } else { "FAILED" }, failed.join(" "))
        },
        if absent.is_empty() {
            String::new()
        } else {
            format!("not sent: {}", absent.join(","))
        },
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("  ");
    let at = js::slice_utf16(post["at"].as_str().unwrap_or_default(), 16).replacen('T', " ", 1);
    format!(
        "{} {at}  {} targets  {trailer}\n            {}",
        pad_end(post["ref"].as_str().unwrap_or_default(), 9),
        post["targets"].as_array().map_or(0, Vec::len),
        post["headline"].as_str().unwrap_or_default()
    )
}

/// `formatRecentPublications`: one line per post.
pub fn format_recent(result: &Value) -> String {
    let expected = strings(&result["expectedTargets"]);
    let mut lines = vec![
        format!(
            "expected targets: {}",
            if expected.is_empty() {
                "none".to_owned()
            } else {
                expected.join(", ")
            }
        ),
        String::new(),
    ];
    lines.extend(result["posts"].as_array().into_iter().flatten().map(publication_line));
    lines.join("\n")
}

/// `formatPublicationMatches`.
pub fn format_find(result: &Value) -> String {
    let matches = result["matches"].as_array().cloned().unwrap_or_default();
    if matches.is_empty() {
        return format!("no post matches {}", result["query"]);
    }
    matches.iter().map(publication_line).collect::<Vec<_>>().join("\n")
}

// --- post text ----------------------------------------------------------------------

/// `postText`: the full copy of one publication, in both languages.
pub fn post_text<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let reference = input.str("ref");
        let sqlite = context.sqlite()?;
        let resolved = resolve_publication_ref(sqlite, reference)?
            .ok_or_else(|| OpError::Failed(format!("no publication matches {reference}")))?;
        let row = select(
            sqlite,
            "SELECT drafts.post_id AS postId,
                    coalesce(post_text_ru.published_at, post_text_en.published_at, drafts.updated_at) AS dateUtc,
                    coalesce(post_text_ru.approved_text, post_text_ru.source_text, '') AS text,
                    coalesce(post_text_en.approved_text, post_text_en.source_text, '') AS textEn
               FROM drafts
               LEFT JOIN post_locales post_text_ru ON (post_text_ru.draft_id = drafts.id AND post_text_ru.locale = 'ru')
               LEFT JOIN post_locales post_text_en ON (post_text_en.draft_id = drafts.id AND post_text_en.locale = 'en')
              WHERE drafts.post_id = ? LIMIT 1",
            params![resolved.post_id],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| OpError::Failed(format!("publication {} has no stored text", resolved.publication_key)))?;
        let locales: Vec<&str> = domain::channels::post_locales(sqlite)?
            .into_iter()
            .map(|locale| locale.as_str())
            .collect();
        Ok(json!({
            "ref": resolved.publication_key,
            "postId": row["postId"],
            "at": row["dateUtc"],
            "locales": locales,
            "ru": row["text"],
            "en": row["textEn"],
        }))
    })
}

/// `formatPostText`.
pub fn format_post_text(value: &Value) -> String {
    let text = |locale: &str| {
        let trimmed = js::trim(value[locale].as_str().unwrap_or_default());
        if trimmed.is_empty() {
            "(no text)".to_owned()
        } else {
            trimmed.to_owned()
        }
    };
    let mut lines = vec![format!(
        "{}  {}",
        value["ref"].as_str().unwrap_or_default(),
        value["at"].as_str().unwrap_or("unscheduled")
    )];
    let locales = strings(&value["locales"]);
    if locales.len() == 1 {
        lines.push(String::new());
        lines.push(text(locales[0]));
        return lines.join("\n");
    }
    for locale in locales {
        lines.push(String::new());
        lines.push(format!("--- {locale} ---"));
        lines.push(text(locale));
    }
    lines.join("\n")
}

// --- verify -------------------------------------------------------------------------

/// `verifyPostTargets`: every target of one post, the published ones asked
/// of their own address.
pub fn verify<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let reference = input.str("ref");
        let sqlite = context.sqlite()?;
        let numeric = js::number(reference.strip_prefix("post:").unwrap_or(reference));
        // A non-numeric ref must not reach the query as NaN.
        let id = if js::is_safe_integer(numeric) {
            numeric as i64
        } else {
            -1
        };
        let post_id = select(
            sqlite,
            "SELECT post_id AS postId FROM drafts WHERE post_id = ? LIMIT 1",
            params![id],
        )?
        .into_iter()
        .next()
        .and_then(|row| row["postId"].as_i64())
        .filter(|post_id| *post_id != 0)
        .ok_or_else(|| OpError::Failed(format!("post not found: {reference}")))?;
        let targets = select(
            sqlite,
            "SELECT target, status, url, error, external_id AS externalId FROM publication_targets
              WHERE publication_key = ? ORDER BY target ASC",
            params![publication_ref(PublicationRefKind::Post, post_id)],
        )?;
        let checks = targets.into_iter().map(|record| verify_target(context, record));
        Ok(Value::Array(futures_util::future::join_all(checks).await))
    })
}

async fn verify_target(context: &OperationContext<'_>, mut record: Row) -> Value {
    let status = record["status"].as_str().unwrap_or_default().to_owned();
    let external_id = record["externalId"].as_str().map(str::to_owned);
    if status != "published" {
        // An unfinished target holding an external id put something in front
        // of the audience: not ok, and not "nothing was sent" either.
        let reason = match external_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => Value::from(format!("published_in_part:{id}")),
            None => match &record["error"] {
                Value::Null => Value::from("not_published"),
                error => error.clone(),
            },
        };
        let partial = is_partial_delivery(&status, external_id.as_deref());
        put(
            &mut record,
            [("ok", json!(false)), ("partial", json!(partial)), ("reason", reason)],
        );
        return Value::Object(record);
    }
    let Some(url) = record["url"].as_str().filter(|url| !url.is_empty()).map(str::to_owned) else {
        put(
            &mut record,
            [
                ("ok", json!(true)),
                ("partial", json!(false)),
                ("reason", json!("no_public_url_known")),
            ],
        );
        return Value::Object(record);
    };
    match probe_publication(context, &url).await {
        Ok((ok, reason)) => put(
            &mut record,
            [("ok", json!(ok)), ("reason", json!(reason)), ("partial", json!(false))],
        ),
        Err(reason) => put(
            &mut record,
            [
                ("ok", json!(false)),
                ("partial", json!(false)),
                ("reason", json!(reason)),
            ],
        ),
    }
    Value::Object(record)
}

fn put(record: &mut Row, fields: [(&str, Value); 3]) {
    for (name, value) in fields {
        record.insert(name.to_owned(), value);
    }
}

/// Asks the publication's own address whether it is still there. Redirects
/// are not followed: a deleted post answered with a redirect to a profile or
/// a login wall is reported as the redirect it is, and a chain cannot walk
/// from a public host into this container's own network.
async fn probe_publication(context: &OperationContext<'_>, url: &str) -> Result<(bool, String), String> {
    let Some(target) = public_url(url) else {
        return Ok((false, "unverifiable_url".into()));
    };
    let request = HttpRequest::get(target.as_str())
        .header("user-agent", "solo-publisher-verify/1.0")
        .deadline(Duration::from_secs(15))
        .manual_redirect();
    let response = context.http.exchange(request).await.map_err(|failure| {
        if failure.timed_out {
            "The operation timed out.".to_owned()
        } else {
            failure.message
        }
    })?;
    let status = response.status;
    // A 404 or 410 is a failure; 5xx too, as a provider fault.
    if (300..=399).contains(&status) {
        let location = response.headers.get("location").unwrap_or_else(|| "no_location".into());
        return Ok((false, format!("http_{status}:{location}")));
    }
    Ok((status < 400, format!("http_{status}")))
}

/// A published post lives at a public HTTPS name; anything else is not a
/// post URL, and asking it would only tell an outsider what this container
/// can reach.
fn public_url(value: &str) -> Option<url::Url> {
    let parsed = url::Url::parse(value).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str().unwrap_or_default().to_lowercase();
    let host = host.strip_prefix('[').unwrap_or(&host);
    let host = host.strip_suffix(']').unwrap_or(host);
    // A real post URL is a name, never a literal address.
    if (!host.is_empty() && host.bytes().all(|b| b.is_ascii_digit() || b == b'.')) || host.contains(':') {
        return None;
    }
    if host == "localhost"
        || [".localhost", ".internal", ".local"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
    {
        return None;
    }
    if !host.contains('.') {
        return None;
    }
    Some(parsed)
}

// --- timeline -----------------------------------------------------------------------

/// `publicationTimeline`: jobs, targets and the full event log of one publication.
pub fn timeline<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let reference = input.str("ref");
        let sqlite = context.sqlite()?;
        match parse_publication_ref(Some(reference)) {
            // A video publication's events are journalled under its own ref.
            Some(parsed) if parsed.kind == PublicationRefKind::Video => video_timeline(sqlite, reference, parsed.id),
            Some(parsed) if parsed.kind == PublicationRefKind::Post => post_timeline(sqlite, reference),
            _ => Err(OpError::failed("--ref must look like post:106 or video:12")),
        }
    })
}

fn with_duration(jobs: Vec<Row>) -> Vec<Value> {
    jobs.into_iter()
        .map(|mut job| {
            let start = match &job["lockedAt"] {
                Value::Null => job["createdAt"].clone(),
                locked => locked.clone(),
            };
            let duration = elapsed(&start, &job["updatedAt"]);
            job.insert("durationMs".into(), duration);
            Value::Object(job)
        })
        .collect()
}

fn post_timeline(sqlite: &Connection, reference: &str) -> OpResult {
    let events = timeline_events(sqlite, reference)?;
    let jobs = select(
        sqlite,
        "SELECT job_id AS jobId, target, status, attempt_count AS attemptCount, publish_at AS publishAt,
                created_at AS createdAt, locked_at AS lockedAt, updated_at AS updatedAt, last_error AS lastError
           FROM publish_jobs WHERE publication_key = ? ORDER BY created_at ASC, job_id ASC",
        params![reference],
    )?;
    let targets = select(
        sqlite,
        "SELECT target, status, url, error, published_at AS publishedAt, updated_at AS updatedAt
           FROM publication_targets WHERE publication_key = ? ORDER BY target",
        params![reference],
    )?;
    Ok(json!({"ref": reference, "jobs": with_duration(jobs), "targets": targets, "events": events}))
}

fn video_timeline(sqlite: &Connection, reference: &str, video_draft_id: i64) -> OpResult {
    let draft = select(
        sqlite,
        "SELECT locale, label, status, scheduled_at AS scheduledAt, created_at AS createdAt
           FROM video_drafts WHERE id = ? LIMIT 1",
        params![video_draft_id],
    )?
    .into_iter()
    .next();
    let mut targets = select(
        sqlite,
        "SELECT video_targets.id AS id, video_targets.target AS target, video_targets.status AS status,
                video_targets.metadata_json AS metadata, video_targets.delivery_provider AS deliveryProvider,
                video_targets.provider_post_id AS providerPostId,
                video_targets.confirmation_source AS confirmationSource,
                video_targets.external_id AS externalId, video_targets.external_url AS url,
                video_targets.last_error AS error, video_targets.published_at AS publishedAt,
                video_targets.verified_at AS verifiedAt, video_targets.updated_at AS updatedAt,
                video_metric_schedule.frozen_at AS metricsFrozenAt,
                video_metric_schedule.checkpoint_index AS metricsCheckpointIndex,
                video_metric_schedule.last_checked_at AS metricsLastCheckedAt,
                video_metric_schedule.last_error AS metricsLastError
           FROM video_targets
           LEFT JOIN video_metric_schedule ON video_metric_schedule.video_target_id = video_targets.id
          WHERE video_targets.video_draft_id = ? ORDER BY video_targets.target",
        params![video_draft_id],
    )?;
    for target in &mut targets {
        json_column(target, "metadata")?;
    }
    let jobs = select(
        sqlite,
        "SELECT id AS jobId, video_target_id AS videoTargetId, kind, status, attempt_count AS attemptCount,
                run_at AS runAt, created_at AS createdAt, locked_at AS lockedAt, updated_at AS updatedAt,
                last_error AS lastError
           FROM video_jobs WHERE video_draft_id = ? ORDER BY created_at ASC, id ASC",
        params![video_draft_id],
    )?;
    Ok(json!({
        "ref": reference,
        "draft": draft,
        "jobs": with_duration(jobs),
        "targets": targets,
        "events": timeline_events(sqlite, reference)?,
    }))
}

fn timeline_events(sqlite: &Connection, reference: &str) -> Result<Vec<Value>, OpError> {
    Ok(select(
        sqlite,
        "SELECT created_at, severity, event_type, target, message, details_json FROM publication_events
          WHERE publication_key = ? ORDER BY created_at ASC, id ASC",
        params![reference],
    )?
    .into_iter()
    .map(|event| {
        json!({
            "at": event["created_at"],
            "severity": event["severity"],
            "type": event["event_type"],
            "target": event["target"],
            "message": event["message"],
            "details": json_object(&event["details_json"]),
        })
    })
    .collect())
}

// --- format support and usage -------------------------------------------------------

/// `formatSupportSummary`: every media test case with what each target
/// proved, the targets as SQLite's own JSON text.
pub fn format_support<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let rows = select(
            context.sqlite()?,
            r#"SELECT "media_test_cases"."test_id" AS testId, "media_test_cases"."title" AS title,
                      "media_test_cases"."format_key" AS formatKey, "media_test_cases"."status" AS status,
                      "media_test_cases"."last_message_id" AS lastMessageId,
                      json_group_object("format_support"."target", "format_support"."status") AS targets
                 FROM "media_test_cases"
                 LEFT JOIN "format_support" ON "format_support"."format_key" = "media_test_cases"."format_key"
                GROUP BY "media_test_cases"."test_id"
                ORDER BY "media_test_cases"."test_id" ASC"#,
            [],
        )?;
        to_value(rows)
    })
}

pub fn usage<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        usage_report(
            context.sqlite()?,
            context.surface.usage(),
            context.now(),
            input.opt_int("days"),
            input.opt_int("unused_days"),
            &crate::registry::operation_usage_keys(),
        )
    })
}
