//! ffprobe and ffmpeg, reached through [`Commands`] so a test can drive exit
//! codes, diagnostics and timing without encoding anything.

use std::future::Future;
use std::os::unix::process::ExitStatusExt as _;
use std::path::Path;
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};

use serde_json::Value;

/// A command that ran to its end.
#[derive(Clone, Debug, Default)]
pub struct Finished {
    /// The exit code; a process killed by a signal reads as `128 + signal`.
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub type Running = Pin<Box<dyn Future<Output = std::io::Result<Finished>> + Send>>;

/// Runs `program` with `args`. Dropping the future kills the process.
pub trait Commands: Send + Sync + 'static {
    fn run(&self, program: &'static str, args: Vec<String>) -> Running;
}

/// This host's binaries, on `PATH`.
pub struct HostCommands;

impl Commands for HostCommands {
    fn run(&self, program: &'static str, args: Vec<String>) -> Running {
        Box::pin(async move {
            let output = tokio::process::Command::new(program)
                .args(&args)
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output()
                .await?;
            Ok(Finished {
                code: exit_code(output.status),
                stdout: output.stdout,
                stderr: output.stderr,
            })
        })
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

/// What the recipe needs to know about a source.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Probe {
    /// Seconds, within 1..=59.
    pub duration: f64,
    pub audio_bitrate: f64,
    /// Zero when there is no video stream.
    pub width: f64,
    pub height: f64,
}

/// A source ffprobe cannot read still renders, at the conservative Telegram
/// bitrate of a full-length clip with ordinary audio.
const UNREADABLE: Probe = Probe {
    duration: 59.0,
    audio_bitrate: 128_000.0,
    width: 0.0,
    height: 0.0,
};

pub fn probe_args(input: &Path) -> Vec<String> {
    let mut args = [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,bit_rate,width,height",
        "-of",
        "json",
    ]
    .map(str::to_owned)
    .to_vec();
    args.push(input.to_string_lossy().into_owned());
    args
}

/// ffprobe's answer; anything but a clean exit with a JSON object is
/// [`UNREADABLE`].
pub fn parse_probe(finished: &Finished) -> Probe {
    if finished.code != 0 {
        return UNREADABLE;
    }
    let Ok(Value::Object(parsed)) = serde_json::from_slice::<Value>(&finished.stdout) else {
        return UNREADABLE;
    };
    let streams = parsed.get("streams").and_then(Value::as_array);
    let stream = |kind: &str| {
        streams.and_then(|streams| {
            streams
                .iter()
                .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some(kind))
        })
    };
    let field = |stream: Option<&Value>, name: &str| or(number(stream.and_then(|stream| stream.get(name))), 0.0);
    let audio = stream("audio");
    let video = stream("video");
    let duration = or(
        number(parsed.get("format").and_then(|format| format.get("duration"))),
        59.0,
    );
    Probe {
        duration: duration.clamp(1.0, 59.0),
        audio_bitrate: or(number(audio.and_then(|audio| audio.get("bit_rate"))), 128_000.0).max(0.0),
        width: field(video, "width"),
        height: field(video, "height"),
    }
}

/// `Number(value)` for what ffprobe writes: a numeric string or a number.
fn number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) if text.trim().is_empty() => 0.0,
        Some(Value::String(text)) => text.trim().parse().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    }
}

/// `value || fallback`: zero and NaN are absent.
fn or(value: f64, fallback: f64) -> f64 {
    if value == 0.0 || value.is_nan() {
        fallback
    } else {
        value
    }
}

const FAILURE_UNITS: usize = 1200;

/// The 422 body of a failed encode: the timeout or an out-of-memory kill by
/// name, otherwise the last four diagnostic lines without the progress spam
/// that would push the real error out of the tail. Bounded, because it ends up
/// in a durable job error.
pub fn ffmpeg_failure(code: i32, stderr: &str, timed_out: bool, timeout_seconds: u64) -> String {
    if timed_out {
        return format!("media_processing_timeout: ffmpeg exceeded {timeout_seconds}s");
    }
    if code == 137 {
        return "media_processing_failed: ffmpeg exit 137: process was killed (likely out of memory)".into();
    }
    let lines: Vec<&str> = stderr
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|line| !line.is_empty() && !is_progress(line))
        .collect();
    let detail = lines[lines.len().saturating_sub(4)..].join(" · ");
    let detail = if detail.is_empty() {
        "no diagnostic output"
    } else {
        &detail
    };
    utf16_prefix(
        &format!("media_processing_failed: ffmpeg exit {code}: {detail}"),
        FAILURE_UNITS,
    )
}

/// `^frame=\s*\d+\s+fps=`.
fn is_progress(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("frame=") else {
        return false;
    };
    let rest = rest.trim_start();
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let rest = &rest[digits..];
    let spaced = rest.trim_start();
    digits > 0 && spaced.len() < rest.len() && spaced.starts_with("fps=")
}

/// At most `units` UTF-16 code units, never splitting a character.
fn utf16_prefix(text: &str, units: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= units
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_timeout_rather_than_the_signal_it_caused() {
        assert_eq!(
            ffmpeg_failure(137, "killed", true, 900),
            "media_processing_timeout: ffmpeg exceeded 900s"
        );
    }

    #[test]
    fn calls_out_an_out_of_memory_kill() {
        assert!(ffmpeg_failure(137, "", false, 900).contains("likely out of memory"));
    }

    #[test]
    fn says_so_when_ffmpeg_failed_without_printing_anything() {
        assert!(ffmpeg_failure(1, "   \n\n", false, 900).contains("no diagnostic output"));
    }

    #[test]
    fn keeps_the_last_four_diagnostic_lines_without_progress() {
        let stderr = "frame=  12 fps=3 q=28\r\none\ntwo\nframe=1 fps=0.0\nthree\nfour\nfive\nConversion failed!\n";
        assert_eq!(
            ffmpeg_failure(1, stderr, false, 900),
            "media_processing_failed: ffmpeg exit 1: three · four · five · Conversion failed!"
        );
        assert!(!is_progress("frame=12fps=3"));
        assert!(is_progress("frame=12 fps=3"));
    }

    #[test]
    fn bounds_the_message_so_a_failure_cannot_flood_the_durable_job_error() {
        assert_eq!(
            ffmpeg_failure(1, &"détail ".repeat(5000), false, 900)
                .encode_utf16()
                .count(),
            1200
        );
    }

    #[test]
    fn reads_the_probe_as_javascript_numbers_did() {
        let finished = |stdout: &str| Finished {
            code: 0,
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        };
        let probe = parse_probe(&finished(
            r#"{"format":{"duration":"12.5"},"streams":[{"codec_type":"video","width":1920,"height":1080},{"codec_type":"audio","bit_rate":"96000"}]}"#,
        ));
        assert_eq!(
            probe,
            Probe {
                duration: 12.5,
                audio_bitrate: 96_000.0,
                width: 1920.0,
                height: 1080.0
            }
        );
        // Over a minute is capped, no audio stream budgets for ordinary audio.
        let long = parse_probe(&finished(r#"{"format":{"duration":"600"},"streams":[]}"#));
        assert_eq!((long.duration, long.audio_bitrate), (59.0, 128_000.0));
        assert_eq!(parse_probe(&finished(r#"{"format":{"duration":"0.2"}}"#)).duration, 1.0);
        assert_eq!(
            parse_probe(&finished(r#"{"format":{"duration":"N/A"}}"#)).duration,
            59.0
        );
        assert_eq!(parse_probe(&finished("<html>proxy error</html>")), UNREADABLE);
        assert_eq!(parse_probe(&finished("null")), UNREADABLE);
        assert_eq!(
            parse_probe(&Finished {
                code: 1,
                ..finished("{}")
            }),
            UNREADABLE
        );
    }
}
