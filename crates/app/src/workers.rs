//! The background loops (`apps/backend/src/runtime/workers.ts`), each through
//! one heartbeat factory so `status` sees it. Every loop reaches the database
//! through the bot that owns it; all of them run on the bot's thread.

use std::rc::Rc;
use std::time::{Duration, Instant};

use bot::Bot;
use db::unsafe_db;
use domain::application::ports::Clock;
use domain::publishing::Publishing;
use domain::studio::Studio;
use foundation::logger::{LogLevel, log};
use runtime::scheduler::ScheduledLoop;
use runtime::worker_state::{HeartbeatLoops, record_worker_state};
use serde_json::json;
use story_render::{STORY_CARD_WORKER, recover_story_card_jobs, run_story_card_cycle};

/// Recovers what a previous process left locked, then starts the loops.
pub fn start(bot: &Bot) -> Vec<ScheduledLoop> {
    let deps = bot.deps();
    let sqlite = unsafe_db(&deps.db);
    match recover_story_card_jobs(sqlite, &*deps.clock) {
        Ok(0) => {}
        Ok(recovered) => log(
            LogLevel::Warn,
            "recovered interrupted Story card locks on worker startup",
            Some(json!({"recovered": recovered})),
        ),
        Err(error) => log(
            LogLevel::Error,
            "Story card locks could not be recovered on worker startup",
            Some(json!({"error": error.to_string()})),
        ),
    }
    let loops = HeartbeatLoops::new(Rc::new(bot.clone()), |bot: &Bot| &bot.deps().db);
    let idle_poll = Duration::from_secs(deps.config.load().idle_poll_interval_seconds);
    vec![loops.start(STORY_CARD_WORKER, idle_poll, {
        let bot = bot.clone();
        move || story_cards(bot.clone())
    })]
}

async fn story_cards(bot: Bot) -> Result<(), String> {
    let started = Instant::now();
    let deps = bot.deps();
    let config = deps.config.load();
    let host = &*deps.host;
    let sqlite = unsafe_db(&deps.db);
    let studio = Studio::new(
        Publishing::new(sqlite, &*deps.clock, host.publishing()),
        &config,
        host.studio(),
    );
    let cycle = run_story_card_cycle(studio).await.map_err(|error| error.to_string())?;
    record_worker_state(
        &deps.db,
        STORY_CARD_WORKER,
        cycle.state,
        cycle.error.as_deref(),
        deps.clock.now(),
    )
    .map_err(|error| error.to_string())?;
    timed("content.story_card.cycle", "claimed", cycle.claimed, started);
    Ok(())
}

/// `runTimedCycle`: a cycle that did something says how long it took.
fn timed(operation: &str, count_name: &str, count: u32, started: Instant) {
    if count == 0 {
        return;
    }
    let total_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    log(
        LogLevel::Info,
        "operation timing",
        Some(json!({"operation": operation, "success": true, "totalMs": total_ms, count_name: count})),
    );
}
