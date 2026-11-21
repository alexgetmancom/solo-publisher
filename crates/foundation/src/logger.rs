//! One JSON object per line — `{"ts","level","message","details"?}` — on
//! stdout, or stderr for `warn` and `error`, exactly as the TypeScript logger
//! wrote it, so whatever reads the container logs keeps working.

use std::io::Write as _;
use std::sync::atomic::{AtomicU8, Ordering};

use serde_json::{Map, Value};

use crate::redact::redact_external_secrets;
use crate::time::to_iso_string;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[cfg_attr(test, derive(serde::Serialize), serde(rename_all = "lowercase"))]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

static MINIMUM: AtomicU8 = AtomicU8::new(LogLevel::Info as u8);

pub fn configure_logging(level: LogLevel) {
    MINIMUM.store(level as u8, Ordering::Relaxed);
}

pub fn log(level: LogLevel, message: &str, details: Option<Value>) {
    if (level as u8) < MINIMUM.load(Ordering::Relaxed) {
        return;
    }
    let output = line(level, message, details, jiff::Timestamp::now());
    // A log line that cannot be written has nowhere else to go.
    let _ = if level >= LogLevel::Warn {
        writeln!(std::io::stderr().lock(), "{output}")
    } else {
        writeln!(std::io::stdout().lock(), "{output}")
    };
}

/// Redaction runs over the serialized line, not field by field: a secret can sit
/// at any depth of `details` or inside the message, and one pass over the
/// finished JSON is total by construction.
fn line(level: LogLevel, message: &str, details: Option<Value>, now: jiff::Timestamp) -> String {
    let mut line = Map::new();
    line.insert("ts".into(), to_iso_string(now).into());
    line.insert("level".into(), level.as_str().into());
    line.insert("message".into(), message.into());
    if let Some(details) = details {
        line.insert("details".into(), details);
    }
    redact_external_secrets(&Value::Object(line).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_typescript_line_shape() {
        let now = jiff::Timestamp::from_millisecond(1_795_000_000_123).unwrap();
        assert_eq!(
            line(
                LogLevel::Warn,
                "platform \"x\" failed",
                Some(serde_json::json!({"url": "/x?token=abc", "n": 2})),
                now
            ),
            r#"{"ts":"2026-11-18T11:06:40.123Z","level":"warn","message":"platform \"x\" failed","details":{"url":"/x?token=[REDACTED]","n":2}}"#
        );
        assert_eq!(
            line(LogLevel::Info, "tick", None, now),
            r#"{"ts":"2026-11-18T11:06:40.123Z","level":"info","message":"tick"}"#
        );
    }
}
