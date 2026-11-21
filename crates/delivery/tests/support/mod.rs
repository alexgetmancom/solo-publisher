//! What every delivery scenario test shares with its TypeScript runner
//! (`scripts/rust/delivery-scenario-support.ts`): a fresh database per
//! scenario under a fixed clock and jitter, a recording transport answering
//! the scenario's canned responses (and running the `sql` a response carries
//! when it is served), and the same dump, scrubbing and comparison rules.

#![allow(dead_code)]

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::Arc;

use adapters::AdapterContext;
use db::rusqlite::Connection;
use db::{BackendDb, unsafe_db};
use domain::application::ports::Clock;
use domain::delivery::VideoCompletionNotice;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::publishing::boundaries::{
    Boundaries, Jitter, StoryCardMedia, StoryCardState, StoryCards, UsageMeter, WorkerBell,
};
use domain::story_cards::StoryCardStore;
use foundation::config::{Config, load_config};
use futures_util::future::LocalBoxFuture;
use jiff::Timestamp;
use runtime::http::{BodyPart, Fut, HttpClient, HttpRequest, HttpResponse, Transport, TransportFailure};
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

const MAX_TEXT_BODY: usize = 16 * 1024;

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

/// The scenario's clock, shared by every boundary that stamps with it.
#[derive(Clone)]
pub struct SharedClock(pub Rc<Cell<Timestamp>>);

impl Clock for SharedClock {
    fn now(&self) -> Timestamp {
        self.0.get()
    }
}

pub fn instant(value: &str) -> Timestamp {
    foundation::time::parse_iso_instant(value).unwrap()
}

struct FixedJitter(f64);

impl Jitter for FixedJitter {
    fn unit(&self) -> f64 {
        self.0
    }
}

/// Rings go nowhere and usage is not compared (its table is ignored).
struct Quiet;

impl WorkerBell for Quiet {
    fn ring_publish(&self) {}
    fn ring_publish_after(&self, _: u64) {}
}

impl UsageMeter for Quiet {
    fn record(&self, _: &Connection, _: &str, _: bool, _: u64) {}
}

/// The ported stores behind the boundaries, on the scenario's clock.
pub struct Host {
    jitter: FixedJitter,
    auth_circuit: AuthCircuitBreaker<SharedClock>,
    story_cards: StoryCardStore<SharedClock>,
    video_completion: VideoCompletionNotice<SharedClock>,
}

impl Host {
    pub fn boundaries(&self) -> Boundaries<'_> {
        Boundaries {
            jitter: &self.jitter,
            bell: &Quiet,
            auth_circuit: &self.auth_circuit,
            usage: &Quiet,
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
pub struct Scrubber {
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

    pub fn text(&self, value: &str) -> String {
        let mut text = value.replace(&self.data, "$DATA");
        for (name, secret) in &self.secrets {
            text = text.replace(secret.as_str(), &format!("{{{{{name}}}}}"));
        }
        text
    }

    pub fn deep(&self, value: &Value) -> Value {
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

/// A request as the TypeScript recorder saw it through `new Request`.
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
                        .map(|pair| (pair[0].as_str().unwrap().to_owned(), pair[1].as_str().unwrap().to_owned()))
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

/// The TypeScript runner's dump, statement for statement.
pub fn dump(sqlite: &Connection, ignored: &[String]) -> Map<String, Value> {
    let strings = |sql: &str, param: Option<&str>| -> Vec<String> {
        let mut statement = sqlite.prepare(sql).unwrap();
        let rows = statement
            .query_map(db::rusqlite::params_from_iter(param), |row| row.get(0))
            .unwrap();
        rows.map(Result::unwrap).collect()
    };
    let mut out = Map::new();
    for table in strings("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", None) {
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
pub struct Scenario {
    pub db: Rc<BackendDb>,
    pub host: Host,
    pub clock: SharedClock,
    pub client: HttpClient,
    pub data: PathBuf,
    env: Vec<(String, String)>,
    credentials: Map<String, Value>,
}

impl Scenario {
    pub fn sqlite(&self) -> &Connection {
        unsafe_db(&self.db)
    }

    /// The configuration as TypeScript builds it per call: the environment,
    /// then the credentials stored in `platform_tokens`.
    pub fn config(&self) -> Arc<Config> {
        let mut config = load_config(self.env.iter().cloned()).unwrap();
        let credential = |name: &str| self.credentials.get(name).and_then(Value::as_str).map(str::to_owned);
        config.x_access_token = credential("X_ACCESS_TOKEN");
        config.x_refresh_token = credential("X_REFRESH_TOKEN");
        config.zernio_api_key = credential("ZERNIO_API_KEY");
        config.discord_bot_token = credential("DISCORD_BOT_TOKEN");
        Arc::new(config)
    }

    pub fn adapters(&self) -> AdapterContext {
        AdapterContext {
            config: self.config(),
            client: self.client.clone(),
            clock: Rc::new(self.clock.clone()),
        }
    }

    pub fn delivery(&self) -> delivery::Delivery<'_> {
        delivery::Delivery::new(&self.db, self.host.boundaries(), self.adapters())
    }

    pub fn now(&self) -> Timestamp {
        self.clock.now()
    }
}

/// An area's calls: the step's name and arguments, its JSON result or the
/// message of its failure.
pub type Call = for<'a> fn(&'a Scenario, &'a str, Vec<Value>) -> LocalBoxFuture<'a, Result<Value, String>>;

/// `{"$": "<name>.<field>"}` arguments replaced by fields of bound results.
fn resolve(value: &Value, vars: &Map<String, Value>) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| resolve(item, vars)).collect()),
        Value::Object(object) => match object.get("$") {
            Some(Value::String(reference)) if object.len() == 1 => {
                let (name, field) = reference.split_once('.').expect("reference is <name>.<field>");
                vars.get(name).unwrap_or_else(|| panic!("unbound {name}"))[field].clone()
            }
            _ => Value::Object(object.iter().map(|(key, item)| (key.clone(), resolve(item, vars))).collect()),
        },
        other => other.clone(),
    }
}

fn write_files(data: &Path, files: Option<&Value>) {
    for (name, spec) in files.and_then(Value::as_object).into_iter().flatten() {
        let target = data.join(name);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        if let Some(fill) = spec.get("fill") {
            let size = spec["size"].as_u64().unwrap() as usize;
            std::fs::write(&target, fill.as_str().unwrap().repeat(size)).unwrap();
        } else {
            let args: Vec<&str> = spec["ffmpeg"].as_array().unwrap().iter().map(|arg| arg.as_str().unwrap()).collect();
            let made = Command::new("ffmpeg")
                .args(["-loglevel", "error"])
                .args(&args)
                .arg(&target)
                .output()
                .expect("ffmpeg on PATH");
            assert!(made.status.success(), "ffmpeg could not make {name}");
        }
    }
}

/// `JSON.parse(JSON.stringify(value))`: integral floats read back as integers.
fn as_javascript(value: Value) -> Value {
    serde_json::from_str(&domain::json::stringify(&value)).unwrap()
}

async fn run(spec: &Value, scenario: &Value, call: Call, label: &str) -> Value {
    let name = scenario["name"].as_str().unwrap();
    let data = repo_root().join("_trash-rust/tmp/delivery-scenarios").join(label).join(name);
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let data = data.canonicalize().unwrap();
    write_files(&data, scenario.get("files"));
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
            context.sqlite().execute_batch(sql.as_str().unwrap()).unwrap();
        } else {
            let name = step["call"].as_str().unwrap();
            let args = match resolve(step.get("args").unwrap_or(&json!([])), &vars) {
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
pub fn rust_side(spec: &Value, call: Call, label: &str) -> Vec<Value> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let local = tokio::task::LocalSet::new();
    local.block_on(&runtime, async {
        let mut out = Vec::new();
        for scenario in spec["scenarios"].as_array().unwrap() {
            out.push(run(spec, scenario, call, label).await);
        }
        out
    })
}

/// Runs a TypeScript scenario runner over a spec file; its JSON is the last
/// line it prints (the TypeScript logger writes to stdout too).
pub fn typescript_side(script: &str, spec: &Path) -> Vec<Value> {
    let output = Command::new("bun")
        .arg(script)
        .arg(spec)
        .current_dir(repo_root())
        .env("TMPDIR", repo_root().join("_trash-rust/tmp"))
        .output()
        .expect("bun must be on PATH");
    assert!(output.status.success(), "bun failed: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let last = stdout.lines().rev().find(|line| line.starts_with("{\"scenarios\"")).expect("runner output");
    let parsed: Value = serde_json::from_str(last).unwrap();
    parsed["scenarios"].as_array().unwrap().clone()
}

/// Every step result, request and table, TypeScript against Rust.
pub fn differences(expected: &[Value], actual: &[Value]) -> Vec<String> {
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
        let (expected_tables, actual_tables) = (expected["tables"].as_object().unwrap(), actual["tables"].as_object().unwrap());
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

/// The whole comparison for one area: its spec, its TypeScript runner, its
/// Rust calls.
pub fn compare(spec_file: &str, script: &str, call: Call, label: &str) {
    let spec_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join(spec_file);
    let spec: Value = serde_json::from_str(&std::fs::read_to_string(&spec_path).unwrap()).unwrap();
    let expected = typescript_side(script, &spec_path);
    let actual = rust_side(&spec, call, &format!("rust-{label}-{}", std::process::id()));
    let failures = differences(&expected, &actual);
    assert!(
        failures.is_empty(),
        "{} of {} scenarios differ:\n{}",
        failures.len(),
        expected.len(),
        failures.join("\n\n")
    );
}
