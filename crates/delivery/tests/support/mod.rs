//! What every delivery scenario test shares, against the committed
//! `<spec>.golden.json` results: a fresh database per
//! scenario under a fixed clock and jitter, a recording transport answering
//! the scenario's canned responses (and running the `sql` a response carries
//! when it is served), and the same dump, scrubbing and comparison rules.

#![allow(dead_code)]

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, LazyLock};

use adapters::AdapterContext;
use db::rusqlite::Connection;
use db::{BackendDb, unsafe_db};
use domain::application::ports::Clock;
use domain::delivery::VideoCompletionNotice;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::observability::usage::UsageRecorder;
use domain::publishing::boundaries::{Boundaries, Jitter, StoryCardMedia, StoryCardState, StoryCards, WorkerBell};
use domain::story_cards::StoryCardStore;
use foundation::config::{Config, load_config};
use futures_util::future::LocalBoxFuture;
use jiff::Timestamp;
use regex::Regex;
use runtime::http::{BodyPart, Fut, HttpClient, HttpRequest, HttpResponse, Transport, TransportFailure};
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

const MAX_TEXT_BODY: usize = 16 * 1024;
/// Where every scenario's `DATA_DIR` lives, on every machine.
const GOLDEN_DATA_ROOT: &str = "/tmp/solo-publisher-goldens/delivery-scenarios";
static UUID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap());

pub(crate) fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

/// The scenario's clock, shared by every boundary that stamps with it.
#[derive(Clone)]
pub(crate) struct SharedClock(pub Rc<Cell<Timestamp>>);

impl Clock for SharedClock {
    fn now(&self) -> Timestamp {
        self.0.get()
    }
}

pub(crate) fn instant(value: &str) -> Timestamp {
    foundation::time::parse_iso_instant(value).unwrap()
}

struct FixedJitter(f64);

impl Jitter for FixedJitter {
    fn unit(&self) -> f64 {
        self.0
    }
}

/// Rings go nowhere.
struct Quiet;

impl WorkerBell for Quiet {
    fn ring_publish(&self) {}
    fn ring_publish_after(&self, _: u64) {}
}

/// The stores behind the boundaries, on the scenario's clock.
pub(crate) struct Host {
    jitter: FixedJitter,
    auth_circuit: AuthCircuitBreaker<SharedClock>,
    usage: UsageRecorder<SharedClock>,
    story_cards: StoryCardStore<SharedClock>,
    video_completion: VideoCompletionNotice<SharedClock>,
}

impl Host {
    pub(crate) fn boundaries(&self) -> Boundaries<'_> {
        Boundaries {
            jitter: &self.jitter,
            bell: &Quiet,
            auth_circuit: &self.auth_circuit,
            usage: &self.usage,
            story_cards: self,
            video_completion: &self.video_completion,
        }
    }
}

impl StoryCards for Host {
    fn queue(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<()> {
        self.story_cards.queue(sqlite, draft_id)
    }
    fn for_draft(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<Vec<StoryCardState>> {
        self.story_cards.for_draft(sqlite, draft_id)
    }
    fn ready_media(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<Option<StoryCardMedia>> {
        self.story_cards.ready_media(sqlite, draft_id)
    }
    fn set_publish_mode(
        &self,
        sqlite: &Connection,
        draft_id: i64,
        mode: domain::application::ports::StoryPublishMode,
    ) -> domain::Result<()> {
        self.story_cards.set_publish_mode(sqlite, draft_id, mode)
    }
    fn discard(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<()> {
        self.story_cards.discard(sqlite, draft_id)
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Credentials back to `{{NAME}}` and the data directory to `$DATA`.
pub(crate) struct Scrubber {
    data: String,
    secrets: Vec<(String, String)>,
}

impl Scrubber {
    fn new(spec: &Value, data: &Path) -> Self {
        let mut secrets: Vec<(String, String)> = ["env", "credentials"]
            .iter()
            .flat_map(|section| spec[section].as_object().unwrap().iter())
            .filter(|(name, value)| {
                ["TOKEN", "SECRET", "KEY"].iter().any(|marker| name.contains(marker))
                    && value.as_str().unwrap().encode_utf16().count() >= 6
            })
            .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_owned()))
            .collect();
        secrets.sort_by_key(|(_, secret)| std::cmp::Reverse(secret.encode_utf16().count()));
        Self {
            data: data.to_string_lossy().into_owned(),
            secrets,
        }
    }

    pub(crate) fn text(&self, value: &str) -> String {
        let mut text = value.replace(&self.data, "$DATA");
        for (name, secret) in &self.secrets {
            text = text.replace(secret.as_str(), &format!("{{{{{name}}}}}"));
        }
        // Lease owners name this host, this process and a random UUID.
        let host = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default();
        let pid = std::process::id();
        text = text
            .replace(&format!(":{}:{pid}", host.trim()), ":$HOST")
            .replace(&format!("{pid}:"), "$PID:");
        UUID.replace_all(&text, "$$UUID").into_owned()
    }

    pub(crate) fn deep(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(text)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.deep(item)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), self.deep(item))).collect()),
            other => other.clone(),
        }
    }
}

fn bytes_shape(bytes: &[u8], scrub: &Scrubber) -> Map<String, Value> {
    let mut shape = Map::new();
    if bytes.len() <= MAX_TEXT_BODY
        && let Ok(text) = std::str::from_utf8(bytes)
    {
        shape.insert("text".into(), scrub.text(text).into());
        return shape;
    }
    shape.insert("size".into(), bytes.len().into());
    shape.insert("sha256".into(), sha256(bytes).into());
    shape
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|index| index + from)
}

fn multipart_parts(body: &[u8], boundary: &str, scrub: &Scrubber) -> Vec<Value> {
    let delimiter = format!("--{boundary}").into_bytes();
    let mut parts = Vec::new();
    let Some(first) = find(body, &delimiter, 0) else {
        return parts;
    };
    let mut start = first + delimiter.len();
    while body.get(start..start + 2) == Some(b"\r\n") {
        let end = find(body, &delimiter, start).unwrap();
        let part = &body[start + 2..end - 2];
        let split = find(part, b"\r\n\r\n", 0).unwrap();
        let headers: Vec<Value> = std::str::from_utf8(&part[..split])
            .unwrap()
            .split("\r\n")
            .map(|line| scrub.text(line).into())
            .collect();
        let mut shape = Map::new();
        shape.insert("headers".into(), Value::Array(headers));
        shape.extend(bytes_shape(&part[split + 4..], scrub));
        parts.push(Value::Object(shape));
        start = end + delimiter.len();
    }
    parts
}

fn body_bytes(request: &HttpRequest) -> Vec<u8> {
    let mut bytes = Vec::new();
    for part in &request.body.0 {
        match part {
            BodyPart::Bytes(chunk) => bytes.extend_from_slice(chunk),
            BodyPart::File { path, offset } => {
                let file = std::fs::read(path).unwrap();
                bytes.extend_from_slice(&file[(*offset as usize).min(file.len())..]);
            }
        }
    }
    bytes
}

/// A request as the goldens record it.
fn recorded(request: &HttpRequest, scrub: &Scrubber) -> Value {
    let boundary = request
        .header_value("content-type")
        .and_then(|value| value.strip_prefix("multipart/form-data; boundary="))
        .map(str::to_owned);
    let mut headers: Vec<(String, String)> = request
        .headers
        .iter()
        .map(|(name, value)| {
            let name = name.to_ascii_lowercase();
            let value = if boundary.is_some() && name == "content-type" {
                "multipart/form-data".to_owned()
            } else {
                scrub.text(value)
            };
            (name, value)
        })
        .collect();
    headers.sort_by(|left, right| left.0.cmp(&right.0));
    let bytes = body_bytes(request);
    let body = match &boundary {
        Some(boundary) => json!({"parts": multipart_parts(&bytes, boundary, scrub)}),
        None => Value::Object(bytes_shape(&bytes, scrub)),
    };
    json!({
        "method": request.method.as_str(),
        "url": scrub.text(&url::Url::parse(&request.url).map_or_else(|_| request.url.clone(), String::from)),
        "headers": headers.into_iter().map(|(name, value)| json!([name, value])).collect::<Vec<_>>(),
        "body": body,
    })
}

/// Records each request as sent and answers the next canned response, after
/// running the `sql` it carries.
struct Recorder {
    db: Rc<BackendDb>,
    scrub: Rc<Scrubber>,
    sent: RefCell<Vec<Value>>,
    responses: RefCell<VecDeque<Value>>,
}

impl Transport for Recorder {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        self.sent.borrow_mut().push(recorded(&request, &self.scrub));
        let next = self.responses.borrow_mut().pop_front();
        Box::pin(async move {
            let Some(next) = next else {
                return Err(TransportFailure {
                    message: "no canned response left".into(),
                    timed_out: false,
                });
            };
            if let Some(sql) = next.get("sql").and_then(Value::as_str) {
                unsafe_db(&self.db).execute_batch(sql).unwrap();
            }
            // Rust-only: an answer that never comes, for the timeout paths.
            if next.get("hang").is_some() {
                return std::future::pending().await;
            }
            if let Some(message) = next.get("throws") {
                return Err(TransportFailure {
                    message: message.as_str().unwrap().into(),
                    timed_out: false,
                });
            }
            let headers = next
                .get("headers")
                .and_then(Value::as_array)
                .map(|pairs| {
                    pairs
                        .iter()
                        .map(|pair| {
                            (
                                pair[0].as_str().unwrap().to_owned(),
                                pair[1].as_str().unwrap().to_owned(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let body = next.get("body").and_then(Value::as_str).unwrap_or_default();
            Ok(HttpResponse::buffered(
                u16::try_from(next["status"].as_u64().unwrap()).unwrap(),
                headers,
                body,
            ))
        })
    }
}

/// The dump the goldens were recorded with, statement for statement.
pub(crate) fn dump(sqlite: &Connection, ignored: &[String]) -> Map<String, Value> {
    let strings = |sql: &str, param: Option<&str>| -> Vec<String> {
        let mut statement = sqlite.prepare(sql).unwrap();
        let rows = statement
            .query_map(db::rusqlite::params_from_iter(param), |row| row.get(0))
            .unwrap();
        rows.map(Result::unwrap).collect()
    };
    let mut out = Map::new();
    for table in strings(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        None,
    ) {
        if ignored.contains(&table) {
            continue;
        }
        let columns = strings("SELECT name FROM pragma_table_info(?) ORDER BY cid", Some(&table));
        let cells = columns
            .iter()
            .map(|column| format!(r#"typeof("{column}") || ':' || quote("{column}")"#))
            .collect::<Vec<_>>()
            .join(" || ' ' || ");
        let rows = strings(
            &format!(r#"SELECT quote(rowid) || ' ' || {cells} AS line FROM "{table}" ORDER BY rowid"#),
            None,
        );
        if !rows.is_empty() {
            out.insert(table, rows.into_iter().map(Value::String).collect());
        }
    }
    out
}

/// What one call of a scenario runs with.
pub(crate) struct Scenario {
    pub db: Rc<BackendDb>,
    pub host: Host,
    pub clock: SharedClock,
    pub client: HttpClient,
    pub data: PathBuf,
    env: Vec<(String, String)>,
    credentials: Map<String, Value>,
}

impl Scenario {
    pub(crate) fn sqlite(&self) -> &Connection {
        unsafe_db(&self.db)
    }

    /// The configuration as the recorded scenarios build it per call: the environment,
    /// then the credentials stored in `platform_tokens`.
    pub(crate) fn config(&self) -> Arc<Config> {
        let mut config = load_config(self.env.iter().cloned()).unwrap();
        let credential = |name: &str| self.credentials.get(name).and_then(Value::as_str).map(str::to_owned);
        config.x_access_token = credential("X_ACCESS_TOKEN");
        config.x_refresh_token = credential("X_REFRESH_TOKEN");
        config.zernio_api_key = credential("ZERNIO_API_KEY");
        config.discord_bot_token = credential("DISCORD_BOT_TOKEN");
        Arc::new(config)
    }

    pub(crate) fn adapters(&self) -> AdapterContext {
        AdapterContext {
            config: self.config(),
            client: self.client.clone(),
            clock: Rc::new(self.clock.clone()),
        }
    }

    pub(crate) fn delivery(&self) -> delivery::Delivery<'_> {
        delivery::Delivery::new(&self.db, self.host.boundaries(), self.adapters())
    }

    pub(crate) fn now(&self) -> Timestamp {
        self.clock.now()
    }
}

/// An area's calls: the step's name and arguments, its JSON result or the
/// message of its failure.
pub(crate) type Call = for<'a> fn(&'a Scenario, &'a str, Vec<Value>) -> LocalBoxFuture<'a, Result<Value, String>>;

/// `{"$": "<name>.<field>"}` arguments replaced by fields of bound results.
fn resolve(value: &Value, vars: &Map<String, Value>) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| resolve(item, vars)).collect()),
        Value::Object(object) => match object.get("$") {
            Some(Value::String(reference)) if object.len() == 1 => {
                let (name, field) = reference.split_once('.').expect("reference is <name>.<field>");
                vars.get(name).unwrap_or_else(|| panic!("unbound {name}"))[field].clone()
            }
            _ => Value::Object(
                object
                    .iter()
                    .map(|(key, item)| (key.clone(), resolve(item, vars)))
                    .collect(),
            ),
        },
        other => other.clone(),
    }
}

/// `$DATA` in a step's arguments is the scenario's data directory.
fn with_data(value: &Value, data: &Path) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace("$DATA", &data.to_string_lossy())),
        Value::Array(items) => Value::Array(items.iter().map(|item| with_data(item, data)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), with_data(item, data)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn write_files(data: &Path, at: std::time::SystemTime, files: Option<&Value>) {
    for (name, spec) in files.and_then(Value::as_object).into_iter().flatten() {
        let target = data.join(name);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        if let Some(fill) = spec.get("fill") {
            let size = spec["size"].as_u64().unwrap() as usize;
            std::fs::write(&target, fill.as_str().unwrap().repeat(size)).unwrap();
        } else {
            // The media inputs are committed bytes (tests/fixtures/README.md):
            // made at test time, ffmpeg's encoders follow its build and the
            // machine's core count, and the goldens hash what is derived from them.
            let fixture = spec["fixture"]
                .as_str()
                .unwrap_or_else(|| panic!("{name}: fill or fixture"));
            std::fs::copy(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures")
                    .join(fixture),
                &target,
            )
            .unwrap_or_else(|error| panic!("{name}: fixture {fixture}: {error}"));
        }
        // Freshness is read from mtimes: every input is as old as the spec's clock.
        let file = std::fs::File::options().write(true).open(&target).unwrap();
        file.set_times(std::fs::FileTimes::new().set_accessed(at).set_modified(at))
            .unwrap();
    }
}

/// Every file under the data directory, relative and sorted: what a call
/// left on disk.
pub(crate) fn files(data: &Path) -> Value {
    fn walk(root: &Path, directory: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                out.push(path.strip_prefix(root).unwrap().to_string_lossy().into_owned());
            }
        }
    }
    let mut out = Vec::new();
    walk(data, data, &mut out);
    out.sort();
    json!(out)
}

/// `JSON.parse(JSON.stringify(value))`: integral floats read back as integers.
fn as_javascript(value: Value) -> Value {
    serde_json::from_str(&domain::json::stringify(&value)).unwrap()
}

async fn run(spec: &Value, scenario: &Value, call: Call, label: &str) -> Value {
    let name = scenario["name"].as_str().unwrap();
    // A fixed absolute root: media cache keys hash the file's path, and the
    // goldens were recorded under this one.
    let data = Path::new(GOLDEN_DATA_ROOT).join(label).join(name);
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let data = data.canonicalize().unwrap();
    let at = std::time::UNIX_EPOCH
        + std::time::Duration::from_millis(instant(spec["clock"].as_str().unwrap()).as_millisecond() as u64);
    write_files(&data, at, scenario.get("files"));
    let mut env: Vec<(String, String)> = spec["env"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned()))
        .collect();
    env.push(("DATA_DIR".into(), data.to_string_lossy().into_owned()));
    for (key, value) in scenario.get("env").and_then(Value::as_object).into_iter().flatten() {
        env.retain(|(name, _)| name != key);
        if let Some(value) = value.as_str() {
            env.push((key.clone(), value.to_owned()));
        }
    }
    let scrub = Rc::new(Scrubber::new(spec, &data));
    let db = Rc::new(BackendDb::open(":memory:").unwrap());
    let recorder = Rc::new(Recorder {
        db: Rc::clone(&db),
        scrub: Rc::clone(&scrub),
        sent: RefCell::new(Vec::new()),
        responses: RefCell::new(
            scenario
                .get("responses")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into(),
        ),
    });
    let clock = SharedClock(Rc::new(Cell::new(instant(spec["clock"].as_str().unwrap()))));
    let jitter = spec["jitter"].as_f64().unwrap();
    let context = Scenario {
        db: Rc::clone(&db),
        host: Host {
            jitter: FixedJitter(jitter),
            auth_circuit: AuthCircuitBreaker::new(clock.clone()),
            usage: UsageRecorder::new(clock.clone()),
            story_cards: StoryCardStore::new(clock.clone()),
            video_completion: VideoCompletionNotice::new(clock.clone()),
        },
        clock: clock.clone(),
        client: HttpClient::new(Rc::clone(&recorder) as Rc<dyn Transport>),
        data: data.clone(),
        env,
        credentials: spec["credentials"].as_object().unwrap().clone(),
    };
    for statement in spec["setup"].as_array().unwrap() {
        context.sqlite().execute_batch(statement.as_str().unwrap()).unwrap();
    }
    let mut vars = Map::new();
    let mut results = Vec::new();
    for step in scenario["steps"].as_array().unwrap() {
        if let Some(at) = step.get("clock") {
            clock.0.set(instant(at.as_str().unwrap()));
        } else if let Some(sql) = step.get("sql") {
            let sql = sql.as_str().unwrap().replace("$DATA", &data.to_string_lossy());
            context.sqlite().execute_batch(&sql).unwrap();
        } else {
            let name = step["call"].as_str().unwrap();
            let args = match with_data(&resolve(step.get("args").unwrap_or(&json!([])), &vars), &data) {
                Value::Array(args) => args,
                _ => unreachable!("args is an array"),
            };
            let result = match call(&context, name, args).await {
                Ok(value) => {
                    let value = as_javascript(value);
                    if let Some(bind) = step.get("bind").and_then(Value::as_str) {
                        vars.insert(bind.into(), value.clone());
                    }
                    value
                }
                Err(message) => json!({"error": message}),
            };
            results.push(json!({"call": name, "result": scrub.deep(&result)}));
        }
    }
    for statement in spec["beforeDump"].as_array().unwrap() {
        context.sqlite().execute_batch(statement.as_str().unwrap()).unwrap();
    }
    let ignored: Vec<String> = spec["ignoredTables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|table| table.as_str().unwrap().to_owned())
        .collect();
    let tables: Map<String, Value> = dump(context.sqlite(), &ignored)
        .into_iter()
        .map(|(table, rows)| (table, scrub.deep(&rows)))
        .collect();
    let requests = recorder.sent.borrow().clone();
    let unused = recorder.responses.borrow().len();
    json!({"name": name, "results": results, "requests": requests, "unusedResponses": unused, "tables": tables})
}

/// Every scenario of the spec through `call`, on a single-threaded runtime
/// with a `LocalSet`, as the Studio runs.
pub(crate) fn rust_side(spec: &Value, call: Call, label: &str) -> Vec<Value> {
    run_on(
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap(),
        spec,
        call,
        label,
    )
}

/// [`rust_side`] with tokio's clock paused: a timer fires as soon as nothing
/// else can run, so a ten-minute timeout costs nothing.
pub(crate) fn rust_side_paused(spec: &Value, call: Call, label: &str) -> Vec<Value> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap();
    run_on(runtime, spec, call, label)
}

fn run_on(runtime: tokio::runtime::Runtime, spec: &Value, call: Call, label: &str) -> Vec<Value> {
    let local = tokio::task::LocalSet::new();
    local.block_on(&runtime, async {
        let mut out = Vec::new();
        for scenario in spec["scenarios"].as_array().unwrap() {
            out.push(run(spec, scenario, call, label).await);
        }
        out
    })
}

/// What was recorded for a spec file: `<spec>.golden.json` beside it.
pub(crate) fn golden_side(spec: &Path) -> Vec<Value> {
    let path = spec.with_extension("golden.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let parsed: Value = serde_json::from_str(&text).unwrap();
    parsed["scenarios"].as_array().unwrap().clone()
}

/// Every step result, request and table, golden against Rust.
pub(crate) fn differences(expected: &[Value], actual: &[Value]) -> Vec<String> {
    assert_eq!(expected.len(), actual.len(), "scenario count");
    let mut failures = Vec::new();
    for (expected, actual) in expected.iter().zip(actual) {
        let name = expected["name"].as_str().unwrap();
        for key in ["results", "requests"] {
            let (left, right) = (expected[key].as_array().unwrap(), actual[key].as_array().unwrap());
            if left.len() != right.len() {
                failures.push(format!(
                    "{name}: {key} count ts {} rust {}\n  ts:   {}\n  rust: {}",
                    left.len(),
                    right.len(),
                    serde_json::to_string_pretty(left).unwrap(),
                    serde_json::to_string_pretty(right).unwrap()
                ));
                continue;
            }
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                if left != right {
                    failures.push(format!("{name}, {key} #{index}:\n  ts:   {left}\n  rust: {right}"));
                }
            }
        }
        if expected["unusedResponses"] != actual["unusedResponses"] {
            failures.push(format!(
                "{name}: unused responses ts {} rust {}",
                expected["unusedResponses"], actual["unusedResponses"]
            ));
        }
        let (expected_tables, actual_tables) = (
            expected["tables"].as_object().unwrap(),
            actual["tables"].as_object().unwrap(),
        );
        for table in expected_tables
            .keys()
            .chain(actual_tables.keys().filter(|key| !expected_tables.contains_key(*key)))
        {
            let (left, right) = (expected_tables.get(table), actual_tables.get(table));
            if left != right {
                failures.push(format!(
                    "{name}, table {table}:\n  ts:   {}\n  rust: {}",
                    serde_json::to_string_pretty(&left).unwrap(),
                    serde_json::to_string_pretty(&right).unwrap()
                ));
            }
        }
    }
    failures
}

/// What ffmpeg's encoders wrote — the site's WebP variants and video posters —
/// is compared by path and links, not by bytes: those follow the ffmpeg build
/// (its libwebp, its scaler), while what this crate decides about them does
/// not. A name taken from one's sha256 — a content version (`?v=` and its first
/// 12 hex), a shared blob (`.blobs/<sha256>`) — reads as the file it names, and
/// a listing is compared in the order of those names.
fn without_encoder_bytes(scenario: &mut Value) {
    fn encoded(path: &str) -> bool {
        path.ends_with(".webp") || path.contains("-poster.")
    }
    fn file_listings(value: &mut Value, visit: &mut dyn FnMut(&mut Vec<Value>)) {
        match value {
            Value::Object(object) => {
                if object.get("call").and_then(Value::as_str) == Some("files")
                    && let Some(Value::Array(files)) = object.get_mut("result")
                {
                    visit(files);
                }
                object.values_mut().for_each(|item| file_listings(item, visit));
            }
            Value::Array(items) => items.iter_mut().for_each(|item| file_listings(item, visit)),
            _ => {}
        }
    }
    fn rename(value: &mut Value, names: &[(String, String)]) {
        match value {
            Value::Object(object) => object.values_mut().for_each(|item| rename(item, names)),
            Value::Array(items) => items.iter_mut().for_each(|item| rename(item, names)),
            Value::String(text) => {
                for (hash, name) in names {
                    if text.contains(hash.as_str()) {
                        *text = text.replace(hash.as_str(), name);
                    }
                }
            }
            _ => {}
        }
    }
    // Full hashes first, so a prefix never splits one.
    let mut full = Vec::new();
    file_listings(scenario, &mut |files| {
        for file in files.iter() {
            if let (Some(path), Some(sha)) = (file["path"].as_str(), file["sha256"].as_str())
                && encoded(path)
                && !full.iter().any(|(known, _): &(String, String)| known == sha)
            {
                full.push((sha.to_owned(), format!("<encoded {path}>")));
            }
        }
    });
    let hashes: Vec<String> = full.iter().map(|(sha, _)| sha.clone()).collect();
    file_listings(scenario, &mut |files| {
        for file in files.iter_mut() {
            if file["sha256"]
                .as_str()
                .is_some_and(|sha| hashes.iter().any(|known| known == sha))
            {
                file["size"] = json!("<encoded>");
                file["sha256"] = json!("<encoded>");
            }
        }
    });
    let prefixes: Vec<(String, String)> = full
        .iter()
        .map(|(sha, name)| (sha[..12].to_owned(), name.clone()))
        .collect();
    let names: Vec<(String, String)> = full.into_iter().chain(prefixes).collect();
    rename(scenario, &names);
    file_listings(scenario, &mut |files| {
        files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    });
}

/// The whole comparison for one area: its spec, its golden, its Rust calls.
pub(crate) fn compare(spec_file: &str, call: Call, label: &str) {
    let spec_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join(spec_file);
    let spec: Value = serde_json::from_str(&std::fs::read_to_string(&spec_path).unwrap()).unwrap();
    let mut expected = golden_side(&spec_path);
    let mut actual = rust_side(&spec, call, label);
    expected
        .iter_mut()
        .chain(actual.iter_mut())
        .for_each(without_encoder_bytes);
    let failures = differences(&expected, &actual);
    assert!(
        failures.is_empty(),
        "{} differences across {} scenarios:\n{}",
        failures.len(),
        expected.len(),
        failures.join("\n\n")
    );
}
