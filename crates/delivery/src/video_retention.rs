//! Reclaims video source files whose drafts
//! are final and past their retention window. Runs at the tail of every video
//! cycle; it touches no jobs, locks or targets.

use db::rusqlite::{Connection, OptionalExtension as _, params};
use domain::repositories::StudioSettingsStore;
use foundation::config::Config;
use foundation::json::json_record_array;
use serde_json::Value;

use crate::story_derivatives::story_variant_paths;
use crate::{Delivery, Result, iso_at};

const FINAL_STATUSES: [&str; 3] = ["published", "partial", "cancelled"];

/// A draft the sweep decided on, with the values its claim is fenced by.
struct Candidate {
    id: i64,
    status: String,
    retention_until: Option<String>,
    studio_media_asset_id: Option<i64>,
}

/// `pruneExpiredVideos`.
pub fn prune_expired_videos(delivery: &Delivery<'_>) -> Result<()> {
    let sqlite = delivery.sqlite();
    let now = delivery.now();
    let retention_hours = StudioSettingsStore::new(sqlite).profile()?.video_retention_hours;
    let legacy_draft_expires_at = iso_at(delivery.now_ms() - retention_hours * 60 * 60_000);
    // The source is reclaimed exactly once (`source_pruned_at`): the deadline
    // is recomputed on every target change, so it cannot record that. The two
    // legacy branches pick up drafts from before assets had a retention
    // policy, once they have been final for a full window.
    let rows: Vec<Candidate> = sqlite
        .prepare(
            r#"select "id", "status", "retention_until", "studio_media_asset_id" from "video_drafts" where ("video_drafts"."source_pruned_at" is null and (("video_drafts"."retention_until" <= ? and ("video_drafts"."status" = 'published' or "video_drafts"."status" = 'partial' or "video_drafts"."status" = 'cancelled' or "video_drafts"."status" = 'editing')) or ("video_drafts"."retention_until" is null and "video_drafts"."status" in ('published', 'partial', 'cancelled') and "video_drafts"."updated_at" <= ?) or ("video_drafts"."status" = 'editing' and "video_drafts"."retention_until" is null and "video_drafts"."created_at" <= ?)))"#,
        )?
        .query_map(params![now, legacy_draft_expires_at, legacy_draft_expires_at], |row| {
            Ok(Candidate {
                id: row.get(0)?,
                status: row.get(1)?,
                retention_until: row.get(2)?,
                studio_media_asset_id: row.get(3)?,
            })
        })?
        .collect::<db::rusqlite::Result<_>>()?;
    for row in rows {
        // Claim the draft before touching the file. The decision above is a
        // snapshot, and a retry or reschedule in that window puts the draft
        // back to work; the claim carries the status and the deadline it was
        // decided on, so a draft that moved is skipped and re-decided next sweep.
        let claimed = sqlite
            .query_row(
                r#"update "video_drafts" set "status" = ?, "retention_until" = null, "source_pruned_at" = ?, "updated_at" = ? where ("video_drafts"."id" = ? and "video_drafts"."source_pruned_at" is null and "video_drafts"."status" = ? and "video_drafts"."retention_until" is ?) returning "id""#,
                params![
                    if row.status == "editing" { "cancelled" } else { row.status.as_str() },
                    now,
                    now,
                    row.id,
                    row.status,
                    row.retention_until
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if claimed.is_none() {
            continue;
        }
        if let Some(asset_id) = row.studio_media_asset_id {
            prune_studio_asset_source(delivery.config(), sqlite, asset_id, &now)?;
        }
    }
    Ok(())
}

/// `pruneStudioAssetSource`: the original upload is disposable once every
/// draft using it is final and no post draft attaches it; the asset's row
/// stays for published history and analytics.
fn prune_studio_asset_source(config: &Config, sqlite: &Connection, asset_id: i64, now: &str) -> Result<()> {
    let drafts: Vec<(String, Option<String>)> = sqlite
        .prepare(r#"select "status", "retention_until" from "video_drafts" where "video_drafts"."studio_media_asset_id" = ?"#)?
        .query_map([asset_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<db::rusqlite::Result<_>>()?;
    let all_final = drafts.iter().all(|(status, retention_until)| {
        FINAL_STATUSES.contains(&status.as_str()) && retention_until.as_deref().is_none_or(|until| until <= now)
    });
    if drafts.is_empty() || !all_final {
        return Ok(());
    }
    // Never remove a shared source merely because the video side became final.
    if post_draft_references_asset(sqlite, asset_id)? {
        return Ok(());
    }
    let asset: Option<(String, String)> = sqlite
        .query_row(
            r#"select "local_path", "kind" from "studio_media_assets" where "studio_media_assets"."id" = ?"#,
            [asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((local_path, kind)) = asset else {
        return Ok(());
    };
    if !is_managed_video_source(config, &local_path) {
        return Ok(());
    }
    remove_forced(&local_path)?;
    // A Story variant is named after its source's content hash and nothing
    // will look for it again once the source is gone: kept for exactly as
    // long as the source.
    for variant in story_variant_paths(config, &local_path, kind == "video").files() {
        remove_forced(variant)?;
    }
    Ok(())
}

/// `fs.rmSync(path, { force: true })`: a file already gone is not an error.
fn remove_forced(path: impl AsRef<std::path::Path>) -> Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(domain::Error::message(error.to_string())),
        _ => Ok(()),
    }
}

/// `postDraftReferencesAsset`: post attachments are durable JSON, not a
/// foreign key, so the only way to know an asset is unreferenced is to read
/// every draft's media.
pub fn post_draft_references_asset(sqlite: &Connection, asset_id: i64) -> Result<bool> {
    let media: Vec<Option<String>> = sqlite
        .prepare(r#"select "media_json" from "post_locales""#)?
        .query_map([], |row| row.get(0))?
        .collect::<db::rusqlite::Result<_>>()?;
    Ok(media.iter().any(|media| {
        json_record_array(media.as_deref())
            .iter()
            .any(|item| js_number(item.get("asset_id")) == asset_id as f64)
    }))
}

/// `Number(value)`; an absent field is `undefined`, NaN.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Array(_) | Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => foundation::js::number(text),
    }
}

/// `isManagedVideoSource`: only files under the Studio media directory are
/// the sweep's to delete.
fn is_managed_video_source(config: &Config, source: &str) -> bool {
    let resolved = public_site::paths::resolve("", source);
    let directory = public_site::paths::resolve("", &config.studio_media_dir.to_string_lossy());
    resolved.starts_with(&format!("{directory}/"))
}
