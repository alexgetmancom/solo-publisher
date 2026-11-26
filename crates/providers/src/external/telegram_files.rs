//! One Telegram file onto local disk, by its `file_id` or by the path `getFile`
//! already answered.

use std::path::{Path, PathBuf};

use foundation::config::Config;
use serde_json::{Value, json};

use super::telegram::{BotApi, BotParams, TELEGRAM_DOWNLOAD_TIMEOUT};
use runtime::http::{ExternalError, HttpClient};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TelegramFileSource<'a> {
    FileId(&'a str),
    /// What `getFile` answered: relative on the cloud Bot API, absolute on a
    /// local Bot API server that shares its volume.
    FilePath(&'a str),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MaterializeOptions<'a> {
    /// The bot that can read the file; the controller bot when absent.
    pub token: Option<&'a str>,
    /// Where the file must end up. Without one it lands in the bounded
    /// incoming directory, for the caller to import and discard.
    pub target: Option<&'a Path>,
    /// The incoming file's extension; the remote path's when absent.
    pub extension: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Materialized {
    pub path: PathBuf,
    /// The caller removes it once imported.
    pub temporary: bool,
}

/// Brings the file onto local disk.
pub async fn materialize_telegram_file(
    client: &HttpClient,
    config: &Config,
    source: TelegramFileSource<'_>,
    options: MaterializeOptions<'_>,
) -> Result<Materialized, ExternalError> {
    let token = options
        .token
        .filter(|token| !token.is_empty())
        .or(config.controller_bot_token.as_deref().filter(|token| !token.is_empty()))
        .ok_or_else(|| ExternalError::message("Telegram bot token is not configured."))?;
    let api = BotApi::new(client.clone(), &config.telegram_api_base_url, token);
    let file_path = match source {
        TelegramFileSource::FilePath(path) => path.to_owned(),
        TelegramFileSource::FileId(file_id) => telegram_file_path(&api, file_id).await?,
    };
    if Path::new(&file_path).is_absolute() && options.target.is_none() {
        return Ok(Materialized {
            path: PathBuf::from(file_path),
            temporary: false,
        });
    }
    let target = match options.target {
        Some(target) => target.to_owned(),
        None => config.studio_media_dir.join(".incoming").join(format!(
            "telegram-media-{}{}",
            random_uuid(),
            options.extension.unwrap_or_else(|| extname(&file_path))
        )),
    };
    place(&api, &file_path, &target).await?;
    Ok(Materialized {
        path: target,
        temporary: options.target.is_none(),
    })
}

async fn place(api: &BotApi, file_path: &str, target: &Path) -> Result<(), ExternalError> {
    let io = |error: std::io::Error| ExternalError::message(error.to_string());
    tokio::fs::create_dir_all(target.parent().unwrap_or(Path::new("/")))
        .await
        .map_err(io)?;
    let temporary = PathBuf::from(format!(
        "{}.tmp-{}-{}",
        target.display(),
        std::process::id(),
        random_uuid()
    ));
    let placed = async {
        if Path::new(file_path).is_absolute() {
            tokio::fs::copy(file_path, &temporary).await.map_err(io)?;
        } else {
            let response = api
                .download(file_path, TELEGRAM_DOWNLOAD_TIMEOUT)
                .await
                .map_err(|failure| {
                    ExternalError::message(if failure.timed_out {
                        format!(
                            "Telegram file download timed out after {}s.",
                            TELEGRAM_DOWNLOAD_TIMEOUT.as_secs()
                        )
                    } else {
                        "Telegram file download failed.".to_owned()
                    })
                })?;
            if !response.ok() {
                return Err(ExternalError::message(format!(
                    "Telegram file download failed: {}",
                    response.status
                )));
            }
            response.save(&temporary).await?;
        }
        tokio::fs::rename(&temporary, target).await.map_err(io)
    }
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    placed
}

async fn telegram_file_path(api: &BotApi, file_id: &str) -> Result<String, ExternalError> {
    let info = api
        .request_json("getFile", BotParams::json(json!({"file_id": file_id}).to_string()))
        .await?;
    let ok = info.get("ok").is_some_and(foundation::js::truthy);
    match info.pointer("/result/file_path") {
        Some(Value::String(path)) if ok && !path.is_empty() => Ok(path.clone()),
        _ => Err(ExternalError::message(format!("Telegram getFile failed for {file_id}"))),
    }
}

/// `path.extname`: the last segment's extension with its dot, `""` for none
/// or for a leading-dot name.
fn extname(path: &str) -> &str {
    let name = path.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
    match name.rfind('.') {
        Some(index) if index > 0 && name != ".." => &name[index..],
        _ => "",
    }
}

/// `crypto.randomUUID()`: a version 4 UUID in lowercase hex.
fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the operating system has no randomness source");
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

#[cfg(test)]
mod tests {
    use super::extname;

    #[test]
    fn extname_follows_node() {
        for (path, expected) in [
            ("photos/file_1.jpg", ".jpg"),
            ("videos/file", ""),
            ("a/.bashrc", ""),
            ("a.", "."),
            ("..", ""),
            ("dir.d/file", ""),
            ("x/y.tar.gz", ".gz"),
        ] {
            assert_eq!(extname(path), expected, "{path}");
        }
    }
}
