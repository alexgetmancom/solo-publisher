//! ffprobe and ffmpeg as the recorder ran them: the real binaries on
//! the fixture files, so the technical check a video card shows is the one
//! the recorded bot printed.

use std::process::Command;

use domain::publishing::boundaries::MediaMetadata;
use serde_json::Value;

/// `Number(value)` of an ffprobe JSON field (numbers or numeric strings).
fn number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => f64::NAN,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => foundation::js::number(text),
        Some(_) => f64::NAN,
    }
}

fn truthy_number(value: Option<&Value>) -> bool {
    let value = number(value);
    value != 0.0 && !value.is_nan()
}

/// `probeMediaMetadata(path)`.
pub fn probe(path: &str) -> Result<MediaMetadata, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name,width,height,duration,avg_frame_rate,bit_rate",
            "-of",
            "json",
            path,
        ])
        .output()
        .map_err(|error| format!("media_probe_failed: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        return Err(format!(
            "media_probe_failed: ffprobe exit {}: {}",
            output.status.code().unwrap_or(-1),
            if stderr.is_empty() {
                "no diagnostic output"
            } else {
                stderr
            }
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let data: Value = serde_json::from_str(if stdout.is_empty() { "{}" } else { &stdout })
        .map_err(|_| "media_probe_failed: ffprobe returned invalid JSON".to_owned())?;
    let streams = data
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let stream = |kind: &str| {
        streams
            .iter()
            .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some(kind))
    };
    let video = stream("video")
        .filter(|video| truthy_number(video.get("width")) && truthy_number(video.get("height")))
        .ok_or_else(|| "media_probe_failed: ffprobe did not find a video stream".to_owned())?;
    let audio = stream("audio");
    let rate = video.get("avg_frame_rate").and_then(Value::as_str).unwrap_or("0/1");
    let mut parts = rate.split('/').map(foundation::js::number);
    let numerator = parts.next().unwrap_or(0.0);
    let denominator = parts.next().unwrap_or(1.0);
    let duration = data
        .get("format")
        .and_then(|format| format.get("duration"))
        .filter(|duration| !duration.is_null())
        .or_else(|| video.get("duration").filter(|duration| !duration.is_null()));
    let duration = duration.map_or(0.0, |duration| number(Some(duration)));
    let audio_bitrate = number(audio.and_then(|audio| audio.get("bit_rate")));
    Ok(MediaMetadata {
        width: number(video.get("width")),
        height: number(video.get("height")),
        duration_seconds: if duration.is_nan() { f64::NAN } else { duration.max(0.0) },
        video_codec: video
            .get("codec_name")
            .and_then(Value::as_str)
            .unwrap_or("video")
            .to_owned(),
        audio_codec: audio
            .and_then(|audio| audio.get("codec_name"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        fps: if denominator != 0.0 && !denominator.is_nan() {
            numerator / denominator
        } else {
            0.0
        },
        audio_bitrate: (audio_bitrate.is_finite() && audio_bitrate > 0.0).then_some(audio_bitrate),
    })
}

/// The `astats` pass `backgroundMusicLikelyMissing` reads, as text.
pub fn audio_stats(path: &str) -> Result<String, String> {
    let output = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            path,
            "-map",
            "0:a:0",
            "-af",
            "astats=metadata=1:reset=0,ametadata=print:file=-",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|error| format!("media_processing_failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "media_processing_failed: ffmpeg exit {}",
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
