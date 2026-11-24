//! Bounded retries for registry pulls and remote deployments.

use std::future::Future;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    pub attempts: u32,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
}

/// Retries `operation` while `should_retry` accepts its error, up to
/// `policy.attempts` runs in all, doubling the delay between them up to the
/// maximum. `on_retry` hears each failure that is retried, with the attempt
/// that failed and the delay before the next.
pub async fn with_retry<T, E, Run, Running>(
    policy: RetryPolicy,
    mut operation: Run,
    should_retry: impl Fn(&E) -> bool,
    mut on_retry: impl FnMut(&E, u32, u64),
) -> Result<T, E>
where
    Run: FnMut() -> Running,
    Running: Future<Output = Result<T, E>>,
{
    let attempts = policy.attempts.max(1);
    let max_delay_ms = policy.max_delay_ms.max(policy.initial_delay_ms);
    let mut delay_ms = policy.initial_delay_ms;
    let mut failed_attempt = 1;
    loop {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                if failed_attempt >= attempts || !should_retry(&error) {
                    return Err(error);
                }
                on_retry(&error, failed_attempt, delay_ms);
                if delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
                delay_ms = delay_ms.saturating_mul(2).min(max_delay_ms);
                failed_attempt += 1;
            }
        }
    }
}

static TRANSIENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:i/o timeout|context deadline exceeded|tls handshake timeout|temporary failure in name resolution|no such host|network is unreachable|connection (?:reset|refused|timed out)|unexpected eof|fetch failed|\b(?:408|425|429|502|503|504)\b|\btimeout\b)",
    )
    .unwrap()
});

/// Registry clients surface transient DNS, TCP, TLS and gateway failures as plain errors.
pub fn is_transient(message: &str) -> bool {
    TRANSIENT.is_match(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn transient_failures_are_retried_with_exponential_backoff() {
        let mut calls = 0;
        let mut delays = Vec::new();
        let policy = RetryPolicy {
            attempts: 3,
            initial_delay_ms: 100,
            max_delay_ms: 500,
        };
        let result = with_retry(
            policy,
            || {
                calls += 1;
                let failing = calls < 3;
                async move {
                    if failing {
                        Err("failed to do request: dial tcp: i/o timeout".to_owned())
                    } else {
                        Ok("ok")
                    }
                }
            },
            |error: &String| is_transient(error),
            |_, _, delay| delays.push(delay),
        )
        .await;
        assert_eq!(result, Ok("ok"));
        assert_eq!(calls, 3);
        assert_eq!(delays, [100, 200]);
    }

    #[tokio::test]
    async fn permanent_registry_errors_are_not_retried() {
        let mut calls = 0;
        let policy = RetryPolicy {
            attempts: 3,
            initial_delay_ms: 0,
            max_delay_ms: 0,
        };
        let result: Result<(), String> = with_retry(
            policy,
            || {
                calls += 1;
                async { Err("manifest unknown: 404".to_owned()) }
            },
            |error: &String| is_transient(error),
            |_, _, _| {},
        )
        .await;
        assert_eq!(result, Err("manifest unknown: 404".to_owned()));
        assert_eq!(calls, 1);
    }
}
