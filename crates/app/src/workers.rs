//! The background loops, each through
//! one heartbeat factory so `status` sees it. Every loop reaches the database
//! through the bot that owns it; all of them run on the bot's thread.

use std::rc::Rc;
use std::time::{Duration, Instant};

use bot::Bot;
use bot::workers::start_telegram_workers;
use db::{BackendDb, unsafe_db};
use delivery::Delivery;
use delivery::maintenance::{prune_operational_history, with_maintenance_lock};
use delivery::media_prepare::prune_media_cache;
use delivery::publish_workflow::{
    PUBLISH_RESTART_LOCK_GRACE_SECONDS, delivery_ports, recover_stale_publish_jobs, run_delivery_publish_cycle,
};
use delivery::reconciliation::run_publication_reconciliation;
use delivery::site_jobs::{
    SITE_JOB_LOCK_TIMEOUT_SECONDS, SITE_JOB_RESTART_LOCK_GRACE_SECONDS, recover_stale_site_jobs, run_site_job_cycle,
    site_enabled,
};
use delivery::video_worker::run_video_cycle;
use domain::application::ports::Clock;
use domain::notifications::run_notification_cycle;
use domain::publishing::Publishing;
use domain::studio::Studio;
use foundation::logger::{LogLevel, log};
use mtproto::MtprotoStories;
use providers::adapters::{AdapterContext, MediaPreparation, StoriesClient};
use providers::channels::loops::{
    CREDENTIALS, OBSERVABILITY, PLATFORM_TOKENS, X_TOKEN, credentials_tick, observability_interval, observability_tick,
    platform_tokens_tick, x_token_tick,
};
use runtime::http::HttpClient;
use runtime::scheduler::ScheduledLoop;
use runtime::worker_signal::{WorkerQueue, set_worker_wake};
use runtime::worker_state::{HeartbeatLoops, record_worker_state};
use serde_json::json;
use story_render::{STORY_CARD_WORKER, recover_story_card_jobs, run_story_card_cycle};

use crate::host::AppHost;

const WATCHDOG_INTERVAL: Duration = Duration::from_secs(60);
const SITE_JOB_POLL_INTERVAL: Duration = Duration::from_secs(10);
const MEDIA_CACHE_INTERVAL: Duration = Duration::from_secs(60 * 60);
const OPERATIONAL_RETENTION_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// What the delivery loops run with besides the bot.
#[derive(Clone)]
struct DeliveryDeps {
    bot: Bot,
    http: HttpClient,
    media: Rc<dyn MediaPreparation>,
    stories: Rc<dyn StoriesClient>,
}

impl DeliveryDeps {
    /// One cycle's delivery handle: the live configuration as it is now.
    fn delivery(&self) -> Delivery<'_> {
        let deps = self.bot.deps();
        Delivery::new(
            &deps.db,
            deps.host.publishing(),
            AdapterContext {
                config: deps.config.load(),
                client: self.http.clone(),
                clock: Rc::clone(&deps.clock),
            },
        )
    }
}

/// Recovers what a previous process left locked, then starts the core loops
/// and the Telegram ones, in a stable order; the publish queue is rung
/// the moment a publication puts work in the table.
/// `flush_usage` runs on every heartbeat, as `heartbeatLoop`'s hook does.
pub(crate) fn start(
    bot: &Bot,
    host: &AppHost,
    http: HttpClient,
    flush_usage: impl Fn(&BackendDb) + 'static,
) -> Vec<ScheduledLoop> {
    let deps = bot.deps();
    let delivery = DeliveryDeps {
        bot: bot.clone(),
        http: http.clone(),
        media: Rc::new(host.media.clone()),
        stories: Rc::new(MtprotoStories::new(deps.config.clone())),
    };
    recover_at_startup(&delivery);
    let loops = HeartbeatLoops::new(Rc::new(bot.clone()), |bot: &Bot| &bot.deps().db).on_heartbeat(flush_usage);
    let idle_poll = Duration::from_secs(deps.config.load().idle_poll_interval_seconds);
    let config = &deps.config;
    let queue = loops.start("queue", idle_poll, {
        let delivery = delivery.clone();
        move || publish_queue(delivery.clone())
    });
    set_worker_wake(WorkerQueue::Publish, Some(queue.waker()));
    let mut started = vec![
        loops.start(PLATFORM_TOKENS.0, PLATFORM_TOKENS.1, {
            let (bot, http) = (bot.clone(), http.clone());
            move || {
                let (bot, http) = (bot.clone(), http.clone());
                async move { platform_tokens_tick(&bot.deps().config, &bot.deps().db, &http).await }
            }
        }),
        loops.start(CREDENTIALS.0, CREDENTIALS.1, {
            let bot = bot.clone();
            move || {
                let bot = bot.clone();
                async move { credentials_tick(&bot.deps().config, &bot.deps().db).await }
            }
        }),
        loops.start(X_TOKEN.0, X_TOKEN.1, {
            let (bot, http) = (bot.clone(), http.clone());
            move || {
                let (bot, http) = (bot.clone(), http.clone());
                async move { x_token_tick(&bot.deps().config, &bot.deps().db, &http).await }
            }
        }),
        loops.start(STORY_CARD_WORKER, idle_poll, {
            let bot = bot.clone();
            move || story_cards(bot.clone())
        }),
        queue,
        loops.start("publish-watchdog", WATCHDOG_INTERVAL, {
            let delivery = delivery.clone();
            move || publish_watchdog(delivery.clone())
        }),
        loops.start("publication-reconciliation", idle_poll.max(Duration::from_secs(60)), {
            let delivery = delivery.clone();
            move || reconciliation(delivery.clone())
        }),
        loops.start("notifications", idle_poll, {
            let bot = bot.clone();
            move || notifications(bot.clone())
        }),
        loops.start("video", idle_poll, {
            let delivery = delivery.clone();
            move || video(delivery.clone())
        }),
        // Started whether or not this Studio serves a site, and idle while it
        // does not, so turning the site on needs no restart.
        loops.start("site", SITE_JOB_POLL_INTERVAL, {
            let delivery = delivery.clone();
            move || site(delivery.clone())
        }),
        loops.start("site-watchdog", WATCHDOG_INTERVAL, {
            let delivery = delivery.clone();
            move || site_watchdog(delivery.clone())
        }),
        loops.start("media-cache", MEDIA_CACHE_INTERVAL, {
            let delivery = delivery.clone();
            move || media_cache(delivery.clone())
        }),
        loops.start("operational-retention", OPERATIONAL_RETENTION_INTERVAL, {
            let delivery = delivery.clone();
            move || operational_retention(delivery.clone())
        }),
        loops.start(OBSERVABILITY, observability_interval(config), {
            let (bot, http) = (bot.clone(), http.clone());
            move || {
                let (bot, http) = (bot.clone(), http.clone());
                async move { observability_tick(&bot.deps().config, &bot.deps().db, &http).await }
            }
        }),
    ];
    started.extend(start_telegram_workers(bot, http, &loops));
    started
}

/// A restart leaves the old process's locks behind. They are taken back
/// after a short grace rather than the ordinary crash timeout, which only
/// avoids racing a request just interrupted at the provider. Site locks are
/// recovered whether or not the site is on: a crash left them either way.
fn recover_at_startup(delivery: &DeliveryDeps) {
    let d = delivery.delivery();
    let sqlite = d.sqlite();
    let recoveries: [(&str, Result<usize, String>); 3] = [
        (
            "publishing",
            d.publishing()
                .recover_stale_publish_jobs(PUBLISH_RESTART_LOCK_GRACE_SECONDS)
                .map_err(|error| error.to_string()),
        ),
        (
            "site build",
            recover_stale_site_jobs(&d, SITE_JOB_RESTART_LOCK_GRACE_SECONDS).map_err(|error| error.to_string()),
        ),
        (
            "Story card",
            recover_story_card_jobs(sqlite, d.clock()).map_err(|error| error.to_string()),
        ),
    ];
    for (what, recovered) in recoveries {
        match recovered {
            Ok(0) => {}
            Ok(recovered) => log(
                LogLevel::Warn,
                &format!("recovered interrupted {what} locks on worker startup"),
                Some(json!({"recovered": recovered})),
            ),
            Err(error) => log(
                LogLevel::Error,
                &format!("{what} locks could not be recovered on worker startup"),
                Some(json!({"error": error})),
            ),
        }
    }
}

async fn publish_queue(delivery: DeliveryDeps) -> Result<(), String> {
    let started = Instant::now();
    let d = delivery.delivery();
    let ports = delivery_ports(&d, Rc::clone(&delivery.media), Rc::clone(&delivery.stories))
        .map_err(|error| error.to_string())?;
    let claimed = run_delivery_publish_cycle(&d, &ports)
        .await
        .map_err(|error| error.to_string())?;
    timed("publishing.social.cycle", "claimed", claimed, started);
    Ok(())
}

/// Independent from delivery: a hung provider call must not keep stale
/// publishing locks from the bounded retry policy.
async fn publish_watchdog(delivery: DeliveryDeps) -> Result<(), String> {
    let recovered = recover_stale_publish_jobs(&delivery.delivery()).map_err(|error| error.to_string())?;
    if recovered > 0 {
        log(
            LogLevel::Warn,
            "recovered stale publishing locks",
            Some(json!({"recovered": recovered})),
        );
    }
    Ok(())
}

async fn reconciliation(delivery: DeliveryDeps) -> Result<(), String> {
    let result = run_publication_reconciliation(&delivery.delivery())
        .await
        .map_err(|error| error.to_string())?;
    log(
        LogLevel::Debug,
        "publication reconciliation loop tick",
        serde_json::to_value(result).ok(),
    );
    Ok(())
}

async fn video(delivery: DeliveryDeps) -> Result<(), String> {
    let started = Instant::now();
    let claimed = run_video_cycle(&delivery.delivery())
        .await
        .map_err(|error| error.to_string())?;
    timed("publishing.video.cycle", "claimed", claimed, started);
    Ok(())
}

async fn site(delivery: DeliveryDeps) -> Result<(), String> {
    let d = delivery.delivery();
    if !site_enabled(&d).map_err(|error| error.to_string())? {
        return Ok(());
    }
    let started = Instant::now();
    let claimed = run_site_job_cycle(&d).await.map_err(|error| error.to_string())?;
    timed("publishing.site.cycle", "claimed", claimed, started);
    Ok(())
}

async fn site_watchdog(delivery: DeliveryDeps) -> Result<(), String> {
    let d = delivery.delivery();
    if !site_enabled(&d).map_err(|error| error.to_string())? {
        return Ok(());
    }
    let recovered = recover_stale_site_jobs(&d, SITE_JOB_LOCK_TIMEOUT_SECONDS).map_err(|error| error.to_string())?;
    if recovered > 0 {
        log(
            LogLevel::Warn,
            "recovered stale site build locks",
            Some(json!({"recovered": recovered})),
        );
    }
    Ok(())
}

async fn media_cache(delivery: DeliveryDeps) -> Result<(), String> {
    let d = delivery.delivery();
    let removed = prune_media_cache(d.config(), d.now_ms()).await;
    if removed > 0 {
        log(
            LogLevel::Info,
            "pruned expired media cache",
            Some(json!({"removed": removed})),
        );
    }
    Ok(())
}

async fn operational_retention(delivery: DeliveryDeps) -> Result<(), String> {
    let d = delivery.delivery();
    let (sqlite, clock) = (d.sqlite(), d.clock());
    let result = with_maintenance_lock(sqlite, clock, || prune_operational_history(sqlite, clock))
        .map_err(|error| error.to_string())?;
    if result.total > 0 {
        log(
            LogLevel::Info,
            "pruned operational history",
            serde_json::to_value(result).ok(),
        );
    }
    Ok(())
}

async fn notifications(bot: Bot) -> Result<(), String> {
    let deps = bot.deps();
    let delivered = run_notification_cycle(unsafe_db(&deps.db), &*deps.clock).map_err(|error| error.to_string())?;
    log(
        LogLevel::Debug,
        "notification loop tick",
        Some(json!({"delivered": delivered})),
    );
    Ok(())
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
    timed("content.story_card.cycle", "claimed", cycle.claimed as usize, started);
    Ok(())
}

/// `runTimedCycle`: a cycle that did something says how long it took.
fn timed(operation: &str, count_name: &str, count: usize, started: Instant) {
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
