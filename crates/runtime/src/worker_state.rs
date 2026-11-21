//! What each background loop last reported (`foundation/runtime/worker-state.ts`):
//! the `worker_state` row a cycle writes, the heartbeat a running loop keeps
//! fresh, and the names `status` and `/readyz` expect to find.

use std::cell::Cell;
use std::fmt::Display;
use std::rc::Rc;
use std::time::Duration;

use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{self, params_from_iter};
use db::{BackendDb, unsafe_db};
use foundation::time::to_iso_string;
use jiff::Timestamp;
use serde_json::{Map, Value};

use crate::scheduler::{LoopHooks, ScheduledLoop, start_loop};

/// How often a running loop says it is still alive.
const WORKER_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);

/// `recordWorkerState`: a finished cycle's counters and verdict, replacing
/// whatever the row held.
pub fn record_worker_state(
    db: &BackendDb,
    name: &str,
    mut state: Map<String, Value>,
    error: Option<&str>,
    now: Timestamp,
) -> rusqlite::Result<()> {
    let now = to_iso_string(now);
    // Inserting an existing key keeps its position, as a spread does.
    state.insert("ok".into(), error.is_none().into());
    state.insert("last_run_at".into(), now.clone().into());
    state.insert("last_error".into(), error.into());
    state.insert("scheduler_error".into(), Value::Null);
    state.insert("last_heartbeat_at".into(), now.clone().into());
    let payload = Value::Object(state).to_string();
    unsafe_db(db).execute(
        "INSERT INTO worker_state (name, state_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (name) DO UPDATE SET state_json = ?2, updated_at = ?3",
        (name, payload, now),
    )?;
    Ok(())
}

/// `recordWorkerHeartbeat`: lifecycle fields over the row's own, without
/// touching a cycle's counters or verdict. The merge is the write itself
/// (`json_set` keeps a key where it is and appends a new one, as the spread
/// did), so nothing read beforehand can be stale by then.
fn record_worker_heartbeat(
    db: &BackendDb,
    name: &str,
    state: &[(&'static str, SqlValue)],
    scheduler_error: Option<&str>,
    now: Timestamp,
) -> rusqlite::Result<()> {
    let now = to_iso_string(now);
    let mut fields: Vec<(&str, SqlValue)> = state.to_vec();
    fields.push((
        "scheduler_error",
        scheduler_error.map_or(SqlValue::Null, |error| SqlValue::Text(error.into())),
    ));
    fields.push(("last_heartbeat_at", SqlValue::Text(now.clone())));
    let paths: String = (0..fields.len())
        .map(|index| format!(", '$.{}', ?{}", fields[index].0, index + 3))
        .collect();
    let sql = format!(
        "INSERT INTO worker_state (name, state_json, updated_at) VALUES (?1, json_set('{{}}'{paths}), ?2)
         ON CONFLICT (name) DO UPDATE SET state_json = json_set(worker_state.state_json{paths}), updated_at = ?2"
    );
    let mut values = vec![SqlValue::Text(name.into()), SqlValue::Text(now)];
    values.extend(fields.into_iter().map(|(_, value)| value));
    unsafe_db(db).execute(&sql, params_from_iter(values))?;
    Ok(())
}

pub const CORE_WORKER_NAMES: [&str; 14] = [
    "story-cards",
    "queue",
    "publish-watchdog",
    "publication-reconciliation",
    "notifications",
    "video",
    "site",
    "site-watchdog",
    "media-cache",
    "operational-retention",
    "observability",
    "platform-tokens",
    "credentials",
    "x-token",
];

/// The interface loops: the daily digest, the database backup and every alert.
pub const TELEGRAM_WORKER_NAMES: [&str; 5] = [
    "telegram-albums",
    "telegram-translations",
    "telegram-events",
    "telegram-alerts",
    "telegram-daily-backup",
];

/// Telegram loops are expected only where a controller bot is configured; a
/// Studio driven entirely through MCP never starts them.
pub fn expected_worker_names(telegram_enabled: bool) -> Vec<&'static str> {
    let mut names = CORE_WORKER_NAMES.to_vec();
    if telegram_enabled {
        names.extend(TELEGRAM_WORKER_NAMES);
    }
    names
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkerLiveness {
    /// NaN when the heartbeat is not a date `Date.parse` reads.
    pub age_seconds: f64,
    pub stale: bool,
    pub last_heartbeat_at: String,
}

/// `workerLiveness(state, updatedAt)`: a loop is stale after three missed
/// heartbeats, and never sooner than two minutes.
pub fn worker_liveness(state: &Map<String, Value>, updated_at: &str, now: Timestamp) -> WorkerLiveness {
    let last_heartbeat_at = state
        .get("last_heartbeat_at")
        .and_then(Value::as_str)
        .unwrap_or(updated_at)
        .to_owned();
    let age_seconds = match last_heartbeat_at.parse::<Timestamp>() {
        Ok(at) => (((now.as_millisecond() - at.as_millisecond()) as f64 / 1000.0 + 0.5).floor()).max(0.0),
        Err(_) => f64::NAN,
    };
    let interval_ms = state.get("heartbeat_interval_ms").and_then(Value::as_f64);
    let stale_after = interval_ms.map(|interval| (interval / 1000.0 * 3.0).ceil().max(120.0));
    WorkerLiveness {
        age_seconds,
        stale: stale_after.is_some_and(|after| age_seconds > after),
        last_heartbeat_at,
    }
}

/// `heartbeatLoop`: every loop through one factory, because a loop that
/// records no heartbeat is a loop `status` cannot see. `db` reaches the
/// database through whatever owns it.
pub struct HeartbeatLoops<D> {
    source: Rc<D>,
    db: fn(&D) -> &BackendDb,
    on_heartbeat: Option<HeartbeatHook>,
}

type HeartbeatHook = Rc<dyn Fn(&BackendDb)>;

impl<D: 'static> HeartbeatLoops<D> {
    pub fn new(source: Rc<D>, db: fn(&D) -> &BackendDb) -> Self {
        Self {
            source,
            db,
            on_heartbeat: None,
        }
    }

    /// Also run on every heartbeat, before it is recorded (the usage flush).
    pub fn on_heartbeat(mut self, hook: impl Fn(&BackendDb) + 'static) -> Self {
        self.on_heartbeat = Some(Rc::new(hook));
        self
    }

    pub fn start<F, T, E>(&self, name: &str, interval: Duration, task: F) -> ScheduledLoop
    where
        F: Fn() -> T + 'static,
        T: Future<Output = Result<(), E>> + 'static,
        E: Display,
    {
        start_loop(name, interval, task, self.hooks(name))
    }

    /// The hooks [`start`](Self::start) runs the loop with.
    pub fn hooks(&self, name: &str) -> LoopHooks {
        let interval_ms = i64::try_from(WORKER_HEARTBEAT_INTERVAL.as_millis()).expect("a minute fits");
        // The first cycle, and the first after a failure, announce the loop.
        let publish_startup = Rc::new(Cell::new(true));
        let record = {
            let source = Rc::clone(&self.source);
            let db = self.db;
            let name = name.to_owned();
            move |state: &[(&'static str, SqlValue)], error: Option<&str>| {
                record_worker_heartbeat(db(&source), &name, state, error, Timestamp::now())
                    .map_err(|error| error.to_string())
            }
        };
        let record = Rc::new(record);
        LoopHooks {
            on_start: Some(Box::new({
                let (record, publish_startup) = (Rc::clone(&record), Rc::clone(&publish_startup));
                move || {
                    if !publish_startup.replace(false) {
                        return Ok(());
                    }
                    record(
                        &[
                            ("phase", SqlValue::Text("running".into())),
                            ("heartbeat_interval_ms", SqlValue::Integer(interval_ms)),
                        ],
                        None,
                    )
                }
            })),
            on_heartbeat: Some(Box::new({
                let record = Rc::clone(&record);
                let (source, db, extra) = (Rc::clone(&self.source), self.db, self.on_heartbeat.clone());
                move || {
                    if let Some(extra) = &extra {
                        extra(db(&source));
                    }
                    record(&[("heartbeat_interval_ms", SqlValue::Integer(interval_ms))], None)
                }
            })),
            heartbeat_interval: Some(WORKER_HEARTBEAT_INTERVAL),
            on_finish: Some(Box::new(move |error: Option<&str>| {
                let Some(error) = error else {
                    return Ok(());
                };
                publish_startup.set(true);
                record(
                    &[
                        ("phase", SqlValue::Text("failed".into())),
                        ("heartbeat_interval_ms", SqlValue::Integer(interval_ms)),
                    ],
                    Some(error),
                )
            })),
        }
    }
}
