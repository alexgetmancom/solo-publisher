//! `delivery/media-prepare.ts`: media staged where a platform can fetch it —
//! a local copy in the cache, a video normalized to the target's bounds, and
//! a public file under the staging URL — plus the hourly cache sweep.

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use adapters::payload::{field, is_video, media_extension};
use adapters::{AdapterContext, AdapterError};
use content::message::MediaItem;
use domain::publishing::platform_profiles::video_bounds;
use foundation::config::Config;
use runtime::external::telegram_files::{MaterializeOptions, TelegramFileSource, materialize_telegram_file};
use runtime::ffmpeg::{FFMPEG_TIMEOUT, FFPROBE_TIMEOUT, probe_media_metadata, run_ffmpeg};
use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};

use crate::site_media_storage::{copy_file_atomically, extname};
use crate::story_media::story_directory;

const MEDIA_CACHE_TTL_SECONDS: i64 = 86_400;

fn io(error: std::io::Error) -> AdapterError {
    AdapterError::Message(error.to_string())
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn public_base(config: &Config) -> &str {
    config
        .public_media_base_url
        .strip_suffix('/')
        .unwrap_or(&config.public_media_base_url)
}

/// `prepareMediaItems(config, items, fetchImpl, target)`.
pub async fn prepare_media_items(
    ctx: &AdapterContext,
    source_items: Vec<MediaItem>,
    target: Option<&str>,
) -> adapters::Result<Vec<MediaItem>> {
    let config = &ctx.config;
    tokio::fs::create_dir_all(&config.media_cache_dir).await.map_err(io)?;
    tokio::fs::create_dir_all(&config.remote_media_path).await.map_err(io)?;
    let mut prepared = Vec::new();
    for (index, item) in source_items.into_iter().enumerate() {
        let cache_key = media_cache_key(&item, field(&item, "localPath"), index).await;
        let local_path = ensure_local_media(ctx, &item, &cache_key).await?;
        let upload_path = if is_video(&item) {
            normalize_video_for_public_upload(config, &local_path, &cache_key, target).await?
        } else {
            local_path.clone()
        };
        // The public name varies with the normalized file, not the source: two
        // targets with different bounds would otherwise stage under one name
        // and the first target's resolution would be served to the second.
        let upload = text(&upload_path);
        let extension = match extname(&upload) {
            "" => media_extension(&item),
            extension => extension.to_owned(),
        };
        let remote_filename = format!(
            "cache-{}{extension}",
            remote_variant_key(&cache_key, &local_path, &upload_path)
        );
        copy_if_missing(&upload_path, &config.remote_media_path.join(&remote_filename)).await?;
        let mut prepared_item = item.clone();
        prepared_item.insert("localPath".into(), upload.into());
        prepared_item.insert(
            "vpsUrl".into(),
            format!("{}/{remote_filename}", public_base(config)).into(),
        );
        // Telegram receives the small-file Story variant; Instagram keeps the
        // quality master.
        let story_path = if target == Some("telegram_stories") {
            field(&item, "telegramStoryLocalPath").or_else(|| field(&item, "storyLocalPath"))
        } else {
            field(&item, "storyLocalPath")
        };
        if let Some(story_path) = story_path {
            let story_key = media_cache_key(&item, Some(story_path), index).await;
            let story_extension = match extname(story_path) {
                "" => media_extension(&item),
                extension => extension.to_owned(),
            };
            let story_remote = format!("cache-{story_key}-story{story_extension}");
            copy_if_missing(Path::new(story_path), &config.remote_media_path.join(&story_remote)).await?;
            prepared_item.insert("storyLocalPath".into(), story_path.into());
            prepared_item.insert(
                "storyVpsUrl".into(),
                format!("{}/{story_remote}", public_base(config)).into(),
            );
        }
        prepared.push(prepared_item);
    }
    Ok(prepared)
}

/// Source media stages under its own key; a normalized derivative gets the
/// variant marker its file name carries (e.g. `1080x1920`), so each bounds
/// variant owns a distinct public URL.
fn remote_variant_key(cache_key: &str, local_path: &Path, upload_path: &Path) -> String {
    if upload_path == local_path {
        return cache_key.to_owned();
    }
    let upload = text(upload_path);
    let name = upload.rsplit('/').next().unwrap_or_default();
    let base = &name[..name.len() - extname(name).len()];
    let marker = base.replacen(&format!("{cache_key}."), "", 1);
    let mut variant = String::new();
    let mut in_run = false;
    for character in marker.chars() {
        if character.is_ascii_alphanumeric() || character == '.' {
            variant.push(character);
            in_run = false;
        } else if !in_run {
            variant.push('-');
            in_run = true;
        }
    }
    if variant.is_empty() {
        cache_key.to_owned()
    } else {
        format!("{cache_key}-{variant}")
    }
}

/// `pruneMediaCache`: files past a day in the cache, the public staging
/// (`cache-*` only), the upload temporaries, and the dot-prefixed partials a
/// killed Story encode left. Story derivatives themselves are durable.
pub async fn prune_media_cache(config: &Config, now_ms: i64) -> usize {
    let cutoff = now_ms - MEDIA_CACHE_TTL_SECONDS * 1000;
    let stories = story_directory(config);
    let roots = [
        config.media_cache_dir.clone(),
        config.remote_media_path.clone(),
        config.studio_media_dir.join(".incoming"),
        stories.clone(),
    ];
    let mut removed = 0;
    for root in roots {
        let Ok(mut entries) = tokio::fs::read_dir(&root).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            if !entry.file_type().await.is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if root == config.remote_media_path && !name.starts_with("cache-") {
                continue;
            }
            if root == stories && !name.starts_with('.') {
                continue;
            }
            let target = root.join(&name);
            let Ok(stat) = tokio::fs::metadata(&target).await else {
                continue;
            };
            if modified_ms(&stat).is_some_and(|modified| modified < cutoff as f64) {
                let _ = tokio::fs::remove_file(&target).await;
                removed += 1;
            }
        }
    }
    removed
}

/// `stat.mtimeMs`.
fn modified_ms(stat: &std::fs::Metadata) -> Option<f64> {
    let since = stat.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(since.as_secs() as f64 * 1000.0 + f64::from(since.subsec_nanos()) / 1e6)
}

async fn ensure_local_media(ctx: &AdapterContext, item: &MediaItem, cache_key: &str) -> adapters::Result<PathBuf> {
    let target = ctx
        .config
        .media_cache_dir
        .join(format!("{cache_key}{}", media_extension(item)));
    if target.exists() {
        return Ok(target);
    }
    if let Some(local_path) = field(item, "localPath") {
        copy_if_missing(Path::new(local_path), &target).await?;
        return Ok(target);
    }
    let Some(file_id) = field(item, "fileId") else {
        return Err(AdapterError::message_text(
            "media item has neither localPath nor fileId",
        ));
    };
    materialize_telegram_file(
        &ctx.client,
        &ctx.config,
        TelegramFileSource::FileId(file_id),
        MaterializeOptions {
            token: field(item, "token"),
            target: Some(&target),
            extension: None,
        },
    )
    .await?;
    Ok(target)
}

/// Different targets have different bounds for the same source, so the
/// bounds are part of the derivative's name.
async fn normalize_video_for_public_upload(
    config: &Config,
    input: &Path,
    cache_key: &str,
    target: Option<&str>,
) -> adapters::Result<PathBuf> {
    let metadata = probe_media_metadata(&text(input), FFPROBE_TIMEOUT)
        .await
        .map_err(|error| AdapterError::Message(error.to_string()))?;
    let Some((max_width, max_height)) =
        target.and_then(|target| video_bounds(target, metadata.width as u32, metadata.height as u32))
    else {
        return Ok(input.to_owned());
    };
    let output = config
        .media_cache_dir
        .join(format!("{cache_key}.{max_width}x{max_height}.normalized.mp4"));
    if output.exists() {
        return Ok(output);
    }
    let (input, output_text) = (text(input), text(&output));
    let scale = format!(
        "scale='min({max_width},iw)':'min({max_height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p"
    );
    let args: Vec<&str> = if metadata.width <= f64::from(max_width) && metadata.height <= f64::from(max_height) {
        vec![
            "-y",
            "-i",
            &input,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            &output_text,
        ]
    } else {
        vec![
            "-y",
            "-i",
            &input,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-vf",
            &scale,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            &output_text,
        ]
    };
    run_ffmpeg(&args, FFMPEG_TIMEOUT)
        .await
        .map_err(|error| AdapterError::Message(error.to_string()))?;
    Ok(output)
}

/// `mediaCacheKey(item, index)` with `item.localPath` read as `local_path`:
/// the first 24 hex of the sha256 of the item's identity and its file's size
/// and modification time.
async fn media_cache_key(item: &MediaItem, local_path: Option<&str>, index: usize) -> String {
    let stat = match local_path {
        Some(path) => tokio::fs::metadata(path).await.ok(),
        None => None,
    };
    let mut identity = Map::new();
    identity.insert("index".into(), index.into());
    // `type: undefined` is left out by JSON.stringify.
    if let Some(kind) = item.get("type") {
        identity.insert("type".into(), kind.clone());
    }
    identity.insert("fileId".into(), item.get("fileId").cloned().unwrap_or(Value::Null));
    identity.insert(
        "localPath".into(),
        local_path.map_or_else(|| item_local_path(item), |path| Value::String(path.to_owned())),
    );
    identity.insert(
        "size".into(),
        stat.as_ref().map_or(Value::Null, |stat| stat.len().into()),
    );
    identity.insert(
        "modified".into(),
        stat.as_ref()
            .and_then(modified_ms)
            .and_then(serde_json::Number::from_f64)
            .map_or(Value::Null, Value::Number),
    );
    let digest = Sha256::digest(domain::json::stringify_object(&identity).as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    hex[..24].to_owned()
}

/// `item.localPath ?? null` when the path is not a usable string.
fn item_local_path(item: &MediaItem) -> Value {
    item.get("localPath").cloned().unwrap_or(Value::Null)
}

async fn copy_if_missing(source: &Path, target: &Path) -> adapters::Result<()> {
    if target.exists() {
        return Ok(());
    }
    copy_file_atomically(source, target).await.map_err(io)?;
    tokio::fs::set_permissions(target, std::fs::Permissions::from_mode(0o644))
        .await
        .map_err(io)
}
