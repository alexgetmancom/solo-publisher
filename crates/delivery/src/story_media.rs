//! `delivery/story-media.ts` and the local half of
//! `deploy/media-processor/story-encode.ts`: one source file into the Story
//! shapes — a 1080×1920 standard render and, for a video, a Telegram variant
//! that fits its upload ceiling — on this host or on the remote processor.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use adapters::AdapterContext;
use adapters::remote_media_processor::{MediaKind, Variant, process_vertical_media_remotely};
use foundation::config::{Config, MediaProcessorProvider};
use foundation::logger::{LogLevel, log};
use runtime::ffmpeg::{FFMPEG_TIMEOUT, probe_media_metadata, run_ffmpeg};
use runtime::ffmpeg::FFPROBE_TIMEOUT;
use runtime::timeout::with_timeout;
use serde_json::{Value, json};

use crate::site_media_storage::temporary_path;

/// AAC packets can extend the muxed duration past the cutoff; the margin keeps
/// the finished MP4 within the 59-second Story contract.
pub const STORY_MAX_DURATION_SECONDS: f64 = 58.9;
const VERTICAL_ASPECT_RATIO: f64 = 9.0 / 16.0;
/// Within five percent of 9:16, a plain contain render.
const VERTICAL_ASPECT_TOLERANCE: f64 = 0.05;
const VERTICAL_SCALE_FILTER: &str =
    "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black";
const VERTICAL_FOREGROUND_FILTER: &str = "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2";
const VERTICAL_VIDEO_BACKGROUND_FILTER: &str = "scale=540:960:force_original_aspect_ratio=increase:force_divisible_by=2,crop=540:960,boxblur=10:4,eq=brightness=-0.10:saturation=0.82,scale=1080:1920";
const VERTICAL_IMAGE_BACKGROUND_FILTER: &str = "scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1080:1920,boxblur=20:10,eq=brightness=-0.10:saturation=0.82";
/// The site and Story standard renders share one ladder.
const STANDARD_KBPS: (u64, u64) = (3150, 3300);
const FINALIZE_TIMEOUT: Duration = Duration::from_secs(30);

/// `storyDirectory`: where durable Story derivatives live.
pub fn story_directory(config: &Config) -> PathBuf {
    Path::new(&config.data_dir).join("story-media")
}

/// `needsVerticalBlur`: a source not within tolerance of 9:16 gets the
/// blurred backdrop instead of black bars.
pub fn needs_vertical_blur(width: f64, height: f64) -> bool {
    if !(width > 0.0 && height > 0.0) {
        return false;
    }
    (width / height / VERTICAL_ASPECT_RATIO - 1.0).abs() > VERTICAL_ASPECT_TOLERANCE
}

/// `telegramVideoKbps`: 8.5 MiB for the video after the copied audio and the
/// container's overhead.
pub fn telegram_video_kbps(duration: f64, audio_bitrate: f64) -> u64 {
    let target_bits = 8.5 * 1024.0 * 1024.0 * 8.0;
    ((target_bits / duration - audio_bitrate - 24_000.0) / 1000.0).floor().max(150.0) as u64
}

/// `String(number)` for the durations the recipe writes.
fn number(value: f64) -> String {
    foundation::js::number_to_string(value)
}

/// `verticalVideoFilter(duration, blur, splitOutputs, hardware = false)`.
fn vertical_video_filter(duration: f64, blur: bool, split_outputs: usize) -> String {
    let trim = format!("trim=duration={},", number(duration));
    let labels: String = (0..split_outputs).map(|index| format!("[out{index}]")).collect();
    let split = format!("split={split_outputs}{labels}");
    if !blur {
        return format!("[0:v:0]{trim}{VERTICAL_SCALE_FILTER},{split}");
    }
    format!(
        "[0:v:0]{trim}split=2[background-source][foreground-source];[background-source]{VERTICAL_VIDEO_BACKGROUND_FILTER}[background];[foreground-source]{VERTICAL_FOREGROUND_FILTER}[foreground];[background][foreground]overlay=(W-w)/2:(H-h)/2,{split}"
    )
}

fn vertical_image_filter(blur: bool) -> String {
    if !blur {
        return VERTICAL_SCALE_FILTER.into();
    }
    format!(
        "[0:v:0]split=2[background-source][foreground-source];[background-source]{VERTICAL_IMAGE_BACKGROUND_FILTER}[background];[foreground-source]{VERTICAL_FOREGROUND_FILTER}[foreground];[background][foreground]overlay=(W-w)/2:(H-h)/2"
    )
}

/// `outputLeg("libx264", …)`: one encoded output off a filter-graph label.
fn output_leg(label: &str, (kbps, max_kbps): (u64, u64), output: &Path) -> Vec<String> {
    let mut leg: Vec<String> = [
        "-map", label, "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-b:v",
    ]
    .map(str::to_owned)
    .to_vec();
    leg.push(format!("{kbps}k"));
    leg.extend(["-maxrate".to_owned(), format!("{max_kbps}k")]);
    leg.extend(["-bufsize".to_owned(), format!("{}k", max_kbps * 2)]);
    leg.extend(["-g", "50", "-c:a", "copy", "-tag:v", "avc1", "-movflags", "+faststart", "-t"].map(str::to_owned));
    leg.push(number(STORY_MAX_DURATION_SECONDS));
    leg.push(output.to_string_lossy().into_owned());
    leg
}

/// `localStoryFfmpegArgs`: the Story pair as the local executor makes it.
pub fn local_story_ffmpeg_args(
    input: &Path,
    standard_output: &Path,
    telegram_output: &Path,
    telegram_kbps: u64,
    blur: bool,
) -> Vec<String> {
    let mut args = vec![
        "-y".to_owned(),
        "-i".to_owned(),
        input.to_string_lossy().into_owned(),
        "-filter_complex".to_owned(),
        vertical_video_filter(STORY_MAX_DURATION_SECONDS, blur, 2),
    ];
    args.extend(output_leg("[out0]", STANDARD_KBPS, standard_output));
    args.extend(output_leg("[out1]", (telegram_kbps, telegram_kbps), telegram_output));
    args
}

/// `verticalImageFfmpegArgs`.
pub fn vertical_image_ffmpeg_args(input: &Path, output: &Path, blur: bool) -> Vec<String> {
    let filter = vertical_image_filter(blur);
    let mut args = vec!["-y".to_owned(), "-i".to_owned(), input.to_string_lossy().into_owned()];
    args.push(if blur { "-filter_complex" } else { "-vf" }.to_owned());
    args.push(filter);
    args.extend(["-frames:v", "1", "-q:v", "2"].map(str::to_owned));
    args.push(output.to_string_lossy().into_owned());
    args
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
        Some(telegram) if video => local_story_ffmpeg_args(
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
        with_timeout(run_ffmpeg(&args, FFMPEG_TIMEOUT), story_transform_timeout(config), "story_transform_timeout")
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
    let bytes = tokio::fs::metadata(source).await.map_err(|error| error.to_string())?.len();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipe_matches_the_shared_encoder() {
        assert!(!needs_vertical_blur(1080.0, 1920.0));
        assert!(needs_vertical_blur(1920.0, 1080.0));
        assert!(!needs_vertical_blur(0.0, 1080.0));
        assert_eq!(telegram_video_kbps(10.0, 128_000.0), 6_978);
        assert_eq!(telegram_video_kbps(10_000.0, 0.0), 150);
        let args = local_story_ffmpeg_args(Path::new("/in.mp4"), Path::new("/s.mp4"), Path::new("/t.mp4"), 900, false);
        assert_eq!(
            args.join(" "),
            "-y -i /in.mp4 -filter_complex [0:v:0]trim=duration=58.9,scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,split=2[out0][out1] \
             -map [out0] -map 0:a? -c:v libx264 -preset medium -pix_fmt yuv420p -b:v 3150k -maxrate 3300k -bufsize 6600k -g 50 -c:a copy -tag:v avc1 -movflags +faststart -t 58.9 /s.mp4 \
             -map [out1] -map 0:a? -c:v libx264 -preset medium -pix_fmt yuv420p -b:v 900k -maxrate 900k -bufsize 1800k -g 50 -c:a copy -tag:v avc1 -movflags +faststart -t 58.9 /t.mp4"
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        );
        assert_eq!(
            vertical_image_ffmpeg_args(Path::new("/in.jpg"), Path::new("/o.jpg"), false).join(" "),
            "-y -i /in.jpg -vf scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black -frames:v 1 -q:v 2 /o.jpg"
        );
    }
}
