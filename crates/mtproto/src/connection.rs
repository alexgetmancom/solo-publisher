//! One grammers client for one piece of work: the sender pool runs beside
//! the work in the same task, so dropping the work drops the connection too.

use std::num::NonZeroU32;
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use grammers_client::Client;
use grammers_client::sender::{AutoSleep, ConnectionParams, SenderPool};

use crate::session::SessionFile;

/// Teardown is best effort: a stalled socket close must not hold the answer.
const TEARDOWN: Duration = Duration::from_secs(5);
/// A flood wait this short is slept through, as mtcute's default
/// `floodSleepThreshold` did.
const FLOOD_SLEEP_THRESHOLD: Duration = Duration::from_secs(10);

/// Runs `work` with a client on `session`, then disconnects.
///
/// Telegram's refusals (flood waits up to [`FLOOD_SLEEP_THRESHOLD`] aside)
/// and dropped connections are never retried here: a retried
/// `stories.sendStory` whose first attempt went through is a second Story.
pub(crate) async fn with_client<T>(api_id: i32, session: SessionFile, work: impl AsyncFnOnce(&Client) -> T) -> T {
    let params = ConnectionParams {
        retry_policy: Box::new(AutoSleep {
            tries: NonZeroU32::MIN,
            threshold: FLOOD_SLEEP_THRESHOLD,
            io_errors_as_flood_of: None,
        }),
        ..ConnectionParams::default()
    };
    let SenderPool {
        runner,
        handle,
        updates,
    } = SenderPool::with_configuration(Arc::new(session), api_id, params);
    // Updates are never consumed; a closed channel tells the senders so.
    drop(updates);
    let client = Client::new(handle);
    let mut runner = pin!(runner.run());
    let mut work = pin!(work(&client));
    let (outcome, runner_stopped) = tokio::select! {
        outcome = &mut work => (outcome, false),
        // The runner stops only once every handle is gone or told to quit;
        // the work's own calls then fail and it answers for itself.
        () = &mut runner => (work.await, true),
    };
    if !runner_stopped {
        client.disconnect();
        let _ = tokio::time::timeout(TEARDOWN, runner).await;
    }
    outcome
}
