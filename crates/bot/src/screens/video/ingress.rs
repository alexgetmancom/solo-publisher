//! A Telegram upload into Content storage.

use std::path::Path;
use std::time::Instant;

use foundation::errors::StudioError;
use foundation::logger::{LogLevel, log};
use serde_json::{Value, json};

use crate::Fut;
use crate::api::ApiError;
use crate::context::Ctx;
use crate::media_ingress::{AssetFile, import_telegram_asset};
use crate::registry::TelegramVideoFile;

/// The intake's side: the file it captured when the operator sent it.
pub fn store_intake_video<'a>(ctx: &'a Ctx, file: &'a TelegramVideoFile) -> Fut<'a, crate::Result<i64>> {
    Box::pin(store_telegram_video(ctx, ctx.actor_id(), Some(file)))
}

/// `storeTelegramVideo`: the captured file, or the video or document of the
/// message being handled, as a Content video asset; returns its id.
pub async fn store_telegram_video(ctx: &Ctx, actor_id: i64, source: Option<&TelegramVideoFile>) -> crate::Result<i64> {
    if ctx.config.controller_bot_token.as_deref().is_none_or(str::is_empty) {
        return Err(crate::error("Telegram bot token is not configured."));
    }
    let message = ctx.update.message.as_ref();
    let video = message.and_then(|message| message.video.as_ref());
    let document = message.and_then(|message| message.document.as_ref());
    let file = match source {
        Some(source) => Some(source.clone()),
        None => video.or(document).map(|file| TelegramVideoFile {
            file_id: file.file_id.clone(),
            name: file.file_name.clone().unwrap_or_default(),
            mime: file.mime_type.clone().unwrap_or_default(),
            size_bytes: file.file_size,
        }),
    };
    let Some(file) = file else {
        return Err(StudioError::new("err.send-mp4").into());
    };
    // A document is only a video when it says so; a `video` message already is one.
    let declared = source.is_some() || video.is_some();
    if !declared && !file.mime.starts_with("video/") && !file.name.to_lowercase().ends_with(".mp4") {
        return Err(StudioError::new("err.only-video").into());
    }
    let details = |extra: Value| {
        let mut details = json!({
            "updateId": ctx.update.update_id,
            "filename": file.name,
            "sizeBytes": file.size_bytes,
        });
        if let (Some(details), Value::Object(extra)) = (details.as_object_mut(), extra) {
            details.extend(extra);
        }
        details
    };
    let started = Instant::now();
    let file_path = match ctx.bot.api().get_file(&file.file_id).await {
        Ok(api_file) => {
            let Some(file_path) = api_file.file_path else {
                return Err(crate::error("Telegram did not return a file path."));
            };
            log(
                LogLevel::Info,
                "Telegram video getFile completed",
                Some(details(json!({
                    "sizeBytes": api_file.file_size.or(file.size_bytes),
                    "durationMs": started.elapsed().as_millis() as u64,
                    "localFile": Path::new(&file_path).is_absolute(),
                }))),
            );
            file_path
        }
        Err(error) => {
            let (code, description) = match &error {
                ApiError::Telegram(failure) => (Some(failure.error_code), failure.description.clone()),
                other => (None, other.js_string()),
            };
            log(
                LogLevel::Warn,
                "Telegram video getFile failed",
                Some(details(json!({
                    "durationMs": started.elapsed().as_millis() as u64,
                    "errorCode": code,
                    "error": description,
                }))),
            );
            return Err(error.into());
        }
    };
    let extension = match node_extname(&file.name) {
        "" => ".mp4".to_owned(),
        extension => extension.to_lowercase(),
    };
    let filename = if file.name.is_empty() {
        format!("telegram-video{extension}")
    } else {
        file.name.clone()
    };
    let content_type = if file.mime.is_empty() { "video/mp4" } else { &file.mime };
    let asset = import_telegram_asset(
        ctx.bot.api(),
        ctx.services().media,
        &ctx.config,
        actor_id,
        &file_path,
        &AssetFile {
            extension: &extension,
            filename: &filename,
            content_type,
        },
    )
    .await?;
    if asset.asset.kind != "video" {
        return Err(StudioError::new("err.only-mp4").into());
    }
    Ok(asset.id)
}

/// `path.extname`: from the last dot of the last segment, unless that dot
/// starts the name.
fn node_extname(name: &str) -> &str {
    let base = name.rsplit('/').next().unwrap_or(name);
    match base.rfind('.') {
        Some(0) | None => "",
        Some(index) => &base[index..],
    }
}

#[cfg(test)]
mod tests {
    use super::node_extname;

    #[test]
    fn extensions_read_as_node_reads_them() {
        assert_eq!(node_extname("clip.MP4"), ".MP4");
        assert_eq!(node_extname(".hidden"), "");
        assert_eq!(node_extname("a."), ".");
        assert_eq!(node_extname("dir.v/clip"), "");
        assert_eq!(node_extname(""), "");
    }
}
