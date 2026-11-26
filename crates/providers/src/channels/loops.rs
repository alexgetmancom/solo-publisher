//! The bodies of the four background loops `channels` owns,
//! each one tick; the binary runs them through
//! `runtime::worker_state::HeartbeatLoops::start` under the names and
//! intervals below.

use std::time::Duration;

use db::{BackendDb, unsafe_db};
use domain::application::ports::{Clock, SystemClock};
use foundation::config::SharedConfig;
use foundation::logger::{LogLevel, log};
use runtime::http::HttpClient;
use serde_json::json;

use crate::channels::credentials::apply_stored_credentials;
use crate::channels::meta::{RenewalStatus, renew_meta_tokens};
use crate::channels::observability::cycle::{ProcessReading, run_observability_cycle};
use crate::channels::observability::memory::{cgroup_memory_limit_bytes, process_boot, read_memory_snapshot};
use crate::channels::x::{XRefresh, refresh_x_token};
use crate::channels::{Error, Result};

/// Meta renews by issuing a new token and a lapsed one cannot be renewed, so
/// this runs far from the edge and renews anything a month old.
pub const PLATFORM_TOKENS: (&str, Duration) = ("platform-tokens", Duration::from_secs(6 * 60 * 60));
/// Cheap and frequent on purpose: a credential an operator stores reaches the
/// workers within a minute instead of at the next restart.
pub const CREDENTIALS: (&str, Duration) = ("credentials", Duration::from_secs(60));
pub const X_TOKEN: (&str, Duration) = ("x-token", Duration::from_secs(10 * 60));
pub const OBSERVABILITY: &str = "observability";

/// `OBSERVABILITY_INTERVAL_SECONDS`, 300 by default.
pub fn observability_interval(config: &SharedConfig) -> Duration {
    Duration::from_secs(config.load().observability_interval_seconds)
}

/// `platform-tokens`.
pub async fn platform_tokens_tick(config: &SharedConfig, db: &BackendDb, http: &HttpClient) -> Result<()> {
    let outcomes = renew_meta_tokens(config, unsafe_db(db), http, SystemClock.now()).await?;
    let renewed: Vec<&str> = outcomes
        .iter()
        .filter(|outcome| outcome.status == RenewalStatus::Renewed)
        .map(|outcome| outcome.target)
        .collect();
    if !renewed.is_empty() {
        log(
            LogLevel::Info,
            "platform tokens renewed",
            Some(json!({"targets": renewed})),
        );
    }
    Ok(())
}

/// `credentials`.
pub async fn credentials_tick(config: &SharedConfig, db: &BackendDb) -> Result<()> {
    apply_stored_credentials(config, unsafe_db(db))
}

/// `x-token`.
pub async fn x_token_tick(config: &SharedConfig, db: &BackendDb, http: &HttpClient) -> Result<()> {
    match refresh_x_token(config, unsafe_db(db), http, SystemClock.now()).await? {
        XRefresh::Refreshed => log(LogLevel::Info, "X access token refreshed", None),
        XRefresh::Superseded => log(
            LogLevel::Info,
            "X token refresh superseded by a newer connection; kept the newer pair",
            None,
        ),
        XRefresh::Fresh | XRefresh::Unconfigured => {}
    }
    Ok(())
}

/// `observability`: the cycle over this process, alerts left for the
/// transport that delivers them.
pub async fn observability_tick(config: &SharedConfig, db: &BackendDb, http: &HttpClient) -> Result<()> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let revision = runtime::git::git_revision(&cwd);
    let process = ProcessReading {
        boot: process_boot(),
        revision: revision.as_deref(),
        memory: read_memory_snapshot(),
        memory_limit_bytes: cgroup_memory_limit_bytes(),
    };
    let result = run_observability_cycle(&config.load(), db, http, &SystemClock, &process, None)
        .await
        .map_err(|error| Error::Domain(error.into()))?;
    log(
        LogLevel::Debug,
        "observability loop tick",
        Some(json!({"alerts": result.alerts, "credentials": result.credentials})),
    );
    Ok(())
}
