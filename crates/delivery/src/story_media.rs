//! One source file into the Story shapes — a
//! 1080×1920 standard render and, for a video, a Telegram variant that fits
//! its upload ceiling — on this host with the software encoder
//! (`vertical_media`), or on the remote media processor.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use foundation::config::{Config, MediaProcessorProvider};
use foundation::logger::{LogLevel, log};
use providers::adapters::AdapterContext;
use providers::adapters::remote_media_processor::{MediaKind, Variant, process_vertical_media_remotely};
use runtime::ffmpeg::FFPROBE_TIMEOUT;
use runtime::ffmpeg::{FFMPEG_TIMEOUT, probe_media_metadata, run_ffmpeg};
use runtime::timeout::with_timeout;
use serde_json::{Value, json};
use vertical_media::{
    Encoder, STORY_MAX_DURATION_SECONDS, needs_vertical_blur, story_ffmpeg_args, telegram_video_kbps,
    vertical_image_ffmpeg_args,
};

use crate::site_media_storage::temporary_path;

const FINALIZE_TIMEOUT: Duration = Duration::from_secs(30);

/// `storyDirectory`: where durable Story derivatives live.
pub fn story_directory(config: &Config) -> PathBuf {
    Path::new(&config.data_dir).join("story-media")
}

/// `renderStoryVariants`: ingress, the backfill and the repair all reach the
/// recipe through here — the same transform, timeout and permissions.
pub async fn render_story_variants(
    ctx: &AdapterContext,
    source: &Path,
    output: &Path,
    telegram_output: Option<&Path>,
    video: bool,
) -> Result<(), String> {
    if ctx.config.media_processor_provider == MediaProcessorProvider::RemoteHttp {
        transform_remotely(ctx, source, output, telegram_output, video).await
    } else {
        transform_locally(&ctx.config, source, output, telegram_output, video).await
    }
}

/// The local executor, deciding the blurred backdrop from the probed frame as
/// the remote one does, and encoding beside each name so a killed encode never
/// leaves a truncated file under the name that means "ready".
async fn transform_locally(
    config: &Config,
    source: &Path,
    output: &Path,
    telegram_output: Option<&Path>,
    video: bool,
) -> Result<(), String> {
    if video && telegram_output.is_none() {
        return Err("story_variant_missing_telegram_output: a Story video is two files, not one".into());
    }
    let metadata = probe_media_metadata(&source.to_string_lossy(), FFPROBE_TIMEOUT)
        .await
        .map_err(|error| error.to_string())?;
    let blur = needs_vertical_blur(metadata.width, metadata.height);
    // A probe with no duration would divide the Telegram budget by zero.
    let duration = if metadata.duration_seconds == 0.0 || metadata.duration_seconds.is_nan() {
        STORY_MAX_DURATION_SECONDS
    } else {
        metadata.duration_seconds
    };
    let targets: Vec<&Path> = std::iter::once(output).chain(telegram_output).collect();
    let partials: HashMap<&Path, PathBuf> = targets.iter().map(|target| (*target, temporary_path(target))).collect();
    let partial = |target: &Path| partials.get(target).cloned().unwrap_or_else(|| target.to_owned());
    let args = match telegram_output {
        Some(telegram) if video => story_ffmpeg_args(
            Encoder::Software,
            source,
            &partial(output),
            &partial(telegram),
            telegram_video_kbps(duration, metadata.audio_bitrate.unwrap_or(0.0)),
            blur,
        ),
        _ => vertical_image_ffmpeg_args(source, &partial(output), blur),
    };
    let rendered = async {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        with_timeout(
            run_ffmpeg(&args, FFMPEG_TIMEOUT),
            story_transform_timeout(config),
            "story_transform_timeout",
        )
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
        for target in &targets {
            let finalize = async {
                tokio::fs::set_permissions(partial(target), std::fs::Permissions::from_mode(0o664)).await?;
                tokio::fs::rename(partial(target), target).await
            };
            with_timeout(finalize, FINALIZE_TIMEOUT, "story_output_finalize_timeout")
                .await
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    .await;
    for target in &targets {
        let _ = tokio::fs::remove_file(partial(target)).await;
    }
    rendered
}

/// The media processing port: a configured remote worker owns the heavy
/// ffmpeg work and writes the variants back.
async fn transform_remotely(
    ctx: &AdapterContext,
    source: &Path,
    output: &Path,
    telegram_output: Option<&Path>,
    video: bool,
) -> Result<(), String> {
    let bytes = tokio::fs::metadata(source)
        .await
        .map_err(|error| error.to_string())?
        .len();
    let timeout = story_transform_timeout(&ctx.config);
    let timeout_seconds = timeout.as_secs_f64();
    log(
        LogLevel::Info,
        "story media remote upload started",
        Some(json!({"source": source, "bytes": bytes, "timeoutSeconds": timeout_seconds})),
    );
    let mut variants = vec![Variant {
        name: "standard".into(),
        output: output.to_owned(),
    }];
    if let (true, Some(telegram)) = (video, telegram_output) {
        variants.push(Variant {
            name: "telegram".into(),
            output: telegram.to_owned(),
        });
    }
    let kind = if video { MediaKind::Video } else { MediaKind::Image };
    let result = process_vertical_media_remotely(ctx, source, kind, &variants, timeout)
        .await
        .map_err(|error| error.to_string())?;
    let mut details = json!({
        "source": source,
        "phase": "media_processor.external",
        "providerRequestId": result.get("requestId").or_else(|| result.get("job")).cloned().unwrap_or(Value::Null),
    });
    if let (Some(details), Some(Value::Object(timings))) = (details.as_object_mut(), result.get("timings")) {
        details.extend(timings.clone());
    }
    log(LogLevel::Info, "story media remote processing completed", Some(details));
    Ok(())
}

/// Leaves time for the provider publication and the durable finalization
/// before the queue's own deadline.
fn story_transform_timeout(config: &Config) -> Duration {
    let media = config.media_processor_timeout_seconds.saturating_mul(1000) as i64;
    let queue = (config.publish_job_timeout_seconds as i64 - 30) * 1000;
    Duration::from_millis(media.min(queue).max(10_000) as u64)
}
