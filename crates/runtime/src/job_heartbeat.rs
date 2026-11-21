//! `foundation/runtime/job-heartbeat.ts`.

use std::time::Duration;

use tokio::time::{Instant, MissedTickBehavior};

/// `withJobHeartbeat`: runs `work` while refreshing a durable job lease every
/// `interval`. A missed beat is harmless on its own, so its error is dropped:
/// the next one lands inside the lease timeout.
pub async fn with_job_heartbeat<T, E>(
    interval: Duration,
    mut heartbeat: impl FnMut() -> Result<(), E>,
    work: impl Future<Output = T>,
) -> T {
    let interval = interval.max(Duration::from_millis(1));
    let mut ticker = tokio::time::interval_at(Instant::now() + interval, interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut work = std::pin::pin!(work);
    loop {
        tokio::select! {
            outcome = &mut work => return outcome,
            _ = ticker.tick() => {
                let _ = heartbeat();
            }
        }
    }
}
