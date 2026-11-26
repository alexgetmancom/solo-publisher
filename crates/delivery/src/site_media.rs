//! Publication media copied into the public site
//! under stable, versioned names, with the responsive WebP variants and video
//! posters the site serves made before the post is exposed in the feed.

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use content::Locale;
use content::message::MediaItem;
use content::site_media_naming::{
    RESPONSIVE_WIDTHS, SITE_MEDIA_DIR_SEGMENTS, SITE_MEDIA_URL_PREFIX, site_media_filename, site_media_poster_filename,
};
use domain::publishing::publication_source::PublicationLocaleSource;
use foundation::config::Config;
use foundation::media_types::{file_extension, image_extension};
use providers::adapters::AdapterContext;
use providers::external::telegram_files::{MaterializeOptions, TelegramFileSource, materialize_telegram_file};
use runtime::ffmpeg::{FFMPEG_TIMEOUT, run_ffmpeg};
use serde_json::Value;

use crate::site_media_storage::{copy_file_atomically, deduplicate_site_media_file, sha256_file, temporary_path};

/// Public media files are readable by the site container's group.
const PUBLIC_FILE_MODE: u32 = 0o664;

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn io_message(error: std::io::Error) -> String {
    error.to_string()
}

fn string_field<'a>(item: &'a MediaItem, key: &str) -> &'a str {
    item.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn first_of<'a>(item: &'a MediaItem, keys: &[&str]) -> &'a str {
    keys.iter()
        .map(|key| string_field(item, key))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

/// `siteMediaSource`: rebuilding a page starts with the uploads, never its old
/// viewer derivatives. Thread attachments share the gallery; reviewed
/// descriptions stay with them.
pub fn site_media_source(source: &PublicationLocaleSource) -> Vec<MediaItem> {
    source
        .media
        .iter()
        .chain(source.thread.iter().flat_map(|part| part.media.iter()))
        .filter(|item| item.get("role").and_then(Value::as_str) != Some("text_story_card"))
        .enumerate()
        .map(|(index, item)| {
            let mut item = item.clone();
            if let Some(alt) = source.site_media.get(index).and_then(|stored| stored.get("alt"))
                && alt.is_string()
            {
                item.insert("alt".into(), alt.clone());
            }
            item
        })
        .collect()
}

/// `sitePosterFfmpegArgs`: the first frame half a second in.
pub fn site_poster_ffmpeg_args(source: &str, output: &str) -> Vec<String> {
    ["-y", "-ss", "0.5", "-i", source, "-frames:v", "1", "-q:v", "2", output]
        .map(str::to_owned)
        .to_vec()
}

/// `responsiveWebpFfmpegArgs`: never wider than the source.
pub fn responsive_webp_ffmpeg_args(source: &str, output: &str, width: u32) -> Vec<String> {
    let scale = format!("scale='min({width},iw)':-2");
    [
        "-y", "-i", source, "-vf", &scale, "-c:v", "libwebp", "-quality", "80", output,
    ]
    .map(str::to_owned)
    .to_vec()
}

async fn ffmpeg(args: &[String]) -> Result<(), String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run_ffmpeg(&args, FFMPEG_TIMEOUT).await.map_err(|error| error.0)
}

async fn make_public(file: &Path) -> Result<(), String> {
    tokio::fs::set_permissions(file, std::fs::Permissions::from_mode(PUBLIC_FILE_MODE))
        .await
        .map_err(io_message)
}

/// `materializeSiteMedia`: the delivery projection that copies publication
/// media into the public site, one stable file per position.
pub async fn materialize_site_media(
    ctx: &AdapterContext,
    post_id: i64,
    locale: Locale,
    source: &[MediaItem],
) -> Result<Vec<MediaItem>, String> {
    let config = &*ctx.config;
    let public_dir = text(&config.site_public_dir);
    let directory = PathBuf::from(public_site::paths::join(
        &public_dir,
        &SITE_MEDIA_DIR_SEGMENTS.join("/"),
    ));
    let media_root = PathBuf::from(public_site::paths::join(&public_dir, "media"));
    tokio::fs::create_dir_all(&directory).await.map_err(io_message)?;
    let mut result = Vec::with_capacity(source.len());
    for (index, item) in source.iter().enumerate() {
        let declared = item
            .get("type")
            .filter(|value| !value.is_null())
            .map_or_else(|| "image".to_owned(), javascript_string);
        let video = declared.to_lowercase() == "video";
        let extension = media_extension(item, video);
        let filename = site_media_filename(post_id, locale, index, &extension);
        let target = directory.join(&filename);
        copy_or_download(ctx, item, &target).await?;
        make_public(&target).await?;
        deduplicate_site_media_file(&media_root, &target)
            .await
            .map_err(io_message)?;
        let mut output = item.clone();
        output.insert("type".into(), if video { "video" } else { "image" }.into());
        // Public media is intentionally long-lived in browser/CDN caches. A
        // content version keeps a replacement from reusing the previous URL;
        // articles keep the upload in its original proportions.
        output.insert(
            "path".into(),
            versioned_public_path(&format!("{SITE_MEDIA_URL_PREFIX}/{filename}"), &target)
                .await?
                .into(),
        );
        if video {
            let poster_name = site_media_poster_filename(post_id, locale, index);
            let poster = directory.join(&poster_name);
            let temporary = temporary_path(&poster);
            let drawn = async {
                ffmpeg(&site_poster_ffmpeg_args(&text(&target), &text(&temporary))).await?;
                tokio::fs::rename(&temporary, &poster).await.map_err(io_message)
            }
            .await;
            let _ = tokio::fs::remove_file(&temporary).await;
            drawn?;
            make_public(&poster).await?;
            deduplicate_site_media_file(&media_root, &poster)
                .await
                .map_err(io_message)?;
            materialize_responsive_variants(config, &poster).await?;
            output.insert(
                "poster".into(),
                versioned_public_path(&format!("{SITE_MEDIA_URL_PREFIX}/{poster_name}"), &poster)
                    .await?
                    .into(),
            );
        } else {
            materialize_responsive_variants(config, &target).await?;
        }
        result.push(output);
    }
    Ok(result)
}

/// `String(value)` for the scalar a `type` field holds.
fn javascript_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

async fn versioned_public_path(public_path: &str, file: &Path) -> Result<String, String> {
    let digest = sha256_file(file).await.map_err(io_message)?;
    Ok(format!("{public_path}?v={}", &digest[..12]))
}

/// One responsive derivative of a site image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResponsiveVariant {
    pub width: u32,
    pub file: PathBuf,
}

fn responsive_directory(config: &Config) -> PathBuf {
    PathBuf::from(public_site::paths::join(
        &text(&config.site_public_dir),
        "generated/responsive",
    ))
}

/// `responsiveVariantPaths`: where the variants of a PNG or JPEG under the
/// public directory live; nothing for any other file. The web route only
/// serves these files: spawning ffmpeg while handling visitors let a
/// cache-miss burst exhaust the small production container.
pub fn responsive_variant_paths(config: &Config, source: &Path) -> Result<Vec<ResponsiveVariant>, String> {
    let name = text(source);
    let lower = name.to_ascii_lowercase();
    if ![".png", ".jpg", ".jpeg"]
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        return Ok(Vec::new());
    }
    let root = public_site::paths::resolve(&text(&config.site_public_dir), "");
    let resolved = public_site::paths::resolve(&name, "");
    let relative = if resolved == root {
        ""
    } else {
        resolved
            .strip_prefix(root.trim_end_matches('/'))
            .and_then(|rest| rest.strip_prefix('/'))
            .ok_or_else(|| "site media source escapes public directory".to_owned())?
    };
    let flattened = relative.replace(['\\', '/'], "-");
    let basename = match flattened.rfind('.') {
        Some(dot)
            if dot + 1 < flattened.len() && flattened[dot + 1..].bytes().all(|byte| byte.is_ascii_alphanumeric()) =>
        {
            &flattened[..dot]
        }
        _ => flattened.as_str(),
    };
    let directory = responsive_directory(config);
    Ok(RESPONSIVE_WIDTHS
        .iter()
        .map(|&width| ResponsiveVariant {
            width,
            file: directory.join(format!("{basename}-{width}.webp")),
        })
        .collect())
}

/// `materializeResponsiveVariants`: the variants made before a post is
/// exposed in the public feed, skipping the ones already current.
pub async fn materialize_responsive_variants(config: &Config, source: &Path) -> Result<(), String> {
    let variants = responsive_variant_paths(config, source)?;
    if variants.is_empty() {
        return Ok(());
    }
    tokio::fs::create_dir_all(responsive_directory(config))
        .await
        .map_err(io_message)?;
    for variant in variants {
        // A WebP derivative is intentionally a different size from its source.
        // Comparing sizes here made every site build regenerate every
        // responsive image in the archive and blocked newly published posts
        // behind that needless work. Source mtime is the freshness key.
        if is_current_derivative(source, &variant.file).await {
            continue;
        }
        // A scratch name, not a recorded instant: the wall clock only keeps
        // two builds of one variant from sharing it.
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis());
        let temporary = PathBuf::from(format!(
            "{}.tmp-{}-{stamp}.webp",
            text(&variant.file),
            std::process::id()
        ));
        let made = async {
            ffmpeg(&responsive_webp_ffmpeg_args(
                &text(source),
                &text(&temporary),
                variant.width,
            ))
            .await?;
            make_public(&temporary).await?;
            tokio::fs::rename(&temporary, &variant.file).await.map_err(io_message)
        }
        .await;
        let _ = tokio::fs::remove_file(&temporary).await;
        made?;
    }
    Ok(())
}

fn media_extension(item: &MediaItem, video: bool) -> String {
    let source = first_of(item, &["local_path", "localPath", "path"]);
    if video {
        let extension = file_extension(source);
        return if matches!(extension.as_str(), ".mp4" | ".mov" | ".webm") {
            extension[1..].to_owned()
        } else {
            "mp4".into()
        };
    }
    image_extension(source).unwrap_or(".jpg")[1..].to_owned()
}

async fn copy_or_download(ctx: &AdapterContext, item: &MediaItem, target: &Path) -> Result<(), String> {
    let config = &*ctx.config;
    let local = first_of(item, &["local_path", "localPath"]);
    if !local.is_empty() && Path::new(local).exists() {
        if !is_current_copy(Path::new(local), target).await {
            copy_file_atomically(Path::new(local), target)
                .await
                .map_err(io_message)?;
        }
        return Ok(());
    }
    let existing = string_field(item, "path");
    if !existing.is_empty() {
        let absolute = if existing.starts_with('/') {
            PathBuf::from(existing)
        } else {
            PathBuf::from(public_site::paths::join(
                &text(&config.site_public_dir),
                existing.trim_start_matches('/'),
            ))
        };
        if absolute.exists() {
            if !is_current_copy(&absolute, target).await {
                copy_file_atomically(&absolute, target).await.map_err(io_message)?;
            }
            return Ok(());
        }
    }
    let file_id = first_of(item, &["file_id", "fileId"]);
    if file_id.is_empty() {
        return Err("site media has no file_id or local path".into());
    }
    materialize_telegram_file(
        &ctx.client,
        config,
        TelegramFileSource::FileId(file_id),
        MaterializeOptions {
            target: Some(target),
            ..MaterializeOptions::default()
        },
    )
    .await
    .map(drop)
    .map_err(|error| error.to_string())
}

/// `stat.mtimeMs`, as Node computes it.
async fn mtime_ms(file: &Path) -> Option<(u64, f64)> {
    let metadata = tokio::fs::metadata(file).await.ok()?;
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some((
        metadata.len(),
        modified.as_secs() as f64 * 1000.0 + f64::from(modified.subsec_nanos()) / 1e6,
    ))
}

async fn is_current_copy(source: &Path, target: &Path) -> bool {
    if public_site::paths::resolve(&text(source), "") == public_site::paths::resolve(&text(target), "") {
        return true;
    }
    match (mtime_ms(source).await, mtime_ms(target).await) {
        (Some((source_size, source_mtime)), Some((target_size, target_mtime))) => {
            source_size == target_size && target_mtime >= source_mtime
        }
        _ => false,
    }
}

/// Responsive derivatives are current when they are no older than their source.
async fn is_current_derivative(source: &Path, target: &Path) -> bool {
    match (mtime_ms(source).await, mtime_ms(target).await) {
        (Some((_, source_mtime)), Some((_, target_mtime))) => target_mtime >= source_mtime,
        _ => false,
    }
}
