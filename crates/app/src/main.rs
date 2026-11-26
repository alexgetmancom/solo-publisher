//! `solo-publisher`: the Studio process: the configuration, the database, the Telegram bot on long polling, the
//! workers and the HTTP surface, over the host's boundaries (`host.rs`).

mod host;
mod workers;

use std::process::ExitCode;
use std::rc::Rc;
use std::time::Duration;

use bot::api::transport::HttpTransport;
use bot::deployment::HttpDeployAgent;
use bot::{Bot, BotDeps, runner};
use db::BackendDb;
use domain::application::ports::SystemClock;
use foundation::config::{Config, SharedConfig, load_config};
use foundation::logger::{LogLevel, configure_logging, log};
use http_edge::{BotBackend, HttpState};
use ops::host::OpsAdapters;
use runtime::http::{HttpClient, ReqwestTransport};
use runtime::scheduler::ScheduledLoop;
use runtime::worker_signal::{WorkerQueue, set_worker_wake};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::signal::unix::{Signal, SignalKind, signal};

use crate::host::AppHost;

/// A shutdown that has not finished by then exits with 1.
const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(10);

fn main() -> ExitCode {
    // The boot time the memory probe reports is the process's.
    channels::observability::memory::process_boot();
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
    let http = match ReqwestTransport::new() {
        Ok(transport) => HttpClient::new(Rc::new(transport)),
        Err(error) => {
            log(
                LogLevel::Error,
                "HTTP transport could not be built",
                Some(json!({"error": error.message})),
            );
            return ExitCode::FAILURE;
        }
    };
    let config = SharedConfig::new(config);
    let host = Rc::new(AppHost::new(config.clone(), http.clone()));
    // The bot lives on one thread (see the bot crate).
    let local = tokio::task::LocalSet::new();
    let (bot, code) = local.block_on(&runtime, run(config, Rc::clone(&host), http, &token, db));
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

/// Builds the bot, polls and serves HTTP until SIGINT/SIGTERM or until polling
/// ends on its own, and stops them. Returns the bot, when one was built, for
/// its database.
async fn run(
    config: SharedConfig,
    host: Rc<AppHost>,
    http: HttpClient,
    token: &str,
    db: BackendDb,
) -> (Option<Bot>, ExitCode) {
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
        config: config.clone(),
        host: Rc::clone(&host) as _,
        adapters: OpsAdapters::boxed(http.clone(), config),
        transport: Rc::new(transport),
        deploy_agent: Rc::new(deploy_agent),
    });
    let (mut interrupt, mut terminate) = match (signal(SignalKind::interrupt()), signal(SignalKind::terminate())) {
        (Ok(interrupt), Ok(terminate)) => (interrupt, terminate),
        (Err(error), _) | (_, Err(error)) => {
            return failed(Some(bot), "signal handlers could not be installed", &error.to_string());
        }
    };
    // Bound before anything starts, so a taken port fails the process at once.
    let bind_host = bot.deps().config.load().bind_host.clone();
    let listener = match listen(&bot.deps().config.load()).await {
        Ok(listener) => listener,
        Err(error) => return failed(Some(bot), "HTTP server could not listen", &error),
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
    let loops = workers::start(&bot, &host, http.clone(), {
        let host = Rc::clone(&host);
        move |db| host.flush_usage(db::unsafe_db(db))
    });
    let port = listener.local_addr().map(|address| address.port()).ok();
    let (stop_http, http_stopping) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::task::spawn_local(http_edge::serve(
        listener,
        HttpState::new(Rc::new(BotBackend { bot: bot.clone(), http })),
        async {
            let _ = http_stopping.await;
        },
    ));
    log(
        LogLevel::Info,
        "studio listening",
        Some(json!({"hostname": bind_host, "port": port})),
    );
    log(
        LogLevel::Info,
        "studio started",
        Some(json!({
            "runs": ["telegram bot (long polling)", "workers", "http server"],
            "workers": loops.iter().map(ScheduledLoop::name).collect::<Vec<_>>(),
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
        // `server.stop()`: no new connections, and the requests in flight
        // are answered before the bot and the loops stop.
        let _ = stop_http.send(());
        let _ = server.await;
        let stopped = runner.stop().await;
        for scheduled in &loops {
            scheduled.stop().await;
        }
        // The doorbells hold their loops, and the loops the bot.
        set_worker_wake(WorkerQueue::Publish, None);
        set_worker_wake(WorkerQueue::TelegramEvents, None);
        domain::repositories::set_event_bell(None);
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

/// `Bun.serve`'s `hostname` and `port`.
async fn listen(config: &Config) -> Result<TcpListener, String> {
    let port = u16::try_from(config.port).map_err(|_| format!("PORT {} is not a TCP port", config.port))?;
    TcpListener::bind((config.bind_host.as_str(), port))
        .await
        .map_err(|error| format!("{}:{port}: {error}", config.bind_host))
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
