//! A deadline on a piece of work.

use std::fmt;
use std::time::Duration;

/// The work did not finish in time. Like `ExternalTransportError`, after a
/// publishing call it is the ambiguous case.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperationTimeoutError(pub String);

impl fmt::Display for OperationTimeoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OperationTimeoutError {}

/// Runs `work` under a deadline. Unlike a raced promise, the work is dropped
/// when the timer wins: it stops at its next await instead of running on
/// unobserved.
pub async fn with_timeout<T>(
    work: impl Future<Output = T>,
    timeout: Duration,
    message: &str,
) -> Result<T, OperationTimeoutError> {
    tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| OperationTimeoutError(message.to_owned()))
}
