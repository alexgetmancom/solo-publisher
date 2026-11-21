//! `solo-publisher`: the Studio process (`apps/backend/src/runtime/server.ts`)
//! restricted to what the Rust build has ported — the configuration, the
//! database and the Telegram bot on long polling. The HTTP surface and the
//! workers come with their phases (plans/rust/PLAN.md); the boundaries are
//! the ported stores, and every one whose owner is not here yet refuses
//! loudly (`unported.rs`).

mod unported;
mod workers;

use std::process::ExitCode;
use std::rc::Rc;
use std::time::Duration;

use bot::api::transport::HttpTransport;
use bot::deployment::HttpDeployAgent;
use bot::{Bot, BotDeps, DynAdapters, runner};
use db::BackendDb;
use domain::application::ports::SystemClock;
use foundation::config::{SharedConfig, load_config};
use foundation::logger::{LogLevel, configure_logging, log};
use runtime::http::{HttpClient, ReqwestTransport};
use runtime::scheduler::ScheduledLoop;
use serde_json::json;
use tokio::signal::unix::{Signal, SignalKind, signal};

use crate::unported::{AppAdapters, AppHost};

/// As server.ts: a shutdown that has not finished by then exits with 1.
const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(10);

fn main() -> ExitCode {
    // A variable that is not UTF-8 is none of this Studio's settings.
    let vars =
        std::env::vars_os().filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)));
    let config = match load_config(vars) {
        Ok(config) => config,
        Err(error) => {
            log(LogLevel::Error, &error.to_string(), None);
            return ExitCode::FAILURE;
        }
    };
    configure_logging(config.log_level);
    let Some(token) = config.controller_bot_token.clone() else {
        log(
            LogLevel::Error,
            "Telegram bot token is not configured; this build runs only the bot",
            Some(json!({"setting": "CONTROLLER_BOT_TOKEN"})),
        );
        return ExitCode::FAILURE;
    };
    let db = match BackendDb::open(&config.pipeline_db) {
        Ok(db) => db,
        Err(error) => {
            log(
                LogLevel::Error,
                "database could not be opened",
                Some(json!({"path": config.pipeline_db.display().to_string(), "error": error.to_string()})),
            );
            return ExitCode::FAILURE;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            log(
                LogLevel::Error,
                "runtime could not start",
                Some(json!({"error": error.to_string()})),
            );
            return ExitCode::FAILURE;
        }
    };
    let config = SharedConfig::new(config);
    let host = Rc::new(AppHost::new(config.clone()));
    // The bot lives on one thread (see the bot crate).
    let local = tokio::task::LocalSet::new();
    let (bot, code) = local.block_on(&runtime, run(config, Rc::clone(&host), &token, db));
    // Ends whatever background work outlived the shutdown wait, so the bot's
    // last handle is ours and the database closes here.
    drop(local);
    let Some(bot) = bot else { return code };
    match bot.into_deps() {
        Ok(deps) => {
            host.flush_usage(db::unsafe_db(&deps.db));
            if let Err(error) = deps.db.close() {
                log(
                    LogLevel::Error,
                    "database did not close",
                    Some(json!({"error": error.to_string()})),
                );
                return ExitCode::FAILURE;
            }
        }
        Err(_) => log(
            LogLevel::Error,
            "the bot is still referenced; the database closes on exit",
            None,
        ),
    }
    code
}

/// Builds the bot, polls until SIGINT/SIGTERM or until polling ends on its
/// own, and stops it. Returns the bot, when one was built, for its database.
async fn run(config: SharedConfig, host: Rc<AppHost>, token: &str, db: BackendDb) -> (Option<Bot>, ExitCode) {
    let transport = match HttpTransport::new(&config.load().telegram_api_base_url, token) {
        Ok(transport) => transport,
        Err(error) => return failed(None, "Telegram transport could not be built", &error.0),
    };
    let deploy_agent = match HttpDeployAgent::new() {
        Ok(agent) => agent,
        Err(error) => return failed(None, "deploy agent client could not be built", &error),
    };
    let bot = Bot::new(BotDeps {
        db,
        clock: Rc::new(SystemClock),
        config,
        host: Rc::clone(&host) as _,
        adapters: DynAdapters(Box::new(AppAdapters)),
        transport: Rc::new(transport),
        deploy_agent: Rc::new(deploy_agent),
    });
    let (mut interrupt, mut terminate) = match (signal(SignalKind::interrupt()), signal(SignalKind::terminate())) {
        (Ok(interrupt), Ok(terminate)) => (interrupt, terminate),
        (Err(error), _) | (_, Err(error)) => {
            return failed(Some(bot), "signal handlers could not be installed", &error.to_string());
        }
    };
    // `getMe` can wait as long as the request timeout; a signal still stops it.
    let started = tokio::select! {
        started = runner::start(&bot) => started,
        signal = next_signal(&mut interrupt, &mut terminate) => {
            log(LogLevel::Info, "shutdown requested", Some(json!({"signal": signal})));
            return (Some(bot), ExitCode::SUCCESS);
        }
    };
    let runner = match started {
        Ok(runner) => runner,
        Err(error) => return failed(Some(bot), "Telegram bot could not start", &error.to_string()),
    };
    let http = match ReqwestTransport::new() {
        Ok(transport) => HttpClient::new(Rc::new(transport)),
        Err(error) => return failed(Some(bot), "HTTP transport could not be built", &error.message),
    };
    let loops = workers::start(&bot, http, {
        let host = Rc::clone(&host);
        move |db| host.flush_usage(db::unsafe_db(db))
    });
    let not_in_this_build = [
        [
            "http server",
            "the other workers",
            "stored platform credentials (channels)",
        ]
        .as_slice(),
        unported::AREAS.as_slice(),
    ]
    .concat();
    log(
        LogLevel::Info,
        "studio started",
        Some(json!({
            "runs": ["telegram bot (long polling)", "workers"],
            "workers": loops.iter().map(ScheduledLoop::name).collect::<Vec<_>>(),
            "notInThisBuild": not_in_this_build,
        })),
    );
    let signal = tokio::select! {
        signal = next_signal(&mut interrupt, &mut terminate) => signal,
        () = runner.ended() => {
            let reason = match runner.stop().await {
                Ok(()) => "polling ended".to_owned(),
                Err(error) => error.to_string(),
            };
            return failed(Some(bot), "Telegram polling stopped", &reason);
        }
    };
    log(LogLevel::Info, "shutdown requested", Some(json!({"signal": signal})));
    let stopping = async {
        let stopped = runner.stop().await;
        for scheduled in &loops {
            scheduled.stop().await;
        }
        // Updates already handed out finish before the database closes.
        bot.settled().await;
        stopped
    };
    match tokio::time::timeout(SHUTDOWN_DEADLINE, stopping).await {
        Ok(Ok(())) => (Some(bot), ExitCode::SUCCESS),
        Ok(Err(error)) => failed(Some(bot), "Telegram polling ended with an error", &error.to_string()),
        Err(_) => {
            log(
                LogLevel::Error,
                "shutdown did not finish in time",
                Some(json!({"seconds": SHUTDOWN_DEADLINE.as_secs()})),
            );
            std::process::exit(1);
        }
    }
}

async fn next_signal(interrupt: &mut Signal, terminate: &mut Signal) -> &'static str {
    tokio::select! {
        _ = interrupt.recv() => "SIGINT",
        _ = terminate.recv() => "SIGTERM",
    }
}

fn failed(bot: Option<Bot>, message: &str, error: &str) -> (Option<Bot>, ExitCode) {
    log(LogLevel::Error, message, Some(json!({"error": error})));
    (bot, ExitCode::FAILURE)
}
