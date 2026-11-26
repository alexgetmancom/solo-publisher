//! Replay of `parity/http/goldens.json`, recorded from the Hono app
//! before the cutover: every case runs its steps on a fresh
//! database and DATA_DIR under the same fixed clock, sends every request
//! through the router (`tower::ServiceExt::oneshot`, no sockets) exactly as
//! the recorded app saw it, against a recording transport answering the
//! step's canned responses, and compares status, headers, body and the
//! requests sent; then the stored assets, the upload scratch directory,
//! `channel_connections`, `platform_tokens` (sealed values opened) and the
//! live config's credentials. Randomness is scripted as the recorder
//! scripted it; a sealed `state=` in a header is compared opened. The
//! helpers without a route in this slice are compared call by call.
//!
//! `content-length` is compared where the route sets it; one the Rust side
//! adds on its own is the framing hyper would send for that body anyway.
//! The recorded request headers are what the app saw (`$etag` already
//! replaced), so they are sent as they are.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::convert::Infallible;
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::LazyLock;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Uri};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use channels::credentials::Setting;
use channels::entropy::Entropy;
use channels::oauth_routes::ChannelRegistrar;
use content::Locale;
use db::rusqlite::Connection;
use db::rusqlite::types::Value as SqlValue;
use db::{BackendDb, unsafe_db};
use domain::application::ports::{ChannelConnectionRecord, Clock, SystemClock};
use domain::delivery::VideoCompletionNotice;
use domain::notifications::ReminderJobs;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::observability::capabilities::CapabilityReadiness;
use domain::observability::usage::UsageRecorder;
use domain::publishing::boundaries::{SystemJitter, WorkerBell};
use domain::publishing::{Boundaries, Publishing};
use domain::story_cards::StoryCardStore;
use domain::studio::Studio;
use domain::studio::boundaries::{
    ChannelConnectLinks, ConnectPlatform, ConnectStart, MetaOauthPlatform, StoryDerivatives, StudioBoundaries,
    ZernioAccount, ZernioDirectory,
};
use domain::studio::services::channels::{ChannelInput, ChannelService};
use foundation::config::{Config, SharedConfig, load_config};
use foundation::secret_box::{SecretKey, encryption_key, open};
use http_body_util::BodyExt as _;
use http_edge::{Backend, HttpState, client_ip_hash, command_allowed, mcp_studio_actor, router, stream_upload_to_file};
use jiff::Timestamp;
use regex::Regex;
use runtime::http::{Fut, HttpClient, HttpRequest, HttpResponse, Transport, TransportFailure};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt as _;

const T0: &str = "2026-11-01T10:00:00.000Z";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

struct FixedClock(Cell<Timestamp>);

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        self.0.get()
    }
}

/// Every draw but the 12-byte IV fills its buffer with a counter, as the
/// recorder's `randomBytes` did; the IV is not drawn from here.
struct ScriptedEntropy(Cell<u8>);

impl Entropy for ScriptedEntropy {
    fn fill(&self, bytes: &mut [u8]) {
        self.0.set(self.0.get().wrapping_add(1));
        bytes.fill(self.0.get());
    }
}

/// Records each request as sent and answers the step's next canned response.
#[derive(Default)]
struct Recorder {
    sent: RefCell<Vec<HttpRequest>>,
    responses: RefCell<VecDeque<Value>>,
}

impl Recorder {
    /// What was sent since the last call, as the recorder records it.
    fn take(&self) -> Value {
        self.sent
            .take()
            .iter()
            .map(|request| {
                let mut headers: Vec<(String, String)> = request
                    .headers
                    .iter()
                    .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
                    .collect();
                headers.sort_by(|left, right| left.0.cmp(&right.0));
                json!({
                    "method": request.method.as_str(),
                    "url": url::Url::parse(&request.url).map_or_else(|_| request.url.clone(), String::from),
                    "headers": headers.into_iter().map(|(name, value)| json!([name, value])).collect::<Vec<_>>(),
                    "body": String::from_utf8(request.body.as_bytes().unwrap()).unwrap(),
                })
            })
            .collect()
    }
}

impl Transport for Recorder {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        self.sent.borrow_mut().push(request);
        let next = self.responses.borrow_mut().pop_front();
        Box::pin(async move {
            let failure = |message: &str| TransportFailure {
                message: message.into(),
                timed_out: false,
            };
            let next = next.ok_or_else(|| failure("no canned response left"))?;
            if let Some(message) = next.get("throws") {
                return Err(failure(message.as_str().unwrap()));
            }
            let headers = next["headers"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|pair| {
                    (
                        pair[0].as_str().unwrap().to_owned(),
                        pair[1].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            let body = match next.get("json") {
                Some(json) => domain::json::stringify(json),
                None => next["body"].as_str().unwrap_or_default().to_owned(),
            };
            Ok(HttpResponse::buffered(
                u16::try_from(next["status"].as_u64().unwrap()).unwrap(),
                headers,
                body,
            ))
        })
    }
}

/// The stores behind Studio's boundaries; the ones whose owner is
/// elsewhere are never reached by these routes.
struct Host {
    auth_circuit: AuthCircuitBreaker<SystemClock>,
    usage: UsageRecorder<SystemClock>,
    story_cards: StoryCardStore<SystemClock>,
    video_completion: VideoCompletionNotice<SystemClock>,
    reminders: ReminderJobs<SystemClock>,
    readiness: CapabilityReadiness,
}

impl WorkerBell for Host {
    fn ring_publish(&self) {
        unreachable!("no HTTP route rings the publish worker")
    }
    fn ring_publish_after(&self, _: u64) {
        unreachable!("no HTTP route rings the publish worker")
    }
}

impl StoryDerivatives for Host {
    fn ensure(&self, _: &str, _: bool, _: i64) {
        unreachable!("no HTTP route derives Story media")
    }
}

impl ZernioDirectory for Host {
    async fn accounts(&self, _: &Config) -> domain::Result<Vec<ZernioAccount>> {
        unreachable!("connecting a channel from a callback lists no Zernio accounts")
    }
}

impl ChannelConnectLinks for Host {
    fn meta_oauth_connect_url(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        unreachable!()
    }
    fn meta_oauth_connect_path(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        unreachable!()
    }
    fn x_oauth_connect_url(&self, _: &Config) -> domain::Result<String> {
        unreachable!()
    }
    fn x_oauth_connect_path(&self, _: &Config) -> domain::Result<String> {
        unreachable!()
    }
    fn start_connect(&self, _: &Config, _: ConnectPlatform, _: Locale, _: Timestamp) -> domain::Result<ConnectStart> {
        unreachable!()
    }
}

struct TestBackend {
    db: BackendDb,
    clock: FixedClock,
    config: SharedConfig,
    host: Host,
    recorder: Rc<Recorder>,
    http: HttpClient,
    entropy: ScriptedEntropy,
}

impl Backend for TestBackend {
    fn db(&self) -> &BackendDb {
        &self.db
    }
    fn clock(&self) -> &dyn Clock {
        &self.clock
    }
    fn config(&self) -> &SharedConfig {
        &self.config
    }
    fn studio<'a>(&'a self, config: &'a Config) -> Studio<'a> {
        let host = &self.host;
        Studio::new(
            Publishing::new(
                unsafe_db(&self.db),
                &self.clock,
                Boundaries {
                    jitter: &SystemJitter,
                    bell: host,
                    auth_circuit: &host.auth_circuit,
                    usage: &host.usage,
                    story_cards: &host.story_cards,
                    video_completion: &host.video_completion,
                },
            ),
            config,
            StudioBoundaries {
                reminders: &host.reminders,
                story_derivatives: host,
                readiness: &host.readiness,
                connect_links: host,
            },
        )
    }
    fn http(&self) -> &HttpClient {
        &self.http
    }
    fn entropy(&self) -> &dyn Entropy {
        &self.entropy
    }
}

impl ChannelRegistrar for TestBackend {
    fn connect(&self, input: &ChannelInput) -> domain::Result<ChannelConnectionRecord> {
        let config = self.config.load();
        ChannelService::new(self.studio(&config), &self.host).connect(input, None)
    }
}

fn env_pairs(env: &Value, data_dir: &str) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = env
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned()))
        .collect();
    pairs.push(("DATA_DIR".into(), data_dir.into()));
    pairs
}

/// A JavaScript header string back to the bytes it stands for (Latin-1).
fn latin1(value: &str) -> Vec<u8> {
    value
        .chars()
        .map(|c| u8::try_from(u32::from(c)).expect("a ByteString"))
        .collect()
}

fn header_map(list: &Value) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for pair in list.as_array().unwrap() {
        let name = HeaderName::from_bytes(pair[0].as_str().unwrap().as_bytes()).unwrap();
        let value = HeaderValue::from_bytes(&latin1(pair[1].as_str().unwrap())).unwrap();
        headers.append(name, value);
    }
    headers
}

/// A body that arrives as a stream, as a `ReadableStream` does, and ends
/// when `hold` is dropped (at once without one).
fn streamed(bytes: Vec<u8>, hold: Option<tokio::sync::oneshot::Receiver<()>>) -> Body {
    let stream = futures_util::stream::unfold((Some(bytes), hold), |(bytes, hold)| async move {
        match bytes {
            Some(bytes) => Some((Ok::<_, Infallible>(Bytes::from(bytes)), (None, hold))),
            None => {
                if let Some(hold) = hold {
                    let _ = hold.await;
                }
                None
            }
        }
    });
    Body::from_stream(stream)
}

fn build(request: &Value, hold: Option<tokio::sync::oneshot::Receiver<()>>) -> Request<Body> {
    let body = match request["base64"].as_str() {
        None => Body::empty(),
        Some(base64) => streamed(STANDARD.decode(base64).unwrap(), hold),
    };
    let mut built = Request::new(body);
    *built.method_mut() = Method::from_bytes(request["method"].as_str().unwrap().as_bytes()).unwrap();
    // A target with a literal space is no URI; a client sends it as `%20`,
    // which the URL parser reads the same way.
    *built.uri_mut() = request["target"]
        .as_str()
        .unwrap()
        .replace(' ', "%20")
        .parse::<Uri>()
        .unwrap();
    *built.headers_mut() = header_map(&request["headers"]);
    built
}

async fn answer(app: &Router, request: Request<Body>, data_dir: &str, backend: &TestBackend) -> Value {
    let response = app.clone().oneshot(request).await.unwrap();
    let key = encryption_key(backend.config.load().token_encryption_key.as_deref())
        .ok()
        .flatten();
    let mut recorded = record(response, data_dir).await;
    for value in recorded["headers"].as_object_mut().unwrap().values_mut() {
        *value = json!(unsealed(value.as_str().unwrap(), key.as_ref()));
    }
    recorded["sent"] = backend.recorder.take();
    recorded
}

static STATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([?&]state=)([^&]*)").unwrap());

/// A sealed `state=` shown as what it opens to.
fn unsealed(value: &str, key: Option<&SecretKey>) -> String {
    let Some(key) = key else { return value.to_owned() };
    STATE
        .replace_all(value, |captures: &regex::Captures<'_>| {
            let raw = format!("x={}", &captures[2]);
            let decoded = url::form_urlencoded::parse(raw.as_bytes())
                .next()
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default();
            match open(&decoded, key) {
                Ok(opened) => format!("{}SEALED({opened})", &captures[1]),
                Err(_) => captures[0].to_owned(),
            }
        })
        .into_owned()
}

async fn record(response: axum::response::Response, data_dir: &str) -> Value {
    let status = response.status().as_u16();
    let mut headers = Map::new();
    for name in response.headers().keys() {
        let value = response
            .headers()
            .get_all(name)
            .iter()
            .map(|value| value.as_bytes().iter().map(|&b| char::from(b)).collect::<String>())
            .collect::<Vec<_>>()
            .join(", ");
        headers.insert(name.as_str().to_owned(), json!(value.replace(data_dir, "$DATA_DIR")));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .map(|value| value.to_str().unwrap().to_owned())
        .unwrap_or_default();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = if bytes.is_empty() {
        Value::Null
    } else if content_type.starts_with("text/") || content_type.contains("json") {
        json!({"text": String::from_utf8(bytes.to_vec()).unwrap().replace(data_dir, "$DATA_DIR")})
    } else {
        let digest: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        json!({"sha256": digest, "length": bytes.len()})
    };
    json!({"status": status, "headers": headers, "body": body})
}

/// The golden's response, against what Rust answered (see the module notes
/// on `content-length`).
fn same_response(golden: &Value, actual: &mut Value) -> bool {
    let expected = json!({"status": golden["status"], "headers": golden["headers"], "body": golden["body"], "sent": golden["sent"]});
    if golden["headers"].get("content-length").is_none()
        && let Some(headers) = actual["headers"].as_object_mut()
        && headers
            .get("content-length")
            .and_then(Value::as_str)
            .is_some_and(|length| length.parse::<u64>().is_ok())
    {
        headers.remove("content-length");
    }
    &expected == actual
}

/// A step that prepares the case: SQL, files, directories, permissions.
fn setup(step: &Value, db: &BackendDb, data_dir: &Path, chmodded: &mut Vec<PathBuf>) {
    if let Some(sql) = step["sql"].as_str() {
        unsafe_db(db)
            .execute_batch(&sql.replace("$DATA_DIR", data_dir.to_str().unwrap()))
            .unwrap_or_else(|error| panic!("{sql}: {error}"));
    } else if let Some(file) = step["write"].as_str() {
        let path = data_dir.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, STANDARD.decode(step["base64"].as_str().unwrap()).unwrap()).unwrap();
    } else if let Some(dir) = step["mkdir"].as_str() {
        fs::create_dir_all(data_dir.join(dir)).unwrap();
    } else if let Some(path) = step["chmod"].as_str() {
        let path = data_dir.join(path);
        let mode = step["mode"].as_u64().unwrap() as u32;
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        chmodded.push(path);
    } else {
        panic!("unknown step {step}");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn http_matches_typescript_goldens() {
    tokio::task::LocalSet::new().run_until(replay_all()).await;
}

async fn replay_all() {
    let goldens: Value =
        serde_json::from_str(&fs::read_to_string(repo_root().join("parity/http/goldens.json")).unwrap()).unwrap();
    let base = repo_root().join("_trash-rust/tmp/http-goldens-rust");
    let _ = fs::remove_dir_all(&base);
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in goldens["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let slug: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let data_dir = base.join(slug);
        fs::create_dir_all(&data_dir).unwrap();
        let dir = data_dir.to_str().unwrap().to_owned();
        let config = load_config(env_pairs(&case["env"], &dir)).unwrap();
        let shared = SharedConfig::new(config);
        let recorder = Rc::new(Recorder::default());
        let backend = Rc::new(TestBackend {
            db: BackendDb::open(data_dir.join("pipeline.db")).unwrap(),
            clock: FixedClock(Cell::new(foundation::time::parse_iso_instant(T0).unwrap())),
            config: shared.clone(),
            host: Host {
                auth_circuit: AuthCircuitBreaker::new(SystemClock),
                usage: UsageRecorder::new(SystemClock),
                story_cards: StoryCardStore::new(SystemClock),
                video_completion: VideoCompletionNotice::new(SystemClock),
                reminders: ReminderJobs::new(SystemClock),
                readiness: CapabilityReadiness::new(shared),
            },
            http: HttpClient::new(recorder.clone()),
            recorder,
            entropy: ScriptedEntropy(Cell::new(0)),
        });
        let app = router(HttpState::new(backend.clone()));
        let golden_results = case["results"].as_array().unwrap();
        let mut next = golden_results.iter();
        let mut results = Vec::new();
        let mut chmodded = Vec::new();
        for step in case["steps"].as_array().unwrap() {
            if step.get("request").is_some() {
                let golden = next.next().unwrap();
                *backend.recorder.responses.borrow_mut() =
                    step["responses"].as_array().into_iter().flatten().cloned().collect();
                results.push((
                    golden,
                    answer(&app, build(&golden["request"], None), &dir, &backend).await,
                ));
                assert!(
                    backend.recorder.responses.borrow().is_empty(),
                    "{name}: canned responses left"
                );
            } else if let Some(held) = step["held_uploads"].as_array() {
                // Recorded in answer order: the refused third upload, then the two held ones.
                let meanwhile = next.next().unwrap();
                let mut pending = Vec::new();
                for _ in held {
                    let golden = next.next().unwrap();
                    let (release, hold) = tokio::sync::oneshot::channel::<()>();
                    let request = build(&golden["request"], Some(hold));
                    let app = app.clone();
                    let handle = tokio::task::spawn_local(async move { app.oneshot(request).await.unwrap() });
                    pending.push((golden, release, handle));
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
                results.push((
                    meanwhile,
                    answer(&app, build(&meanwhile["request"], None), &dir, &backend).await,
                ));
                for (golden, release, handle) in pending {
                    drop(release);
                    let mut recorded = record(handle.await.unwrap(), &dir).await;
                    recorded["sent"] = backend.recorder.take();
                    results.push((golden, recorded));
                }
            } else if let Some(at) = step["clock"].as_str() {
                backend.clock.0.set(foundation::time::parse_iso_instant(at).unwrap());
            } else {
                setup(step, &backend.db, &data_dir, &mut chmodded);
            }
        }
        for path in chmodded {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(next.next().is_none(), "{name}: responses left over");
        for (index, (golden, mut actual)) in results.into_iter().enumerate() {
            compared += 1;
            if !same_response(golden, &mut actual) {
                failures.push(format!(
                    "{name} #{index} {} {}:\n  ts:   {}\n  rust: {actual}",
                    golden["request"]["method"],
                    golden["request"]["target"],
                    json!({"status": golden["status"], "headers": golden["headers"], "body": golden["body"], "sent": golden["sent"]})
                ));
            }
        }
        let assets = assets(&backend.db, &dir);
        if case["assets"] != assets {
            failures.push(format!("{name}, assets:\n  ts:   {}\n  rust: {assets}", case["assets"]));
        }
        let incoming = backend.config.load().studio_media_dir.join(".incoming");
        let incoming = fs::read_dir(&incoming).ok().map_or(Value::Null, |entries| {
            json!(
                entries
                    .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                    .collect::<Vec<_>>()
            )
        });
        if case["incoming"] != incoming {
            failures.push(format!("{name}, incoming: ts {} rust {incoming}", case["incoming"]));
        }
        let config = backend.config.load();
        let key = encryption_key(config.token_encryption_key.as_deref()).ok().flatten();
        let sqlite = unsafe_db(&backend.db);
        let stored = json!({
            "channels": table_lines(sqlite, "channel_connections"),
            "tokens": tokens(sqlite, key.as_ref()),
            "credentials": credentials(&config),
        });
        for part in ["channels", "tokens", "credentials"] {
            if case[part] != stored[part] {
                failures.push(format!(
                    "{name}, {part}:\n  ts:   {}\n  rust: {}",
                    case[part], stored[part]
                ));
            }
        }
    }
    assert!(compared > 0);
    assert!(
        failures.is_empty(),
        "{} of {compared} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The rows of `table` as the recorder's `dump` wrote them.
fn table_lines(sqlite: &Connection, table: &str) -> Value {
    let columns: Vec<String> = sqlite
        .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
        .unwrap()
        .query_map([table], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let cells = columns
        .iter()
        .map(|column| format!(r#"typeof("{column}") || ':' || quote("{column}")"#))
        .collect::<Vec<_>>()
        .join(" || ' ' || ");
    let lines: Vec<String> = sqlite
        .prepare(&format!(
            r#"SELECT quote(rowid) || ' ' || {cells} FROM "{table}" ORDER BY rowid"#
        ))
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    json!(lines)
}

/// `platform_tokens` with the sealed values opened.
fn tokens(sqlite: &Connection, key: Option<&SecretKey>) -> Value {
    let mut statement = sqlite.prepare("SELECT * FROM platform_tokens ORDER BY rowid").unwrap();
    let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
    let rows: Vec<Vec<SqlValue>> = statement
        .query_map([], |row| (0..names.len()).map(|index| row.get(index)).collect())
        .unwrap()
        .map(Result::unwrap)
        .collect();
    rows.into_iter()
        .map(|row| {
            let object: Map<String, Value> = names
                .iter()
                .zip(row)
                .map(|(name, cell)| {
                    let value = match cell {
                        SqlValue::Null => Value::Null,
                        SqlValue::Integer(number) => number.into(),
                        SqlValue::Real(number) => number.into(),
                        SqlValue::Text(text) => match key {
                            Some(key) if name.starts_with("sealed_") => open(&text, key).unwrap().into(),
                            _ => text.into(),
                        },
                        SqlValue::Blob(_) => panic!("no blob columns"),
                    };
                    (name.clone(), value)
                })
                .collect();
            Value::Object(object)
        })
        .collect()
}

/// The credential settings of the live config.
fn credentials(config: &Config) -> Value {
    Value::Object(
        Setting::ALL
            .iter()
            .map(|setting| (setting.name().to_owned(), json!(setting.get(config))))
            .collect(),
    )
}

fn assets(db: &BackendDb, dir: &str) -> Value {
    let mut statement = unsafe_db(db)
        .prepare(
            "SELECT actor_id, kind, mime_type, filename, local_path, byte_size, sha256, source, created_at FROM studio_media_assets ORDER BY id",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "actor_id": row.get::<_, i64>(0)?,
                "kind": row.get::<_, String>(1)?,
                "mime_type": row.get::<_, String>(2)?,
                "filename": row.get::<_, String>(3)?,
                "local_path": row.get::<_, String>(4)?.replace(dir, "$DATA_DIR"),
                "byte_size": row.get::<_, i64>(5)?,
                "sha256": row.get::<_, String>(6)?,
                "source": row.get::<_, String>(7)?,
                "created_at": row.get::<_, String>(8)?,
            }))
        })
        .unwrap();
    Value::Array(rows.map(Result::unwrap).collect())
}

// ------------------------------------------------------------ helpers

fn goldens() -> Value {
    serde_json::from_str(&fs::read_to_string(repo_root().join("parity/http/goldens.json")).unwrap()).unwrap()
}

fn helper_config(env: &[(&str, &str)]) -> Config {
    let mut pairs = vec![("DATA_DIR", "/tmp/unused")];
    pairs.extend_from_slice(env);
    load_config(pairs).unwrap()
}

fn env_list(env: &Value) -> Vec<(String, String)> {
    env.as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned()))
        .collect()
}

#[test]
fn command_token_matches_typescript() {
    let goldens = goldens();
    for case in goldens["command_allowed"].as_array().unwrap() {
        let token = case["token"].as_str();
        let config = helper_config(
            &token
                .map(|token| ("COMMAND_CENTER_TOKEN", token))
                .into_iter()
                .collect::<Vec<_>>(),
        );
        let method = Method::from_bytes(case["method"].as_str().unwrap().as_bytes()).unwrap();
        let uri: Uri = case["target"].as_str().unwrap().parse().unwrap();
        let allowed = command_allowed(
            &method,
            &uri,
            &header_map(&case["headers"]),
            &config,
            case["payload"].as_str(),
        );
        assert_eq!(json!(allowed), case["result"], "{case}");
    }
}

#[test]
fn studio_actor_matches_typescript() {
    let goldens = goldens();
    for case in goldens["studio_actor"].as_array().unwrap() {
        let env = env_list(&case["env"]);
        let env: Vec<(&str, &str)> = env.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
        let config = helper_config(&env);
        assert_eq!(
            json!(mcp_studio_actor(&header_map(&case["headers"]), &config)),
            case["result"],
            "{case}"
        );
    }
}

#[test]
fn client_identity_matches_typescript() {
    let goldens = goldens();
    for case in goldens["client_identity"].as_array().unwrap() {
        let env = env_list(&case["env"]);
        let env: Vec<(&str, &str)> = env.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
        let config = helper_config(&env);
        assert_eq!(
            json!(client_ip_hash(&header_map(&case["headers"]), &config)),
            case["result"],
            "{case}"
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn stream_upload_matches_typescript() {
    let goldens = goldens();
    let base = repo_root().join("_trash-rust/tmp/http-stream-upload-rust");
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    for (index, case) in goldens["stream_upload"].as_array().unwrap().iter().enumerate() {
        let chunks: Vec<Result<Bytes, Infallible>> = case["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|chunk| Ok(Bytes::from(STANDARD.decode(chunk.as_str().unwrap()).unwrap())))
            .collect();
        let target = base.join(format!("stream-{index}"));
        let body = Body::from_stream(futures_util::stream::iter(chunks));
        let result = match stream_upload_to_file(body, &target, case["max"].as_u64().unwrap()).await {
            Ok(size) => json!({"size": size, "written": STANDARD.encode(fs::read(&target).unwrap())}),
            Err(error) => json!({"error": error.to_string()}),
        };
        assert_eq!(result, case["result"], "{case}");
    }
}
