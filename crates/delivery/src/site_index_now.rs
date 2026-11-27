//! Public content changes queued in a state file
//! under `DATA_DIR`, and sent to IndexNow one batch at a time per state file
//! without the site cycle ever waiting on the search provider.
//!
//! The send runs as a task on the Studio's `LocalSet`, which cannot borrow the
//! cycle's database handle; a failed send is therefore kept here, with the
//! instant it failed at, until the next site cycle (or [`index_now_settled`]'s
//! caller) journals it as `site.indexnow.failed`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use foundation::config::Config;
use foundation::logger::{LogLevel, log};
use futures_util::FutureExt as _;
use futures_util::future::{LocalBoxFuture, Shared};
use providers::adapters::AdapterContext;
use runtime::http::HttpRequest;
use serde_json::{Map, Value, json};

const RETRY_DELAY_MS: i64 = 60_000;
const BATCH_LIMIT: usize = 10_000;
const REQUEST_DEADLINE: Duration = Duration::from_secs(8);
const STATE_FILE: &str = "indexnow.json";
const KEY_FILE: &str = "indexnow.key";
const FILE_MODE: u32 = 0o664;

type Attempt = Shared<LocalBoxFuture<'static, Result<(), String>>>;

/// A send that failed after the cycle that started it had returned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexNowFailure {
    pub message: String,
    /// The URLs the cycle asked to notify (empty for an idle drain).
    pub urls: Vec<String>,
    /// When it failed, on the cycle's clock.
    pub at: String,
}

#[derive(Default)]
struct Pings {
    /// The latest attempt per state file and its sequence number: a later
    /// send waits for the one before it.
    in_flight: HashMap<PathBuf, (u64, Attempt)>,
    next: u64,
    failures: Vec<IndexNowFailure>,
}

thread_local! {
    static PINGS: RefCell<Pings> = RefCell::default();
}

fn state_file(config: &Config) -> PathBuf {
    Path::new(&config.data_dir).join(STATE_FILE)
}

/// `enqueueIndexNow`: queues a public content change without waiting for the
/// search provider. A URL queued again gets a new revision, so a send already
/// in flight for it cannot clear the newer change.
pub fn enqueue_index_now(config: &Config, urls: &[String]) -> Result<(), String> {
    if !config.indexnow_enabled || urls.is_empty() {
        return Ok(());
    }
    let file = state_file(config);
    let mut state = read_state(&file)?;
    let mut pending = match state.get("pending_urls") {
        Some(Value::Object(pending)) => pending.clone(),
        _ => Map::new(),
    };
    for url in urls {
        pending.insert(url.clone(), domain::repositories::random_uuid().into());
    }
    state.insert("pending_urls".into(), Value::Object(pending));
    write_state(&file, &state)
}

/// `pingIndexNow` as the site cycle calls it, fire-and-forget: the completed
/// changes are persisted before this returns, and the send runs on a task of
/// its own. Idle cycles call it with no URLs to drain failed or large batches.
/// An error is the queueing failing, which the caller journals itself.
pub fn notify_index_now(ctx: &AdapterContext, urls: &[String]) -> Result<(), String> {
    let config = &*ctx.config;
    if !config.indexnow_enabled {
        return Ok(());
    }
    let file = state_file(config);
    let mut unique = urls.to_vec();
    // `[...new Set(urls)].sort()`: UTF-16 code unit order.
    unique.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    unique.dedup();
    let idle = unique.is_empty();
    if !idle {
        enqueue_index_now(config, &unique)?;
    } else if !has_pending(&read_state(&file)?) || PINGS.with_borrow(|pings| pings.in_flight.contains_key(&file)) {
        return Ok(());
    }
    // Enqueuing above is synchronous. Serializing sends cannot lose a content
    // change made while an earlier request for the same URL is in flight.
    let prior = PINGS.with_borrow(|pings| pings.in_flight.get(&file).map(|(_, attempt)| attempt.clone()));
    let attempt: Attempt = {
        let (ctx, file) = (ctx.clone(), file.clone());
        async move {
            if let Some(prior) = prior {
                let _ = prior.await;
            }
            send_pending(&ctx, &file, idle).await
        }
        .boxed_local()
        .shared()
    };
    let id = PINGS.with_borrow_mut(|pings| {
        pings.next += 1;
        pings.in_flight.insert(file.clone(), (pings.next, attempt.clone()));
        pings.next
    });
    let (ctx, urls) = (ctx.clone(), urls.to_vec());
    tokio::task::spawn_local(async move {
        let outcome = attempt.await;
        let at = foundation::time::to_iso_string(ctx.clock.now());
        PINGS.with_borrow_mut(|pings| {
            if pings.in_flight.get(&file).is_some_and(|(current, _)| *current == id) {
                pings.in_flight.remove(&file);
            }
            if let Err(message) = outcome {
                pings.failures.push(IndexNowFailure { message, urls, at });
            }
        });
    });
    Ok(())
}

/// Waits until no send is in flight on this thread, for a caller that needs
/// the settled state (shutdown, the parity scenarios).
pub async fn index_now_settled() {
    loop {
        let Some(attempt) =
            PINGS.with_borrow(|pings| pings.in_flight.values().next().map(|(_, attempt)| attempt.clone()))
        else {
            return;
        };
        let _ = attempt.await;
        // The task that owns the attempt clears it once it runs.
        tokio::task::yield_now().await;
    }
}

/// The failed sends not yet journalled, oldest first.
pub fn take_index_now_failures() -> Vec<IndexNowFailure> {
    PINGS.with_borrow_mut(|pings| std::mem::take(&mut pings.failures))
}

fn has_pending(state: &Map<String, Value>) -> bool {
    matches!(state.get("pending_urls"), Some(Value::Object(pending)) if !pending.is_empty())
}

/// `sendPending`: one batch of the queued URLs; a URL leaves the queue only if
/// the revision that was sent is still the queued one.
async fn send_pending(ctx: &AdapterContext, file: &Path, idle: bool) -> Result<(), String> {
    let config = &*ctx.config;
    let mut state = read_state(file)?;
    if idle
        && let Some(Value::String(retry_at)) = state.get("retry_at")
        && foundation::time::parse_iso_instant(retry_at).is_ok_and(|at| at > ctx.clock.now())
    {
        return Ok(());
    }
    let mut batch: Vec<(String, String)> = match state.get("pending_urls") {
        Some(Value::Object(pending)) => pending
            .iter()
            .map(|(url, revision)| (url.clone(), revision.as_str().unwrap_or_default().to_owned()))
            .collect(),
        _ => Vec::new(),
    };
    // `localeCompare`; byte order agrees with it for the lowercase ASCII URLs
    // this Studio builds.
    batch.sort_by(|left, right| left.0.cmp(&right.0));
    batch.truncate(BATCH_LIMIT);
    if batch.is_empty() {
        return Ok(());
    }
    let key = read_or_create_key(&Path::new(&config.data_dir).join(KEY_FILE))?;
    state.insert(
        "last_attempt_at".into(),
        foundation::time::to_iso_string(ctx.clock.now()).into(),
    );
    state.insert("url_count".into(), batch.len().into());
    state.shift_remove("last_status");
    write_state(file, &state)?;
    let sent = async {
        let base = config
            .public_base_url
            .strip_suffix('/')
            .unwrap_or(&config.public_base_url);
        let parsed = url::Url::parse(&config.public_base_url).map_err(|_| "Invalid URL".to_owned())?;
        let host = match (parsed.host_str(), parsed.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (host, _) => host.unwrap_or_default().to_owned(),
        };
        let body = json!({
            "host": host,
            "key": key,
            "keyLocation": format!("{base}/{key}.txt"),
            "urlList": batch.iter().map(|(url, _)| url.as_str()).collect::<Vec<_>>(),
        });
        let request = HttpRequest::post("https://api.indexnow.org/indexnow")
            .header("content-type", "application/json")
            .text(domain::json::stringify(&body))
            .deadline(REQUEST_DEADLINE);
        let response = ctx.client.exchange(request).await.map_err(|failure| failure.message)?;
        let accepted = matches!(response.status, 200 | 202);
        let mut latest = read_state(file)?;
        latest.insert("last_status".into(), response.status.into());
        if accepted {
            if let Some(Value::Object(pending)) = latest.get_mut("pending_urls") {
                for (url, revision) in &batch {
                    if pending.get(url).and_then(Value::as_str) == Some(revision.as_str()) {
                        pending.shift_remove(url);
                    }
                }
            }
            latest.insert(
                "last_success_at".into(),
                foundation::time::to_iso_string(ctx.clock.now()).into(),
            );
            latest.shift_remove("retry_at");
        }
        write_state(file, &latest)?;
        if accepted {
            Ok(())
        } else {
            Err(format!("IndexNow request rejected: {}", response.status))
        }
    }
    .await;
    let Err(message) = sent else { return Ok(()) };
    let mut latest = read_state(file)?;
    let retry_at = foundation::time::iso_at(ctx.clock.now().as_millisecond() + RETRY_DELAY_MS);
    latest.insert("retry_at".into(), retry_at.into());
    write_state(file, &latest)?;
    log(
        LogLevel::Warn,
        "IndexNow request failed",
        Some(json!({"error": format!("Error: {message}")})),
    );
    Err(message)
}

/// The shape IndexNow accepts for a key, and the one this Studio writes.
fn is_valid_key(value: &str) -> bool {
    (8..=128).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

/// `indexNowKey`: the key IndexNow fetches back from `/<key>.txt` to prove the
/// pings are ours. Served by this Studio (the HTTP slice) rather than written
/// into the site, which is a separate service with no disk of ours.
pub fn index_now_key(config: &Config) -> Option<String> {
    let value = std::fs::read_to_string(Path::new(&config.data_dir).join(KEY_FILE)).ok()?;
    let value = value.trim();
    is_valid_key(value).then(|| value.to_owned())
}

fn read_or_create_key(file: &Path) -> Result<String, String> {
    if let Ok(value) = std::fs::read_to_string(file) {
        let value = value.trim();
        if is_valid_key(value) {
            return Ok(value.to_owned());
        }
    }
    // A random v4 UUID's hex: 122 random bits rather than 128,
    // the same shape for IndexNow.
    let value = domain::repositories::random_uuid().replace('-', "");
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    write_with_mode(file, &format!("{value}\n")).map_err(|error| error.to_string())?;
    Ok(value)
}

fn write_with_mode(file: &Path, contents: &str) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(FILE_MODE)
        .open(file)?
        .write_all(contents.as_bytes())
}

/// `readState`: an absent file is an empty state; anything else that is not
/// the shape this module writes is an error, never silently reset.
fn read_state(file: &Path) -> Result<Map<String, Value>, String> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error.to_string()),
    };
    let Value::Object(state) = serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())? else {
        return Err("Invalid IndexNow state".into());
    };
    match state.get("pending_urls") {
        None => {}
        Some(Value::Object(pending)) if pending.values().all(Value::is_string) => {}
        Some(_) => return Err("Invalid IndexNow pending_urls".into()),
    }
    Ok(state)
}

/// `writeState`: replaced by rename, so a reader never sees half a file.
fn write_state(file: &Path, state: &Map<String, Value>) -> Result<(), String> {
    let io = |error: std::io::Error| error.to_string();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    let temporary = PathBuf::from(format!(
        "{}.{}.tmp",
        file.to_string_lossy(),
        domain::repositories::random_uuid()
    ));
    let text = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    let written = write_with_mode(&temporary, &format!("{text}\n")).and_then(|()| std::fs::rename(&temporary, file));
    let _ = std::fs::remove_file(&temporary);
    written.map_err(io)
}
