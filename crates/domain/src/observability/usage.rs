//! Runtime usage telemetry (`observability/usage.ts`, `recordUsage` and
//! `flushUsage`): calls, outcomes and time per feature and UTC day, buffered
//! in the process and written to `runtime_usage` at most once a minute. The
//! report over those rows is not here.

use std::cell::RefCell;
use std::sync::LazyLock;

use db::rusqlite::{Connection, params};
use foundation::logger::{LogLevel, log};
use regex::Regex;
use serde_json::json;

use crate::application::ports::Clock;
use crate::publishing::boundaries::UsageMeter;
use crate::repositories::{stamp, transaction};

const USAGE_FLUSH_INTERVAL_MS: i64 = 60_000;

static FEATURE_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_.-]{0,127}$").unwrap());

struct BufferedUsage {
    feature_key: String,
    bucket_day: String,
    calls: i64,
    successes: i64,
    failures: i64,
    total_duration_ms: i64,
    first_seen_at: String,
    last_seen_at: String,
}

struct Buffer {
    /// In first-recorded order, as the `Map` it replaces.
    pending: Vec<BufferedUsage>,
    last_flushed_at: i64,
}

/// The process's usage buffer for one database. Single-threaded, as the bot
/// that records into it.
pub struct UsageRecorder<C> {
    clock: C,
    buffer: RefCell<Option<Buffer>>,
}

impl<C: Clock> UsageRecorder<C> {
    pub fn new(clock: C) -> Self {
        Self {
            clock,
            buffer: RefCell::new(None),
        }
    }

    /// `flushUsage`: the buffered telemetry in one transaction. A failed flush
    /// keeps the buffer for the next attempt.
    pub fn flush(&self, sqlite: &Connection) {
        let mut buffer = self.buffer.borrow_mut();
        let Some(buffer) = buffer.as_mut().filter(|buffer| !buffer.pending.is_empty()) else {
            return;
        };
        let written = transaction(sqlite, || {
            let mut upsert = sqlite.prepare(
                "INSERT INTO runtime_usage
          (feature_key, bucket_day, calls, successes, failures, total_duration_ms, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(feature_key, bucket_day) DO UPDATE SET
           calls = runtime_usage.calls + excluded.calls,
           successes = runtime_usage.successes + excluded.successes,
           failures = runtime_usage.failures + excluded.failures,
           total_duration_ms = runtime_usage.total_duration_ms + excluded.total_duration_ms,
           last_seen_at = excluded.last_seen_at",
            )?;
            for entry in &buffer.pending {
                upsert.execute(params![
                    entry.feature_key,
                    entry.bucket_day,
                    entry.calls,
                    entry.successes,
                    entry.failures,
                    entry.total_duration_ms,
                    entry.first_seen_at,
                    entry.last_seen_at
                ])?;
            }
            Ok(())
        });
        match written {
            Ok(()) => {
                buffer.pending.clear();
                buffer.last_flushed_at = self.clock.now().as_millisecond();
            }
            Err(error) => log(
                LogLevel::Warn,
                "runtime usage flush failed",
                Some(json!({"error": error.to_string()})),
            ),
        }
    }
}

impl<C: Clock> UsageMeter for UsageRecorder<C> {
    /// `recordUsage`: one operation buffered; the call that crosses the flush
    /// interval writes the whole batch.
    fn record(&self, sqlite: &Connection, feature_key: &str, success: bool, duration_ms: u64) {
        if !FEATURE_KEY.is_match(feature_key) {
            log(
                LogLevel::Warn,
                "invalid runtime usage feature key",
                Some(json!({"featureKey": feature_key})),
            );
            return;
        }
        let timestamp = stamp(&self.clock);
        let bucket_day = timestamp[..10].to_owned();
        let duration_ms = i64::try_from(duration_ms).unwrap_or(i64::MAX);
        let due = {
            let mut buffer = self.buffer.borrow_mut();
            let buffer = buffer.get_or_insert_with(|| Buffer {
                pending: Vec::new(),
                last_flushed_at: self.clock.now().as_millisecond(),
            });
            let (successes, failures) = if success { (1, 0) } else { (0, 1) };
            match buffer
                .pending
                .iter_mut()
                .find(|entry| entry.feature_key == feature_key && entry.bucket_day == bucket_day)
            {
                Some(current) => {
                    current.calls += 1;
                    current.successes += successes;
                    current.failures += failures;
                    current.total_duration_ms = current.total_duration_ms.saturating_add(duration_ms);
                    if timestamp < current.first_seen_at {
                        current.first_seen_at = timestamp.clone();
                    }
                    if timestamp > current.last_seen_at {
                        current.last_seen_at = timestamp;
                    }
                }
                None => buffer.pending.push(BufferedUsage {
                    feature_key: feature_key.to_owned(),
                    bucket_day,
                    calls: 1,
                    successes,
                    failures,
                    total_duration_ms: duration_ms,
                    first_seen_at: timestamp.clone(),
                    last_seen_at: timestamp,
                }),
            }
            self.clock.now().as_millisecond() - buffer.last_flushed_at >= USAGE_FLUSH_INTERVAL_MS
        };
        if due {
            self.flush(sqlite);
        }
    }

    fn flush(&self, sqlite: &Connection) {
        UsageRecorder::flush(self, sqlite);
    }
}
