//! The probes of one observability tick, each on
//! its own so a throwing one cannot blind the rest, then the alerts they
//! produced, then the cycle's own worker record.

use std::fmt::Display;

use db::{BackendDb, unsafe_db};
use domain::application::ports::Clock;
use domain::observability::alerts::deliver_pending_alerts;
use domain::observability::credentials::update_credential_checks;
use domain::observability::failures::record_publication_failures;
use domain::observability::runtime_health::{ProcessBoot, record_memory_pressure, record_process_restart};
use foundation::config::Config;
use foundation::logger::{LogLevel, log};
use runtime::http::{Fut, HttpClient};
use runtime::worker_state::record_worker_state;
use serde::Serialize;
use serde_json::{Map, json};

use crate::channels::observability::memory::MemorySnapshot;
use crate::channels::observability::token_health::check_token_health;

/// What the cycle reads from the process, read once by the caller.
#[derive(Clone, Copy, Debug)]
pub struct ProcessReading<'a> {
    pub boot: ProcessBoot<'a>,
    /// The build this process runs (`gitRevision()`).
    pub revision: Option<&'a str>,
    pub memory: MemorySnapshot,
    /// The container ceiling (`cgroupMemoryLimitBytes()`).
    pub memory_limit_bytes: Option<u64>,
}

/// Sends one alert text (`AlertPort.sendAlert`).
pub type SendAlert<'a> = &'a dyn Fn(String) -> Fut<'a, Result<(), String>>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CycleResult {
    pub alerts: usize,
    pub credentials: usize,
}

fn to_mb(bytes: u64) -> i64 {
    (bytes as f64 / 1024.0 / 1024.0 + 0.5).floor() as i64
}

/// A steady climb in rss across cycles, rather than a sawtooth, is the signal
/// to reach for a heap profile.
fn log_memory_usage(memory: &MemorySnapshot) {
    log(
        LogLevel::Info,
        "process memory usage",
        Some(json!({"rssMb": to_mb(memory.rss_bytes)})),
    );
}

fn probe<E: Display>(name: &str, outcome: Result<(), E>) {
    if let Err(error) = outcome {
        log(
            LogLevel::Error,
            "observability probe failed",
            Some(json!({"probe": name, "error": format!("Error: {error}")})),
        );
    }
}

/// `runObservabilityCycle`: restart and memory pressure first, because they
/// record events this same cycle can then deliver; credential checks, token
/// health, publication failures; alert delivery; the worker record.
pub async fn run_observability_cycle(
    config: &Config,
    db: &BackendDb,
    http: &HttpClient,
    clock: &dyn Clock,
    process: &ProcessReading<'_>,
    send_alert: Option<SendAlert<'_>>,
) -> Result<CycleResult, db::rusqlite::Error> {
    let sqlite = unsafe_db(db);
    log_memory_usage(&process.memory);
    let mut result = CycleResult::default();
    probe(
        "runtime-restart",
        record_process_restart(sqlite, clock, process.boot, process.revision).map(drop),
    );
    probe(
        "memory-pressure",
        record_memory_pressure(sqlite, clock, process.memory.rss_bytes, process.memory_limit_bytes).map(drop),
    );
    probe(
        "credentials",
        update_credential_checks(config, sqlite, clock).map(|count| result.credentials = count),
    );
    probe(
        "token-health",
        check_token_health(config, sqlite, http, clock).await.map(drop),
    );
    probe("publication-failures", record_publication_failures(sqlite, clock));
    probe(
        "alerts",
        deliver_pending_alerts(sqlite, clock, send_alert)
            .await
            .map(|sent| result.alerts = sent),
    );
    let mut state = Map::new();
    state.insert("alerts".into(), result.alerts.into());
    state.insert("credentials".into(), result.credentials.into());
    record_worker_state(db, "observability", state, None, clock.now())?;
    Ok(result)
}
