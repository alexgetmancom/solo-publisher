//! ffmpeg and ffprobe as child processes: at most two ffmpeg at a time across
//! the process, SIGKILL when one outlives its timeout, and failures reduced to
//! the lines that say why.
//!
//! [`FfmpegMediaProbe`] is the media probe Studio's video checks call
//! (`domain::publishing::boundaries::MediaProbe`).

use std::fmt;
use std::process::{ExitStatus, Stdio};
use std::sync::LazyLock;
use std::time::Duration;

use domain::publishing::boundaries::{MediaMetadata, MediaProbe};
use foundation::js::{self, WHITESPACE_CLASS};
use regex::Regex;
use serde_json::Value;
use tokio::io::AsyncReadExt as _;
use tokio::process::Command;
use tokio::sync::Semaphore;

/// Encodes are memory-bound; a third concurrent one is what ran the container
/// out of memory.
const FFMPEG_MAX_CONCURRENCY: usize = 2;

static LIMITER: Semaphore = Semaphore::const_new(FFMPEG_MAX_CONCURRENCY);

pub const FFMPEG_TIMEOUT: Duration = Duration::from_secs(600);
pub const FFMPEG_CAPTURE_TIMEOUT: Duration = Duration::from_secs(120);
pub const FFPROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// A media tool failed; the message is `media_processing_failed: …` or
/// `media_probe_timeout: …`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaToolError(pub String);

impl fmt::Display for MediaToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MediaToolError {}

/// Runs ffmpeg to completion within `timeout`.
pub async fn run_ffmpeg(args: &[&str], timeout: Duration) -> Result<(), MediaToolError> {
    let _slot = LIMITER.acquire().await.expect("the limiter is never closed");
    let finished = run("ffmpeg", args, timeout, false).await?;
    let Some(finished) = finished else {
        return Err(ffmpeg_timeout(timeout));
    };
    if finished.code != 0 {
        return Err(MediaToolError(format_ffmpeg_failure(finished.code, &finished.stderr)));
    }
    Ok(())
}

/// What ffmpeg wrote to stdout.
///
/// Frame inspection wants pixels, not a file: a few kilobytes of raw RGB are
/// cheaper read from the pipe than written to and read back from a temp path.
pub async fn run_ffmpeg_capture(args: &[&str], timeout: Duration) -> Result<Vec<u8>, MediaToolError> {
    let _slot = LIMITER.acquire().await.expect("the limiter is never closed");
    let finished = run("ffmpeg", args, timeout, true).await?;
    let Some(finished) = finished else {
        return Err(ffmpeg_timeout(timeout));
    };
    if finished.code != 0 {
        return Err(MediaToolError(format_ffmpeg_failure(finished.code, &finished.stderr)));
    }
    Ok(finished.stdout)
}

fn ffmpeg_timeout(timeout: Duration) -> MediaToolError {
    MediaToolError(format!(
        "media_processing_timeout: ffmpeg exceeded {}s",
        js::number_to_string(timeout.as_secs_f64())
    ))
}

/// The canonical ffprobe projection for every video workflow. Callers decide whether a probe failure
/// is fatal. ffprobe is not limited: it decodes nothing.
pub async fn probe_media_metadata(path: &str, timeout: Duration) -> Result<MediaMetadata, MediaToolError> {
    let args = [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height,duration,avg_frame_rate,bit_rate",
        "-of",
        "json",
        path,
    ];
    let Some(finished) = run("ffprobe", &args, timeout, true).await? else {
        return Err(MediaToolError(format!(
            "media_probe_timeout: ffprobe exceeded {}s",
            js::number_to_string(timeout.as_secs_f64())
        )));
    };
    if finished.code != 0 {
        return Err(ffprobe_failure(finished.code, &finished.stderr));
    }
    media_metadata_from_ffprobe(&decode(&finished.stdout))
}

/// A non-zero ffprobe exit: the tail of what it said.
pub fn ffprobe_failure(code: i32, stderr: &str) -> MediaToolError {
    let tail = slice_utf16_tail(js::trim(stderr), 800);
    MediaToolError(format!(
        "media_probe_failed: ffprobe exit {code}: {}",
        if tail.is_empty() { "no diagnostic output" } else { tail }
    ))
}

/// The metadata in ffprobe's JSON, read with JavaScript's coercions: numeric
/// strings are numbers, a missing duration falls back to the stream's.
pub fn media_metadata_from_ffprobe(stdout: &str) -> Result<MediaMetadata, MediaToolError> {
    let data: Value = serde_json::from_str(if stdout.is_empty() { "{}" } else { stdout })
        .map_err(|_| MediaToolError("media_probe_failed: ffprobe returned invalid JSON".into()))?;
    let streams = data.get("streams").and_then(Value::as_array);
    let stream = |kind: &str| {
        streams?
            .iter()
            .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some(kind))
    };
    let video = stream("video")
        .filter(|video| video.get("width").is_some_and(js::truthy) && video.get("height").is_some_and(js::truthy))
        .ok_or_else(|| MediaToolError("media_probe_failed: ffprobe did not find a video stream".into()))?;
    let audio = stream("audio");
    let rate = match js::present(video.get("avg_frame_rate")) {
        None => "0/1".to_owned(),
        Some(Value::String(rate)) => rate.clone(),
        Some(other) => other.to_string(),
    };
    let mut parts = rate.split('/').map(js::number);
    let numerator = parts.next().unwrap_or(0.0);
    let denominator = parts.next().unwrap_or(1.0);
    let duration = js::present(data.get("format").and_then(|format| format.get("duration")))
        .or_else(|| js::present(video.get("duration")))
        .map_or(0.0, |duration| js::number_of_scalar(Some(duration)));
    let audio_bitrate = audio.map_or(f64::NAN, |audio| js::number_of_scalar(audio.get("bit_rate")));
    Ok(MediaMetadata {
        width: js::number_of_scalar(Some(&video["width"])),
        height: js::number_of_scalar(Some(&video["height"])),
        duration_seconds: if duration.is_nan() { f64::NAN } else { duration.max(0.0) },
        video_codec: string(video.get("codec_name")).unwrap_or_else(|| "video".into()),
        audio_codec: audio.and_then(|audio| string(audio.get("codec_name"))),
        fps: if denominator != 0.0 && !denominator.is_nan() {
            numerator / denominator
        } else {
            0.0
        },
        audio_bitrate: (audio_bitrate.is_finite() && audio_bitrate > 0.0).then_some(audio_bitrate),
    })
}

/// `?? null` of a field typed as a string: whatever is there.
fn string(value: Option<&Value>) -> Option<String> {
    js::present(value).map(|value| match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    })
}

static PROGRESS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^frame=[{WHITESPACE_CLASS}]*[0-9]+[{WHITESPACE_CLASS}]+fps=")).unwrap());

/// An actionable terminal reason instead of megabytes
/// of progress frames. Exit 137 is the Linux OOM-kill convention.
pub fn format_ffmpeg_failure(code: i32, stderr: &str) -> String {
    let stderr = stderr.replace('\r', "\n");
    let lines: Vec<&str> = stderr
        .split('\n')
        .map(js::trim)
        .filter(|line| !line.is_empty() && !PROGRESS.is_match(line))
        .collect();
    let meaningful = lines[lines.len().saturating_sub(6)..].join(" · ");
    let reason = if code == 137 {
        "process was killed (likely out of memory)"
    } else if meaningful.is_empty() {
        "no diagnostic output"
    } else {
        &meaningful
    };
    js::utf16_prefix(&format!("media_processing_failed: ffmpeg exit {code}: {reason}"), 1200).to_owned()
}

/// The last `count` UTF-16 code units (`slice(-count)`); a surrogate pair the
/// cut would split is dropped whole.
fn slice_utf16_tail(value: &str, count: usize) -> &str {
    let mut units = 0;
    for (index, c) in value.char_indices().rev() {
        units += c.len_utf16();
        if units > count {
            return &value[index + c.len_utf8()..];
        }
    }
    value
}

/// `new Response(stream).text()`: UTF-8 with replacement (Bun keeps a BOM).
fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

struct Finished {
    /// The exit code, or 128 + the signal, as Bun reports a killed child.
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
}

/// Runs `program` to completion; `None` when it outlived `timeout` and was
/// killed.
async fn run(
    program: &str,
    args: &[&str],
    timeout: Duration,
    capture_stdout: bool,
) -> Result<Option<Finished>, MediaToolError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(if capture_stdout { Stdio::piped() } else { Stdio::null() })
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| MediaToolError(format!("{program} could not start: {error}")))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let mut out = Vec::new();
    let mut err = Vec::new();
    let streams = async {
        let read_out = async {
            match stdout.as_mut() {
                Some(stdout) => stdout.read_to_end(&mut out).await.map(drop),
                None => Ok(()),
            }
        };
        let (read_out, read_err) = tokio::join!(read_out, stderr.read_to_end(&mut err));
        read_out.and(read_err.map(drop))
    };
    let exchange = async {
        let (read, status) = tokio::join!(streams, child.wait());
        read.and(status)
    };
    let status = match tokio::time::timeout(timeout, exchange).await {
        Ok(status) => status.map_err(|error| MediaToolError(format!("{program} failed: {error}")))?,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Ok(None);
        }
    };
    Ok(Some(Finished {
        code: exit_code(status),
        stdout: out,
        stderr: decode(&err),
    }))
}

fn exit_code(status: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt as _;
    status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

/// The arguments of the `astats` pass the background-music check reads.
fn audio_stats_args(path: &str) -> [&str; 12] {
    [
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
    ]
}

/// ffprobe and ffmpeg on this machine: Studio's media probe.
pub struct FfmpegMediaProbe;

impl MediaProbe for FfmpegMediaProbe {
    async fn probe(&self, path: &str) -> Result<MediaMetadata, String> {
        probe_media_metadata(path, FFPROBE_TIMEOUT)
            .await
            .map_err(|error| error.0)
    }

    async fn audio_stats(&self, path: &str) -> Result<String, String> {
        let output = run_ffmpeg_capture(&audio_stats_args(path), FFMPEG_CAPTURE_TIMEOUT)
            .await
            .map_err(|error| error.0)?;
        Ok(decode(&output))
    }
}
