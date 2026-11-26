//! An already-absent publication and all
//! of its stored state removed for good, only after the platforms confirm it
//! is gone and only while its targets still read as they did when checked.

use std::path::Path;
use std::time::Duration;

use content::Locale;
use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, params_from_iter};
use domain::application::publication_ref::{PublicationRefKind, parse_publication_ref, publication_ref};
use domain::repositories::immediate_transaction;
use providers::adapters::platform_adapters::text_target_is_absent;
use providers::adapters::video_publishers::{VideoTargetRef, video_target_is_absent};
use runtime::http::HttpRequest;
use serde_json::{Map, Value, json};

use super::super::publication_ref::resolve_publication_ref;
use super::{CommandHandle, refusal};
use crate::context::{OpError, OpResult};

struct PurgeStatement {
    name: &'static str,
    count_sql: String,
    delete_sql: String,
    args: Vec<SqlValue>,
}

#[derive(Clone, Debug, PartialEq)]
struct TargetState {
    target: String,
    status: String,
    url: Option<String>,
    external_id: Option<String>,
    external_ids_json: Option<String>,
    delivery_provider: String,
    provider_post_id: Option<String>,
}

/// `purgePublication`.
pub(crate) async fn purge_publication(handle: &CommandHandle<'_>, reference: &str, apply: bool) -> OpResult {
    if let Some(parsed) = parse_publication_ref(Some(reference))
        && parsed.kind == PublicationRefKind::Video
    {
        return purge_video_publication(handle, parsed.id, apply).await;
    }
    let sqlite = handle.publishing.sqlite;
    let Some(resolved) = resolve_publication_ref(sqlite, reference)? else {
        return Err(OpError::failed(format!("publication not found: {reference}")));
    };
    let key = resolved.publication_key.clone();
    let post_id = resolved.post_id;
    let draft_id: Option<i64> = sqlite
        .query_row("SELECT id AS draftId FROM drafts WHERE post_id=?", [post_id], |row| {
            row.get(0)
        })
        .optional()?
        .filter(|id| *id != 0);
    let Some(draft_id) = draft_id else {
        return Err(OpError::failed(format!("purge requires a Studio publication: {key}")));
    };
    let refs = [
        publication_ref(PublicationRefKind::Post, post_id),
        publication_ref(PublicationRefKind::Draft, draft_id),
    ];
    let statements = purge_statements(post_id, draft_id, &key, &refs);
    let rows = affected_rows(sqlite, &statements)?;
    let files: Vec<String> = sqlite
        .prepare("SELECT local_path AS path FROM draft_story_cards WHERE draft_id=? AND local_path IS NOT NULL")?
        .query_map([draft_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    if !apply {
        return Ok(json!({
            "ok": true,
            "applied": false,
            "action": "purge",
            "ref": key,
            "draft_id": draft_id,
            "rows": rows,
            "files": files,
        }));
    }

    let verified = assert_targets_absent(handle, target_states(sqlite, &key)?).await?;
    let deleted = immediate_transaction(sqlite, || {
        // The proof that nothing is live came over HTTP and cannot travel in
        // a WHERE clause, so it travels as this: the delete proceeds only
        // while the targets still read exactly as they did when checked.
        if target_signature(&target_states(sqlite, &key)?) != target_signature(&verified) {
            return Err(refusal(format!(
                "targets for {key} changed while it was being verified; nothing was deleted"
            )));
        }
        let result = execute_purge(sqlite, &statements)?;
        let remaining: i64 = sqlite.query_row(
            "SELECT COUNT(*) AS count FROM drafts WHERE post_id=? OR id=?",
            [post_id, draft_id],
            |row| row.get(0),
        )?;
        if remaining != 0 {
            return Err(refusal(format!("purge did not remove {key}")));
        }
        Ok(result)
    })?;
    let (removed_files, failed_files) = remove_files(&files);
    Ok(json!({
        "ok": failed_files.is_empty(),
        "applied": true,
        "action": "purge",
        "ref": key,
        "draft_id": draft_id,
        "deleted": deleted,
        "removed_files": removed_files,
        "failed_files": failed_files,
    }))
}

/// A video publication hangs off its draft by foreign key; the journal and a
/// source upload shared with something else do not.
async fn purge_video_publication(handle: &CommandHandle<'_>, video_draft_id: i64, apply: bool) -> OpResult {
    let sqlite = handle.publishing.sqlite;
    let reference = publication_ref(PublicationRefKind::Video, video_draft_id);
    let draft: Option<(i64, String)> = sqlite
        .query_row(
            "SELECT studio_media_asset_id AS assetId, locale FROM video_drafts WHERE id=?",
            [video_draft_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((asset_id, locale)) = draft else {
        return Err(OpError::failed(format!("publication not found: {reference}")));
    };
    let statements = video_purge_statements(video_draft_id, &reference);
    let rows = affected_rows(sqlite, &statements)?;
    let files = orphaned_asset_files(sqlite, asset_id, video_draft_id)?;
    if !apply {
        return Ok(json!({
            "ok": true,
            "applied": false,
            "action": "purge",
            "ref": reference,
            "video_draft_id": video_draft_id,
            "rows": rows,
            "files": files,
        }));
    }

    let locale = if locale == "en" { Locale::En } else { Locale::Ru };
    let verified = assert_video_targets_absent(handle, video_target_states(sqlite, video_draft_id)?, locale).await?;
    let deleted = immediate_transaction(sqlite, || {
        // The same fence as the text path, for the same reason.
        if target_signature(&video_target_states(sqlite, video_draft_id)?) != target_signature(&verified) {
            return Err(refusal(format!(
                "targets for {reference} changed while it was being verified; nothing was deleted"
            )));
        }
        let result = execute_purge(sqlite, &statements)?;
        let remaining: i64 = sqlite.query_row(
            "SELECT COUNT(*) AS count FROM video_drafts WHERE id=?",
            [video_draft_id],
            |row| row.get(0),
        )?;
        if remaining != 0 {
            return Err(refusal(format!("purge did not remove {reference}")));
        }
        // The asset row goes only when this draft was the last thing holding it.
        if !files.is_empty() {
            sqlite.execute("DELETE FROM studio_media_assets WHERE id=?", [asset_id])?;
        }
        Ok(result)
    })?;
    let (removed_files, failed_files) = remove_files(&files);
    Ok(json!({
        "ok": failed_files.is_empty(),
        "applied": true,
        "action": "purge",
        "ref": reference,
        "video_draft_id": video_draft_id,
        "deleted": deleted,
        "removed_files": removed_files,
        "failed_files": failed_files,
    }))
}

fn statement(name: &'static str, table: &str, filter: &str, args: Vec<SqlValue>) -> PurgeStatement {
    PurgeStatement {
        name,
        count_sql: format!("SELECT COUNT(*) AS count FROM {table} WHERE {filter}"),
        delete_sql: format!("DELETE FROM {table} WHERE {filter}"),
        args,
    }
}

fn text(value: &str) -> SqlValue {
    SqlValue::Text(value.to_owned())
}

/// Deleting the draft cascades to all of these; they are spelled out so the
/// plan can report what it is about to remove, one line per table.
fn video_purge_statements(video_draft_id: i64, reference: &str) -> Vec<PurgeStatement> {
    let of_draft = "video_target_id IN (SELECT id FROM video_targets WHERE video_draft_id=?)";
    let id = || vec![SqlValue::Integer(video_draft_id)];
    vec![
        statement(
            "notification_jobs",
            "studio_notification_jobs",
            "ref=?",
            vec![text(reference)],
        ),
        statement(
            "publication_events",
            "publication_events",
            "publication_key=?",
            vec![text(reference)],
        ),
        statement("social_comments", "social_comments", of_draft, id()),
        statement("video_metric_snapshots", "video_metric_snapshots", of_draft, id()),
        statement("video_metric_schedule", "video_metric_schedule", of_draft, id()),
        statement("video_jobs", "video_jobs", "video_draft_id=?", id()),
        statement("video_targets", "video_targets", "video_draft_id=?", id()),
        statement("video_drafts", "video_drafts", "id=?", id()),
    ]
}

fn purge_statements(post_id: i64, draft_id: i64, publication_key: &str, refs: &[String]) -> Vec<PurgeStatement> {
    let marks = vec!["?"; refs.len()].join(",");
    let refs = || refs.iter().map(|value| text(value)).collect::<Vec<_>>();
    let draft = || vec![SqlValue::Integer(draft_id)];
    let key = || vec![text(publication_key)];
    vec![
        statement(
            "notification_jobs",
            "studio_notification_jobs",
            &format!("ref IN ({marks})"),
            refs(),
        ),
        statement(
            "publication_events",
            "publication_events",
            &format!("publication_key IN ({marks})"),
            refs(),
        ),
        statement("draft_story_cards", "draft_story_cards", "draft_id=?", draft()),
        statement(
            "draft_entity_candidates",
            "draft_entity_candidates",
            "draft_id=?",
            draft(),
        ),
        statement("conversation_sessions", "conversation_sessions", "draft_id=?", draft()),
        statement("pending_albums", "pending_albums", "draft_id=?", draft()),
        statement("post_metrics", "post_metrics", "publication_key=?", key()),
        statement("metric_samples", "metric_samples", "publication_key=?", key()),
        statement("metric_schedule", "metric_schedule", "publication_key=?", key()),
        PurgeStatement {
            name: "x_activity_links",
            count_sql: "SELECT COUNT(*) AS count FROM x_activity_items WHERE linked_publication_key=?".into(),
            delete_sql: "UPDATE x_activity_items SET linked_publication_key=NULL WHERE linked_publication_key=?".into(),
            args: key(),
        },
        statement("draft_entity_links", "draft_entity_links", "draft_id=?", draft()),
        statement("post_locales", "post_locales", "draft_id=?", draft()),
        statement("publication_targets", "publication_targets", "publication_key=?", key()),
        statement("site_jobs", "site_jobs", "publication_key=?", key()),
        statement("publish_jobs", "publish_jobs", "publication_key=?", key()),
        statement(
            "drafts",
            "drafts",
            "id=? AND post_id=?",
            vec![SqlValue::Integer(draft_id), SqlValue::Integer(post_id)],
        ),
    ]
}

fn affected_rows(sqlite: &Connection, statements: &[PurgeStatement]) -> Result<Map<String, Value>, OpError> {
    let mut rows = Map::new();
    for statement in statements {
        let count: i64 = sqlite.query_row(&statement.count_sql, params_from_iter(statement.args.iter()), |row| {
            row.get(0)
        })?;
        if count > 0 {
            rows.insert(statement.name.into(), json!(count));
        }
    }
    Ok(rows)
}

fn execute_purge(sqlite: &Connection, statements: &[PurgeStatement]) -> domain::Result<Map<String, Value>> {
    let mut result = Map::new();
    for statement in statements {
        let changes = sqlite.execute(&statement.delete_sql, params_from_iter(statement.args.iter()))?;
        if changes > 0 {
            result.insert(statement.name.into(), json!(changes));
        }
    }
    Ok(result)
}

fn target_states(sqlite: &Connection, publication_key: &str) -> domain::Result<Vec<TargetState>> {
    Ok(sqlite
        .prepare(
            "SELECT target,status,url,external_id AS externalId,external_ids_json AS externalIdsJson FROM publication_targets WHERE publication_key=? ORDER BY target",
        )?
        .query_map([publication_key], |row| {
            Ok(TargetState {
                target: row.get(0)?,
                status: row.get(1)?,
                url: row.get(2)?,
                external_id: row.get(3)?,
                external_ids_json: row.get(4)?,
                delivery_provider: String::new(),
                provider_post_id: None,
            })
        })?
        .collect::<Result<_, _>>()?)
}

fn video_target_states(sqlite: &Connection, video_draft_id: i64) -> domain::Result<Vec<TargetState>> {
    Ok(sqlite
        .prepare(
            "SELECT target,status,external_url AS url,external_id AS externalId,delivery_provider AS deliveryProvider,provider_post_id AS providerPostId FROM video_targets WHERE video_draft_id=? ORDER BY target",
        )?
        .query_map([video_draft_id], |row| {
            Ok(TargetState {
                target: row.get(0)?,
                status: row.get(1)?,
                url: row.get(2)?,
                external_id: row.get(3)?,
                external_ids_json: None,
                delivery_provider: row.get(4)?,
                provider_post_id: row.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?)
}

/// Compared instead of the rows themselves: a target appearing, changing
/// status or gaining a URL all count as a change.
fn target_signature(states: &[TargetState]) -> String {
    states
        .iter()
        .map(|state| {
            format!(
                "{}|{}|{}",
                state.target,
                state.status,
                state.url.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn stored_external_ids(target: &TargetState) -> Vec<String> {
    let listed: Vec<String> = target
        .external_ids_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<Value>(json).ok())
        .and_then(|value| value.as_array().cloned())
        .map(|ids| ids.iter().map(foundation::js::string_of).collect())
        .unwrap_or_default();
    if !listed.is_empty() {
        return listed;
    }
    target
        .external_id
        .clone()
        .filter(|id| !id.is_empty())
        .into_iter()
        .collect()
}

/// The platform is asked about the stored id wherever it can answer; only a
/// target with nowhere to ask is proved absent over its public address.
async fn assert_targets_absent(
    handle: &CommandHandle<'_>,
    targets: Vec<TargetState>,
) -> Result<Vec<TargetState>, OpError> {
    let ctx = handle.adapter_context();
    for target in &targets {
        if target.status != "published" {
            continue;
        }
        // A post split across several platform objects is gone only when
        // every one of them is.
        let ids = stored_external_ids(target);
        if !ids.is_empty() {
            let mut answers = Vec::new();
            for id in &ids {
                answers.push(
                    text_target_is_absent(&ctx, &target.target, id)
                        .await
                        .map_err(|error| OpError::failed(error.to_string()))?,
                );
            }
            if answers.contains(&Some(false)) {
                return Err(OpError::failed(format!(
                    "{} is still live on the platform",
                    target.target
                )));
            }
            if answers.iter().all(|absent| *absent == Some(true)) {
                continue;
            }
        }
        let Some(url) = target.url.as_deref().filter(|url| !url.is_empty()) else {
            return Err(OpError::failed(format!(
                "cannot prove {} is absent: no public URL is stored",
                target.target
            )));
        };
        let request = HttpRequest::get(url)
            .header("user-agent", "solo-publisher-purge/1.0")
            .deadline(Duration::from_secs(15));
        let response = handle.http.exchange(request).await.map_err(|failure| {
            OpError::failed(format!("cannot prove {} is absent: {}", target.target, failure.message))
        })?;
        if response.status != 404 && response.status != 410 {
            return Err(OpError::failed(format!(
                "{} is still reachable at {url} (HTTP {})",
                target.target, response.status
            )));
        }
    }
    Ok(targets)
}

/// Instagram answers a logged-out request with its login wall and HTTP 200,
/// so the platform is asked about the id with the credentials that published it.
async fn assert_video_targets_absent(
    handle: &CommandHandle<'_>,
    targets: Vec<TargetState>,
    locale: Locale,
) -> Result<Vec<TargetState>, OpError> {
    let ctx = handle.adapter_context();
    for target in &targets {
        if target.status != "published" {
            continue;
        }
        let absent = video_target_is_absent(
            &ctx,
            VideoTargetRef {
                target: &target.target,
                external_id: target.external_id.as_deref(),
                delivery_provider: &target.delivery_provider,
                provider_post_id: target.provider_post_id.as_deref(),
            },
            locale,
        )
        .await
        .map_err(|error| OpError::failed(error.to_string()))?;
        if !absent {
            return Err(OpError::failed(format!(
                "{} is still live on the platform",
                target.target
            )));
        }
    }
    Ok(targets)
}

/// The stored source file, only when no other video draft and no post draft
/// still points at the same asset.
fn orphaned_asset_files(sqlite: &Connection, asset_id: i64, video_draft_id: i64) -> Result<Vec<String>, OpError> {
    let others: i64 = sqlite.query_row(
        "SELECT COUNT(*) AS count FROM video_drafts WHERE studio_media_asset_id=? AND id<>?",
        [asset_id, video_draft_id],
        |row| row.get(0),
    )?;
    if others > 0 || delivery::video_retention::post_draft_references_asset(sqlite, asset_id)? {
        return Ok(Vec::new());
    }
    let path: Option<String> = sqlite
        .query_row(
            "SELECT local_path AS path FROM studio_media_assets WHERE id=?",
            [asset_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(path.filter(|path| !path.is_empty()).into_iter().collect())
}

fn remove_files(files: &[String]) -> (Vec<String>, Vec<String>) {
    let (mut removed, mut failed) = (Vec::new(), Vec::new());
    for path in files {
        if !Path::new(path).exists() {
            continue;
        }
        match std::fs::remove_file(path) {
            Ok(()) => removed.push(path.clone()),
            Err(_) => failed.push(path.clone()),
        }
    }
    (removed, failed)
}
