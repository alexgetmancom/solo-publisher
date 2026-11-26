//! The only client of the vertical
//! media processor on the other host. Callers name the variants they consume;
//! upload, manifest validation and atomic downloads are the same for site and
//! social delivery.

use std::path::{Path, PathBuf};
use std::time::Duration;

use runtime::http::{Body, BodyPart, ExternalHttpError, HttpRequest};
use runtime::timeout::with_timeout;
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncReadExt as _;

use crate::error::{AdapterError, Result};
use crate::ports::AdapterContext;

const VERTICAL_MEDIA_RECIPE: &str = "vertical-variants-v6";
const VERTICAL_MEDIA_TRANSFORM: &str = "story_vertical";
const VARIANT_TIMEOUT: Duration = Duration::from_secs(30);
const DETAIL_UNITS: usize = 800;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
}

impl MediaKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
        }
    }
}

/// One output the caller consumes: the processor's variant name and where
/// the file lands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Variant {
    pub name: String,
    pub output: PathBuf,
}

/// `processVerticalMediaRemotely`: the transform manifest, every named
/// variant written to its output.
pub async fn process_vertical_media_remotely(
    ctx: &AdapterContext,
    source: &Path,
    kind: MediaKind,
    variants: &[Variant],
    timeout: Duration,
) -> Result<Value> {
    let (Some(base), Some(token)) = (
        ctx.config.media_processor_url.as_deref().filter(|url| !url.is_empty()),
        ctx.config
            .media_processor_token
            .as_deref()
            .filter(|token| !token.is_empty()),
    ) else {
        return Err(AdapterError::message_text(
            "media_processor_unavailable: remote_http requires MEDIA_PROCESSOR_URL and MEDIA_PROCESSOR_TOKEN",
        ));
    };
    let io = |error: std::io::Error| AdapterError::Message(error.to_string());
    let size = tokio::fs::metadata(source).await.map_err(io)?.len();
    let key = media_transform_key(source, &format!("{VERTICAL_MEDIA_RECIPE}:{}", kind.as_str()))
        .await
        .map_err(io)?;
    let base = base.strip_suffix('/').unwrap_or(base);
    let output_name = variants.first().map_or(source, |variant| variant.output.as_path());
    let request = HttpRequest::post(format!("{base}/v1/transforms/ffmpeg"))
        .header("authorization", format!("Bearer {token}"))
        .header("content-length", size.to_string())
        .header(
            "content-type",
            match kind {
                MediaKind::Video => "video/mp4",
                MediaKind::Image => "image/jpeg",
            },
        )
        .header("x-studio-transform", VERTICAL_MEDIA_TRANSFORM)
        .header("x-studio-media-kind", kind.as_str())
        .header("x-studio-output-name", file_name(output_name))
        .header("x-studio-idempotency-key", key.clone())
        .body(Body(vec![BodyPart::File {
            path: source.to_owned(),
            offset: 0,
        }]))
        .deadline(timeout);
    let timed_out = || {
        AdapterError::Message(format!(
            "media_processor_timeout: remote worker exceeded {}s",
            timeout.as_millis().div_ceil(1000)
        ))
    };
    let response = match with_timeout(ctx.client.exchange(request), timeout, "media_processor_upload_timeout").await {
        Err(_) => return Err(timed_out()),
        Ok(Err(failure)) if failure.timed_out => return Err(timed_out()),
        Ok(Err(failure)) => return Err(AdapterError::Message(failure.message)),
        Ok(Ok(response)) => response,
    };
    if !response.ok() {
        let status = response.status;
        let retry_after = response
            .headers
            .get("retry-after")
            .map(|header| foundation::js::number(&header))
            .filter(|seconds| seconds.is_finite());
        let text = response.text().await?;
        let detail = foundation::js::utf16_prefix(&text, DETAIL_UNITS);
        return Err(AdapterError::Http(ExternalHttpError {
            message: if detail.is_empty() {
                format!("media_processor_failed: {status}")
            } else {
                format!("media_processor_failed: {status} {detail}")
            },
            status,
            body: Some(detail.to_owned()),
            retry_after_seconds: retry_after,
        }));
    }
    if !response
        .headers
        .get("content-type")
        .is_some_and(|content_type| content_type.contains("application/json"))
    {
        return Err(AdapterError::message_text(
            "media_processor_failed: expected a JSON transform manifest",
        ));
    }
    let manifest = crate::error::parse_json(&response.text().await?)?;
    if let Some(missing) = variants.iter().find(|variant| {
        !manifest
            .get("outputs")
            .and_then(|outputs| outputs.get(&variant.name))
            .is_some_and(foundation::js::truthy)
    }) {
        return Err(AdapterError::Message(format!(
            "media_processor_failed: missing {} output",
            missing.name
        )));
    }

    for variant in variants {
        let request = HttpRequest::get(format!("{base}/v1/transforms/ffmpeg/{key}/{}", variant.name))
            .header("authorization", format!("Bearer {token}"))
            .deadline(VARIANT_TIMEOUT);
        let download = with_timeout(
            ctx.client.exchange(request),
            VARIANT_TIMEOUT,
            "media_processor_variant_download_timeout",
        )
        .await?
        .map_err(|failure| AdapterError::Message(failure.message))?;
        if !download.ok() {
            return Err(AdapterError::Message(format!(
                "media_processor_variant_failed: {} {}",
                variant.name, download.status
            )));
        }
        with_timeout(
            write_atomically(&variant.output, download),
            VARIANT_TIMEOUT,
            "media_processor_variant_write_timeout",
        )
        .await??;
        with_timeout(
            set_mode(&variant.output),
            VARIANT_TIMEOUT,
            "media_processor_variant_finalize_timeout",
        )
        .await?
        .map_err(io)?;
    }
    Ok(manifest)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned())
}

/// `mediaTransformKey`: identical bytes under the same recipe are one
/// derivative, whatever path or host they come from.
pub async fn media_transform_key(source: &Path, recipe: &str) -> std::io::Result<String> {
    let mut hash = Sha256::new();
    hash.update(recipe.as_bytes());
    hash.update([0]);
    let mut file = tokio::fs::File::open(source).await?;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// `writeResponseAtomically`: into a temporary sibling, then renamed.
async fn write_atomically(target: &Path, response: runtime::http::Response) -> Result<()> {
    let temporary = temporary_path(target);
    let written = async {
        response.save(&temporary).await?;
        tokio::fs::rename(&temporary, target)
            .await
            .map_err(|error| AdapterError::Message(error.to_string()))
    }
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    written
}

/// `.<stem>.tmp-<pid>-<random><ext>` beside the target.
fn temporary_path(target: &Path) -> PathBuf {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the operating system has no randomness source");
    let random: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let stem = target
        .file_stem()
        .map_or_else(String::new, |stem| stem.to_string_lossy().into_owned());
    let extension = target
        .extension()
        .map_or_else(String::new, |extension| format!(".{}", extension.to_string_lossy()));
    target.with_file_name(format!(".{stem}.tmp-{}-{random}{extension}", std::process::id()))
}

async fn set_mode(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o664)).await
}
