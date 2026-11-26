//! Runtime health over what the caller read from the process: process
//! replacement as a durable event (escalated only when restarts of one build
//! cluster), and memory pressure while the process is still alive to report it.

use db::rusqlite::{Connection, OptionalExtension};
use foundation::time::{parse_iso_instant, to_iso_string};
use jiff::Timestamp;
use serde_json::{Map, Value, json};

use crate::Result;
use crate::application::ports::{Clock, DomainEventInput, Severity};
use crate::observability::alerts::ALERT_COOLDOWN_SECONDS;
use crate::repositories::{record_event, stamp};

const RUNTIME_STATE_KEY: &str = "runtime";
const RESTART_WINDOW_SECONDS: i64 = 30 * 60;
const RESTART_ALERT_THRESHOLD: usize = 3;
const MEMORY_ALERT_PERCENT: f64 = 85.0;

/// This process: an identity a replacement does not share, and when it started.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessBoot<'a> {
    pub id: &'a str,
    pub booted_at: Timestamp,
}

#[derive(Default)]
struct RuntimeState {
    boot_id: Option<String>,
    booted_at: Option<String>,
    /// The build the previous process ran; a restart that changes it is a deployment.
    revision: Option<String>,
    restarts_at: Vec<String>,
}

fn read_runtime_state(sqlite: &Connection) -> Result<RuntimeState> {
    let stored: Option<String> = sqlite
        .query_row(
            r#"select "state_json" from "worker_state" where "worker_state"."name" = ?"#,
            [RUNTIME_STATE_KEY],
            |row| row.get(0),
        )
        .optional()?;
    let Some(Value::Object(state)) = stored.as_deref().map(serde_json::from_str::<Value>).transpose()? else {
        return Ok(RuntimeState::default());
    };
    let text = |key: &str| state.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(RuntimeState {
        boot_id: text("bootId"),
        booted_at: text("bootedAt"),
        revision: text("revision"),
        restarts_at: state
            .get("restartsAt")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default(),
    })
}

fn write_runtime_state(
    sqlite: &Connection,
    clock: &dyn Clock,
    boot_id: &str,
    booted_at: &str,
    revision: Option<&str>,
    restarts_at: &[String],
) -> Result<()> {
    let now = stamp(clock);
    let payload = crate::json::stringify(&json!({
        "bootId": boot_id,
        "bootedAt": booted_at,
        "revision": revision,
        "restartsAt": restarts_at,
    }));
    sqlite.execute(
        r#"insert into "worker_state" ("name", "state_json", "updated_at") values (?1, ?2, ?3) on conflict ("worker_state"."name") do update set "state_json" = ?2, "updated_at" = ?3"#,
        (RUNTIME_STATE_KEY, payload, now),
    )?;
    Ok(())
}

fn parse_ms(value: &str) -> Option<i64> {
    parse_iso_instant(value).ok().map(|at| at.as_millisecond())
}

/// `Math.round`: halves round up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `recordProcessRestart`: `true` when a restart was recorded. A single
/// restart is normal — every deploy is one — and is recorded at `info`, which
/// no alert transport picks up; restarts of one build clustering are `error`.
pub fn record_process_restart(
    sqlite: &Connection,
    clock: &dyn Clock,
    boot: ProcessBoot<'_>,
    revision: Option<&str>,
) -> Result<bool> {
    let previous = read_runtime_state(sqlite)?;
    let booted_at = to_iso_string(boot.booted_at);
    if previous.boot_id.as_deref() == Some(boot.id) {
        return Ok(false);
    }
    // No previous boot id at all is a fresh database, not a restart.
    if previous.boot_id.is_none() {
        write_runtime_state(sqlite, clock, boot.id, &booted_at, revision, &[])?;
        return Ok(false);
    }
    // A burst of deployments is an afternoon of work, not a crash loop: only
    // restarts of the same build accumulate towards the alert.
    let deployed = revision.is_some() && previous.revision.is_some() && revision != previous.revision.as_deref();
    let window_start = clock.now().as_millisecond() - RESTART_WINDOW_SECONDS * 1000;
    let restarts_at: Vec<String> = if deployed {
        vec![booted_at.clone()]
    } else {
        let kept: Vec<String> = previous
            .restarts_at
            .iter()
            .cloned()
            .chain([booted_at.clone()])
            .filter(|at| parse_ms(at).is_some_and(|at| at >= window_start))
            .collect();
        kept[kept.len().saturating_sub(20)..].to_vec()
    };
    let looping = restarts_at.len() >= RESTART_ALERT_THRESHOLD;
    write_runtime_state(sqlite, clock, boot.id, &booted_at, revision, &restarts_at)?;

    // `null` without a previous boot time; NaN (written as null, printed as
    // "NaN") when that time does not parse.
    let previous_uptime: Option<Option<f64>> = previous.booted_at.as_deref().map(|previous| {
        parse_ms(previous).map(|previous| js_round((boot.booted_at.as_millisecond() - previous) as f64 / 1000.0))
    });
    let uptime_json = match previous_uptime {
        Some(Some(seconds)) => json!(seconds as i64),
        _ => Value::Null,
    };
    let uptime_text = match previous_uptime {
        None => "?".to_owned(),
        Some(None) => "NaN".to_owned(),
        Some(Some(seconds)) => foundation::js::number_to_string(seconds),
    };
    let Value::Object(details) = json!({
        "bootedAt": booted_at,
        "previousBootedAt": previous.booted_at,
        "previousUptimeSeconds": uptime_json,
        "restartsInWindow": restarts_at.len(),
        "revision": revision,
    }) else {
        unreachable!("built as an object")
    };
    record_event(
        sqlite,
        clock,
        &DomainEventInput {
            publication_ref: None,
            event_type: if looping {
                "runtime.restart.looping"
            } else {
                "runtime.restarted"
            }
            .into(),
            severity: if looping { Severity::Error } else { Severity::Info },
            target: Some("runtime".into()),
            message: if looping {
                format!(
                    "Backend restarted {} times in the last {} minutes",
                    restarts_at.len(),
                    RESTART_WINDOW_SECONDS / 60
                )
            } else {
                format!("Backend restarted (previous process ran {uptime_text}s)")
            },
            details: Some(details),
            // A plain restart is delivered nowhere; cooling it would hide history.
            cooldown_seconds: looping.then_some(ALERT_COOLDOWN_SECONDS as u64),
        },
    )?;
    Ok(true)
}

/// `recordMemoryPressure`: warns while the process is still alive, since an
/// OOM kill leaves nothing behind to report. No limit, no warning.
pub fn record_memory_pressure(
    sqlite: &Connection,
    clock: &dyn Clock,
    rss_bytes: u64,
    limit_bytes: Option<u64>,
) -> Result<bool> {
    let Some(limit) = limit_bytes.filter(|limit| *limit > 0) else {
        return Ok(false);
    };
    let used_percent = js_round(rss_bytes as f64 / limit as f64 * 100.0);
    if used_percent < MEMORY_ALERT_PERCENT {
        return Ok(false);
    }
    let to_mb = |bytes: u64| js_round(bytes as f64 / 1024.0 / 1024.0) as i64;
    let mut details = Map::new();
    details.insert("rssMb".into(), to_mb(rss_bytes).into());
    details.insert("limitMb".into(), to_mb(limit).into());
    details.insert("usedPercent".into(), (used_percent as i64).into());
    record_event(
        sqlite,
        clock,
        &DomainEventInput {
            publication_ref: None,
            event_type: "runtime.memory.pressure".into(),
            severity: Severity::Warn,
            target: Some("runtime".into()),
            message: format!(
                "Backend rss {}MB is {}% of the {}MB container limit",
                to_mb(rss_bytes),
                used_percent as i64,
                to_mb(limit)
            ),
            details: Some(details),
            cooldown_seconds: Some(ALERT_COOLDOWN_SECONDS as u64),
        },
    )
}
