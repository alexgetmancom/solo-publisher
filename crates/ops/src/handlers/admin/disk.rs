//! What the data volume holds, and how much of
//! it nothing points at any more. Media caches age out on a TTL; a Story
//! variant whose source is gone is a file nothing will read or delete.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use db::rusqlite::Connection;
use delivery::story_media::story_directory;
use foundation::config::Config;
use foundation::json::json_record_array;
use regex::Regex;
use runtime::data_dirs::required_data_directories;
use serde_json::{Map, Value, json};

use super::rows;
use crate::context::OpError;

static VARIANT_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-story-(standard|telegram)\.[^.]+$").unwrap());

/// `diskReport`.
pub(super) fn disk_report(sqlite: &Connection, config: &Config) -> Result<Value, OpError> {
    let mut directories: Vec<(String, PathBuf)> = required_data_directories(config)
        .into_iter()
        .map(|entry| (entry.name.to_owned(), entry.path))
        .collect();
    directories.push(("story-media".into(), story_directory(config)));
    let db = config.pipeline_db.display().to_string();
    let database = file_bytes(Path::new(&db))
        + file_bytes(Path::new(&format!("{db}-wal")))
        + file_bytes(Path::new(&format!("{db}-shm")));
    let orphans = orphaned_story_variants(sqlite, config)?;
    let directories: Vec<Value> = directories
        .into_iter()
        .map(|(name, path)| {
            let (files, bytes) = usage(&path);
            json!({
                "name": name,
                "path": path.display().to_string(),
                "files": files,
                "bytes": bytes,
                "megabytes": megabytes(bytes),
            })
        })
        .collect();
    Ok(json!({
        "ok": true,
        "database_bytes": database,
        "directories": directories,
        "studio_media": studio_media_holdings(sqlite)?,
        "story_variants": {
            "files": orphans.total,
            "orphaned": orphans.orphaned.len(),
            "orphaned_bytes": orphans.bytes,
            "orphaned_megabytes": megabytes(orphans.bytes),
            // Named, because an orphan is a bug's residue rather than a number to watch.
            "orphaned_files": orphans.orphaned.iter().take(20).collect::<Vec<_>>(),
        },
    }))
}

#[derive(Default)]
struct Holding {
    files: u64,
    bytes: u64,
    oldest: Vec<Value>,
}

/// Why each stored source is still there: a post's attachment is kept for as
/// long as the post, a video source is released a retention window after its
/// drafts are final, and a file no draft names is one nothing will delete.
fn studio_media_holdings(sqlite: &Connection) -> Result<Value, OpError> {
    const NAMES: [&str; 4] = [
        "post_attachment",
        "video_source_pending",
        "video_source_released",
        "unreferenced",
    ];
    let mut held: [Holding; 4] = Default::default();
    let assets = rows::all(sqlite, r#"select "id", "local_path" from "studio_media_assets""#, [])?;
    let post_asset_ids = referenced_post_asset_ids(sqlite)?;
    let mut video_by_asset: HashMap<i64, Vec<bool>> = HashMap::new();
    for draft in rows::all(
        sqlite,
        r#"select "studio_media_asset_id", "status", "retention_until", "source_pruned_at" from "video_drafts""#,
        [],
    )? {
        if let Some(asset) = draft.get("studio_media_asset_id").and_then(Value::as_i64) {
            video_by_asset
                .entry(asset)
                .or_default()
                .push(!draft["source_pruned_at"].is_null());
        }
    }
    for asset in &assets {
        let local_path = rows::text(asset, "local_path");
        if !Path::new(local_path).exists() {
            continue;
        }
        let bytes = file_bytes(Path::new(local_path));
        let id = rows::int(asset, "id");
        let drafts = video_by_asset.get(&id).map(Vec::as_slice).unwrap_or_default();
        // A post attachment outranks the video rule: retention refuses to
        // reclaim a source a post still points at.
        let bucket = if post_asset_ids.contains(&id) {
            0
        } else if drafts.is_empty() {
            3
        } else if drafts.iter().all(|pruned| *pruned) {
            2
        } else {
            1
        };
        let holding = &mut held[bucket];
        holding.files += 1;
        holding.bytes += bytes;
        if holding.oldest.len() < 10 {
            holding
                .oldest
                .push(json!({"path": local_path, "megabytes": megabytes(bytes)}));
        }
    }
    let mut out = Map::new();
    out.insert(
        "note".into(),
        json!(
            "post_attachment is kept for as long as the post; video_source_pending is released a retention window after its drafts are final; unreferenced is named by no draft at all and nothing will delete it."
        ),
    );
    for (name, holding) in NAMES.into_iter().zip(held) {
        out.insert(
            name.into(),
            json!({
                "files": holding.files,
                "bytes": holding.bytes,
                "oldest": holding.oldest,
                "megabytes": megabytes(holding.bytes),
            }),
        );
    }
    Ok(Value::Object(out))
}

fn post_media(sqlite: &Connection) -> Result<Vec<Map<String, Value>>, OpError> {
    Ok(rows::all(sqlite, r#"select "media_json" from "post_locales""#, [])?
        .iter()
        .flat_map(|row| json_record_array(row.get("media_json").and_then(Value::as_str)))
        .collect())
}

/// Post media names its asset by id, by path, or by both; this reads it the
/// way retention does.
fn referenced_post_asset_ids(sqlite: &Connection) -> Result<HashSet<i64>, OpError> {
    let mut ids = HashSet::new();
    for item in post_media(sqlite)? {
        if let Some(id) = content::message::media_asset_id(&item).filter(|id| *id > 0) {
            ids.insert(id);
        }
    }
    Ok(ids)
}

pub(crate) struct OrphanedVariants {
    pub total: usize,
    pub orphaned: Vec<String>,
    pub bytes: u64,
}

/// `replace(/\.[^.]+$/, "")`: the last extension, if it has a name.
fn without_extension(name: &str) -> &str {
    match name.rfind('.') {
        Some(at) if at + 1 < name.len() => &name[..at],
        _ => name,
    }
}

/// `orphanedStoryVariants`: a variant's name starts with its source's
/// content-addressed stem, which is the only link between the two.
pub(crate) fn orphaned_story_variants(sqlite: &Connection, config: &Config) -> Result<OrphanedVariants, OpError> {
    let mut live = HashSet::new();
    for source in known_sources(sqlite)? {
        let path = Path::new(&source);
        if path.exists() {
            let base = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            live.insert(without_extension(&base).to_owned());
        }
    }
    let directory = story_directory(config);
    let mut variants = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&directory) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().is_ok_and(|kind| kind.is_file()) && !name.starts_with('.') {
                variants.push(name);
            }
        }
    }
    // Directory order is the filesystem's: sorted, a plan reads the same on
    // every host.
    variants.sort();
    let orphaned: Vec<String> = variants
        .iter()
        .filter(|name| !live.contains(VARIANT_SUFFIX.replace(name, "").as_ref()))
        .cloned()
        .collect();
    let bytes = orphaned.iter().map(|name| file_bytes(&directory.join(name))).sum();
    Ok(OrphanedVariants {
        total: variants.len(),
        orphaned,
        bytes,
    })
}

fn known_sources(sqlite: &Connection) -> Result<Vec<String>, OpError> {
    let mut sources: Vec<String> = rows::all(sqlite, r#"select "local_path" from "studio_media_assets""#, [])?
        .iter()
        .map(|row| rows::text(row, "local_path").to_owned())
        .collect();
    for item in post_media(sqlite)? {
        let local_path = match item.get("local_path") {
            Some(Value::String(path)) => Some(path.clone()),
            _ => item.get("localPath").and_then(Value::as_str).map(str::to_owned),
        };
        sources.extend(local_path);
    }
    Ok(sources)
}

fn usage(directory: &Path) -> (u64, u64) {
    fn walk(current: &Path, files: &mut u64, bytes: &mut u64) {
        let Ok(entries) = std::fs::read_dir(current) else {
            return;
        };
        for entry in entries.flatten() {
            let target = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                walk(&target, files, bytes);
            } else if kind.is_file() {
                *files += 1;
                *bytes += file_bytes(&target);
            }
        }
    }
    let (mut files, mut bytes) = (0, 0);
    walk(directory, &mut files, &mut bytes);
    (files, bytes)
}

fn file_bytes(target: &Path) -> u64 {
    std::fs::metadata(target).map_or(0, |metadata| metadata.len())
}

fn megabytes(bytes: u64) -> f64 {
    ((bytes as f64 / 1_048_576.0) * 10.0 + 0.5).floor() / 10.0
}
