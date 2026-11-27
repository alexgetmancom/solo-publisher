//! Telegram files into Content ownership: the download from Telegram and the import.
//!
//! Nothing about publication targets is decided here. What a file is *for* is
//! the draft's business, and the Story shapes are made when a draft says it
//! publishes one.

use std::path::{Path, PathBuf};
use std::time::Instant;

use content::assets::STUDIO_MEDIA_MAX_BYTES;
use content::message::MediaItem;
use domain::application::ports::StudioMediaAssetRecord;
use domain::studio::services::media::{ImportedMediaFile, MediaService, MediaSource};
use foundation::config::Config;
use providers::external::telegram::TELEGRAM_DOWNLOAD_TIMEOUT;
use serde_json::Value;

use crate::api::Api;
use crate::tap;

/// `importTelegramMedia`: every item that is still only a Telegram file id
/// becomes a Content asset, in order; an item that already is one is kept.
pub async fn import_telegram_media(
    api: &Api,
    media_service: MediaService<'_>,
    config: &Config,
    actor_id: i64,
    media: &[MediaItem],
) -> crate::Result<Vec<MediaItem>> {
    let mut imported = Vec::with_capacity(media.len());
    for item in media {
        imported.push(import_item(api, media_service, config, actor_id, item).await?);
    }
    Ok(imported)
}

fn present(item: &MediaItem, key: &str) -> bool {
    item.get(key).is_some_and(|value| !value.is_null())
}

fn non_empty_string<'a>(item: &'a MediaItem, key: &str) -> Option<&'a str> {
    item.get(key).and_then(Value::as_str).filter(|value| !value.is_empty())
}

async fn import_item(
    api: &Api,
    media_service: MediaService<'_>,
    config: &Config,
    actor_id: i64,
    item: &MediaItem,
) -> crate::Result<MediaItem> {
    if present(item, "asset_id") || present(item, "local_path") || present(item, "localPath") {
        return Ok(item.clone());
    }
    let file_id = non_empty_string(item, "file_id")
        .or_else(|| non_empty_string(item, "fileId"))
        .ok_or_else(|| crate::error("Telegram media item has no file id."))?;
    let file = api.get_file(file_id).await?;
    let file_path = file
        .file_path
        .ok_or_else(|| crate::error("Telegram did not return a media file path."))?;
    let kind = match item.get("type") {
        None | Some(Value::Null) => "photo".to_owned(),
        Some(value) => value.as_str().unwrap_or_default().to_lowercase(),
    };
    let (extension, content_type) = if kind == "video" {
        (".mp4", "video/mp4")
    } else {
        (".jpg", "image/jpeg")
    };
    let asset = import_telegram_asset(
        api,
        media_service,
        config,
        actor_id,
        &file_path,
        &AssetFile {
            extension,
            filename: &format!("telegram-{file_id}{extension}"),
            content_type,
        },
    )
    .await?;
    let mut imported = item.clone();
    imported.insert("asset_id".into(), asset.id.into());
    imported.insert("local_path".into(), asset.asset.local_path.into());
    imported.insert("filename".into(), asset.asset.filename.into());
    imported.insert("mime_type".into(), asset.asset.mime_type.into());
    Ok(imported)
}

/// How one Telegram file is named and typed once it is a Content asset.
pub struct AssetFile<'a> {
    pub extension: &'a str,
    pub filename: &'a str,
    pub content_type: &'a str,
}

/// `importTelegramAsset`: one Telegram file into Content ownership; only the
/// temporary download made for it is removed afterwards.
pub async fn import_telegram_asset(
    api: &Api,
    media_service: MediaService<'_>,
    config: &Config,
    actor_id: i64,
    file_path: &str,
    file: &AssetFile<'_>,
) -> crate::Result<StudioMediaAssetRecord> {
    let (path, temporary) = materialize_telegram_file(api, config, file_path, file.extension).await?;
    let imported = media_service.import_file(
        actor_id,
        &ImportedMediaFile {
            filename: file.filename,
            content_type: file.content_type,
            local_path: &path,
            byte_size: None,
            source: MediaSource::TelegramUpload,
        },
    );
    if temporary {
        let _ = std::fs::remove_file(&path);
    }
    Ok(imported?)
}

/// `materializeTelegramFile` for a path `getFile` answered: an absolute one
/// (a local Bot API server) is the file itself; a relative one is downloaded
/// into the bounded incoming directory, for the caller to import and discard.
pub async fn materialize_telegram_file(
    api: &Api,
    config: &Config,
    file_path: &str,
    extension: &str,
) -> crate::Result<(PathBuf, bool)> {
    if config.controller_bot_token.as_deref().is_none_or(str::is_empty) {
        return Err(crate::error("Telegram bot token is not configured."));
    }
    if Path::new(file_path).is_absolute() {
        return Ok((PathBuf::from(file_path), false));
    }
    let target = config
        .studio_media_dir
        .join(".incoming")
        .join(format!("telegram-media-{}{extension}", random_uuid()));
    // The download is a Telegram call no Bot API transformer sees, so it is
    // billed to the update here; the clock starts once the path is known.
    let started = Instant::now();
    let result = download_to(api, file_path, &target).await;
    tap::record_api_call("downloadFile", started.elapsed().as_secs_f64() * 1000.0);
    result?;
    Ok((target, true))
}

async fn download_to(api: &Api, file_path: &str, target: &Path) -> crate::Result<()> {
    std::fs::create_dir_all(target.parent().expect("joined under a directory"))?;
    let downloaded = api
        .download_file(file_path, STUDIO_MEDIA_MAX_BYTES, TELEGRAM_DOWNLOAD_TIMEOUT)
        .await
        .map_err(|_| crate::error("Telegram file download failed."))?;
    if !(200..300).contains(&downloaded.status) {
        return Err(crate::error(format!(
            "Telegram file download failed: {}",
            downloaded.status
        )));
    }
    let temporary = PathBuf::from(format!(
        "{}.tmp-{}-{}",
        target.display(),
        std::process::id(),
        random_uuid()
    ));
    let written = std::fs::write(&temporary, &downloaded.body).and_then(|()| std::fs::rename(&temporary, target));
    let _ = std::fs::remove_file(&temporary);
    Ok(written?)
}

/// `crypto.randomUUID()`: a version 4 UUID in lowercase hex.
fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the system has randomness");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
