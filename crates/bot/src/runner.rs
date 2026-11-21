//! Long polling as `@grammyjs/runner`'s `run(bot)` does it (`bot/runner.ts`):
//! `getUpdates` with a 30 s timeout and a batch of at most 100, up to 500
//! updates handled at once, each as soon as it arrives. Ordering within a
//! chat is the middleware chain's `sequentialize`, not the runner's.
//!
//! A failed fetch is retried after 100 ms, doubling, for up to 15 hours; 401
//! (wrong token) and 409 (another poller) stop the runner; 429 waits
//! `retry_after` first.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use foundation::logger::{LogLevel, log};
use serde_json::json;
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinHandle;

use crate::api::ApiError;
use crate::bot::Bot;

const CONCURRENCY: usize = 500;
const POLL_TIMEOUT_SECONDS: u32 = 30;
const MAX_BATCH: usize = 100;
const INITIAL_RETRY_MS: u64 = 100;
const MAX_RETRY_TIME: Duration = Duration::from_secs(15 * 60 * 60);

/// A running bot, in the two terms its owner needs.
pub struct Runner {
    running: Rc<Cell<bool>>,
    stop: Rc<Notify>,
    ended: Rc<Notify>,
    task: JoinHandle<crate::Result<()>>,
}

impl Runner {
    pub fn is_running(&self) -> bool {
        self.running.get()
    }

    /// Resolves once polling has ended, by [`Runner::stop`] or on its own (a
    /// wrong token, another poller); `stop` then returns what it ended with.
    pub async fn ended(&self) {
        self.ended.notified().await;
    }

    /// Stops fetching and waits for the poll loop to end; updates already
    /// handed out finish on their own.
    pub async fn stop(self) -> crate::Result<()> {
        self.running.set(false);
        self.stop.notify_one();
        self.task.await.map_err(|error| crate::error(error.to_string()))?
    }
}

/// `startBotRunner`: initialises the bot (`getMe`) and starts polling. Must be
/// called inside the bot's `LocalSet`.
pub async fn start(bot: &Bot) -> crate::Result<Runner> {
    bot.init().await?;
    let running = Rc::new(Cell::new(true));
    let stop = Rc::new(Notify::new());
    let ended = Rc::new(Notify::new());
    let polling = poll(bot.clone(), Rc::clone(&running), Rc::clone(&stop));
    let task = tokio::task::spawn_local({
        let ended = Rc::clone(&ended);
        async move {
            let result = polling.await;
            ended.notify_one();
            result
        }
    });
    log(
        LogLevel::Info,
        "grammY runner started",
        Some(json!({"username": bot.info().and_then(|me| me.username)})),
    );
    Ok(Runner {
        running,
        stop,
        ended,
        task,
    })
}

async fn poll(bot: Bot, running: Rc<Cell<bool>>, stop: Rc<Notify>) -> crate::Result<()> {
    let capacity = Arc::new(Semaphore::new(CONCURRENCY));
    let mut offset = 0;
    while running.get() {
        let limit = capacity.available_permits().clamp(1, MAX_BATCH) as u32;
        let updates = tokio::select! {
            updates = fetch(&bot, offset, limit) => updates,
            () = stop.notified() => break,
        };
        let updates = match updates {
            Ok(updates) => updates,
            Err(error) => {
                running.set(false);
                return Err(error);
            }
        };
        if let Some(last) = updates.last() {
            offset = last.update_id + 1;
        }
        for update in updates {
            let permit = Arc::clone(&capacity).acquire_owned().await?;
            let handling = bot.clone();
            bot.spawn(async move {
                handling.handle_update(update).await;
                drop(permit);
            });
        }
    }
    running.set(false);
    Ok(())
}

/// One `getUpdates`, retried the way the runner's fetcher retries it.
async fn fetch(bot: &Bot, offset: i64, limit: u32) -> crate::Result<Vec<crate::api::types::Update>> {
    let latest = Instant::now() + MAX_RETRY_TIME;
    let mut retry_in = Duration::from_millis(INITIAL_RETRY_MS);
    loop {
        let error = match bot.api().get_updates(offset, limit, POLL_TIMEOUT_SECONDS).await {
            Ok(updates) => return Ok(updates),
            Err(error) => error,
        };
        log(
            LogLevel::Error,
            "[grammY runner] Error while fetching updates:",
            Some(json!({"error": error.js_string()})),
        );
        if matches!(error.error_code(), Some(401 | 409)) {
            return Err(error.into());
        }
        if let ApiError::Telegram(_) = error
            && let Some(seconds) = error.retry_after()
        {
            tokio::time::sleep(Duration::from_secs_f64(seconds.max(0.0))).await;
        }
        if Instant::now() + retry_in >= latest {
            return Err(error.into());
        }
        tokio::time::sleep(retry_in).await;
        retry_in += retry_in;
    }
}
