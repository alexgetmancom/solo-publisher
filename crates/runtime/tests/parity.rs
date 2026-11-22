//! Parity with the TypeScript runtime foundation, against what
//! `bun scripts/rust/runtime-fixtures.ts` recorded. HTTP is replayed over a
//! recording transport answering the same canned responses the TypeScript
//! `fetchImpl` answered, and the requests both sides sent are compared.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::LazyLock;
use std::time::Duration;

use content::Locale;
use db::BackendDb;
use domain::publishing::boundaries::{MediaMetadata, MediaProbe};
use foundation::config::{Config, load_config};
use jiff::Timestamp;
use regex::Regex;
use runtime::external::deepseek::{ChatOptions, DeepSeekMessage, Role, deepseek_chat};
use runtime::external::telegram_files::{MaterializeOptions, TelegramFileSource, materialize_telegram_file};
use runtime::external::youtube::youtube_access_token;
use runtime::external::zernio::{list_zernio_accounts, zernio_account};
use runtime::ffmpeg::{
    FfmpegMediaProbe, ffprobe_failure, format_ffmpeg_failure, media_metadata_from_ffprobe, probe_media_metadata,
};
use runtime::http::{
    ExternalError, Fut, Headers, HttpClient, HttpRequest, HttpResponse, Method, Transport, TransportFailure, form_body,
    retry_after_seconds,
};
use runtime::scheduler::{LoopHooks, start_loop};
use runtime::worker_state::{HeartbeatLoops, expected_worker_names, record_worker_state, worker_liveness};
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    });
    &FIXTURE
}

fn rows(key: &str) -> &'static Vec<Value> {
    let rows = fixture()[key].as_array().unwrap();
    assert!(!rows.is_empty(), "fixture section {key} is empty");
    rows
}

fn text(value: &Value) -> &str {
    value
        .as_str()
        .unwrap_or_else(|| panic!("expected a string, got {value}"))
}

/// Every number as an f64, so `12` and `12.0` compare equal.
fn numbers(value: &Value) -> Value {
    match value {
        Value::Number(number) => json!(number.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.iter().map(numbers).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), numbers(item))).collect()),
        other => other.clone(),
    }
}

fn instant(ms: &Value) -> Timestamp {
    Timestamp::from_millisecond(ms.as_i64().unwrap()).unwrap()
}

/// This process's own directory under `_trash-rust/tmp/runtime-tests/`,
/// removed when the test is done with it.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl std::ops::Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

fn scratch(label: &str) -> Scratch {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../_trash-rust/tmp/runtime-tests")
        .join(format!("{}-{label}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Scratch(dir.canonicalize().unwrap())
}

// ---- recording transport --------------------------------------------------

/// Records each request as sent and answers the next canned response.
struct Recorder {
    sent: RefCell<Vec<HttpRequest>>,
    responses: RefCell<VecDeque<Value>>,
}

impl Recorder {
    fn new(responses: &Value) -> Rc<Self> {
        Rc::new(Self {
            sent: RefCell::new(Vec::new()),
            responses: RefCell::new(responses.as_array().unwrap().iter().cloned().collect()),
        })
    }

    /// The requests as the TypeScript recorder saw them through `new Request`:
    /// the normalized URL, header names lower-cased and sorted.
    fn sent(&self) -> Value {
        self.sent
            .borrow()
            .iter()
            .map(|request| {
                let mut headers: Vec<(String, String)> = request
                    .headers
                    .iter()
                    .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
                    .collect();
                headers.sort_by(|a, b| a.0.cmp(&b.0));
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
        let next = self
            .responses
            .borrow_mut()
            .pop_front()
            .expect("no canned response left");
        Box::pin(async move {
            if let Some(message) = next.get("throws") {
                return Err(TransportFailure {
                    message: text(message).into(),
                    timed_out: false,
                });
            }
            if next.get("hang").is_some() {
                return std::future::pending().await;
            }
            let headers = next
                .get("headers")
                .and_then(Value::as_array)
                .map(|pairs| {
                    pairs
                        .iter()
                        .map(|pair| (text(&pair[0]).to_owned(), text(&pair[1]).to_owned()))
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

fn error_shape(error: &ExternalError) -> Value {
    match error {
        ExternalError::Http(error) => json!({
            "kind": "http",
            "message": error.message,
            "status": error.status,
            "body": error.body,
            "retryAfterSeconds": error.retry_after_seconds,
        }),
        ExternalError::Transport(error) => json!({"kind": "transport", "message": error.message}),
        ExternalError::Message(message) => json!({"kind": "message", "message": message}),
    }
}

fn outcome<T: Into<Value>>(result: Result<T, ExternalError>) -> Value {
    match result {
        Ok(value) => json!({"ok": value.into()}),
        Err(error) => json!({"error": error_shape(&error)}),
    }
}

fn method(name: Option<&str>) -> Method {
    match name.unwrap_or("GET") {
        "GET" => Method::Get,
        "POST" => Method::Post,
        "PUT" => Method::Put,
        "PATCH" => Method::Patch,
        "DELETE" => Method::Delete,
        other => panic!("method {other}"),
    }
}

// ---- http ------------------------------------------------------------------

#[test]
fn retry_after_matches_typescript() {
    for case in rows("retry_after") {
        let headers = Headers(
            case["headers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|pair| (text(&pair[0]).to_owned(), text(&pair[1]).to_owned()))
                .collect(),
        );
        assert_eq!(
            retry_after_seconds(&headers, instant(&case["nowMs"])),
            case["seconds"].as_f64(),
            "{case}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn request_json_matches_typescript() {
    for case in rows("request_json") {
        let spec = &case["request"];
        let mut request = HttpRequest::new(method(spec["method"].as_str()), text(&spec["url"]));
        if let Some(headers) = spec.get("headers").and_then(Value::as_object) {
            for (name, value) in headers {
                request = request.header(name, text(value));
            }
        }
        if let Some(body) = spec.get("body").and_then(Value::as_str) {
            request = request.text(body);
        }
        let recorder = Recorder::new(&case["responses"]);
        let client = HttpClient::new(recorder.clone());
        let result = match case.get("ceilingMs").and_then(Value::as_u64) {
            Some(ceiling) => outcome(
                client
                    .fetch_within(request, Duration::from_millis(ceiling))
                    .await
                    .map(|response| response.status),
            ),
            None => outcome(client.request_json(request).await),
        };
        assert_eq!(recorder.sent(), case["sent"], "{spec}");
        assert_eq!(numbers(&result), numbers(&case["result"]), "{spec}");
    }
}

#[test]
fn form_body_matches_url_search_params() {
    for case in rows("form_body") {
        let fields: Vec<(&str, Option<&str>)> = case["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| (text(&pair[0]), pair[1].as_str()))
            .collect();
        assert_eq!(form_body(&fields), text(&case["body"]), "{case}");
    }
}

// ---- ffmpeg / ffprobe --------------------------------------------------------

fn metadata_json(metadata: &MediaMetadata) -> Value {
    json!({
        "width": metadata.width,
        "height": metadata.height,
        "durationSeconds": metadata.duration_seconds,
        "videoCodec": metadata.video_codec,
        "audioCodec": metadata.audio_codec,
        "fps": metadata.fps,
        "audioBitrate": metadata.audio_bitrate,
    })
}

#[test]
fn ffmpeg_failures_keep_the_same_reason() {
    for case in rows("ffmpeg_failure") {
        let code = i32::try_from(case["code"].as_i64().unwrap()).unwrap();
        assert_eq!(
            format_ffmpeg_failure(code, text(&case["stderr"])),
            text(&case["message"]),
            "{case}"
        );
    }
}

#[test]
fn ffprobe_output_maps_to_the_same_metadata() {
    for case in rows("ffprobe") {
        let exit = i32::try_from(case["exit"].as_i64().unwrap()).unwrap();
        let result = if exit == 0 {
            media_metadata_from_ffprobe(text(&case["stdout"]))
        } else {
            Err(ffprobe_failure(exit, text(&case["stderr"])))
        };
        let actual = match result {
            Ok(metadata) => json!({"ok": metadata_json(&metadata)}),
            Err(error) => json!({"error": error.0}),
        };
        assert_eq!(numbers(&actual), numbers(&case["result"]), "{case}");
    }
}

/// Needs ffmpeg and ffprobe on PATH. The clip is committed: an encode's AAC
/// bitrate differs between ffmpeg builds, a probe of the same file does not.
#[tokio::test]
async fn a_real_clip_probes_as_in_typescript() {
    let case = &rows("real_probe")[0];
    let clip = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/real-probe.mp4");
    let metadata = probe_media_metadata(clip.to_str().unwrap(), Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(numbers(&metadata_json(&metadata)), numbers(&case["metadata"]));

    let probe = FfmpegMediaProbe;
    assert_eq!(probe.probe(clip.to_str().unwrap()).await.unwrap(), metadata);
    let stats = probe.audio_stats(clip.to_str().unwrap()).await.unwrap();
    assert!(stats.contains("lavfi.astats.Overall.RMS_trough="), "{stats}");
    // A steady tone is a background bed.
    assert!(
        !domain::publishing::video_audio::background_music_likely_missing(&probe, clip.to_str().unwrap(), Some("aac"))
            .await
    );
    let missing = probe.probe("/nonexistent/clip.mp4").await.unwrap_err();
    assert!(missing.starts_with("media_probe_failed: ffprobe exit 1: "), "{missing}");
}

// ---- worker state ------------------------------------------------------------

static INSTANT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z").unwrap());

/// Heartbeat hooks stamp the wall clock; the recorder's clock was fixed.
fn masked(value: &str) -> String {
    INSTANT.replace_all(value, "<instant>").into_owned()
}

fn worker_rows(db: &BackendDb) -> Value {
    let sqlite = db::unsafe_db(db);
    let mut select = sqlite
        .prepare("SELECT name, state_json, updated_at FROM worker_state ORDER BY name")
        .unwrap();
    let rows = select
        .query_map([], |row| {
            Ok(json!({
                "name": row.get::<_, String>(0)?,
                "state_json": masked(&row.get::<_, String>(1)?),
                "updated_at": masked(&row.get::<_, String>(2)?),
            }))
        })
        .unwrap();
    Value::Array(rows.map(Result::unwrap).collect())
}

#[test]
fn worker_state_rows_match_typescript() {
    let db = Rc::new(BackendDb::open(":memory:").unwrap());
    let loops = HeartbeatLoops::new(Rc::clone(&db), |db| db);
    let mut hooks: Vec<(String, LoopHooks)> = Vec::new();
    for case in rows("worker_state") {
        let step = &case["step"];
        let name = text(&step["name"]);
        if !hooks.iter().any(|(known, _)| known == name) {
            hooks.push((name.to_owned(), loops.hooks(name)));
        }
        let hook = &hooks.iter().find(|(known, _)| known == name).unwrap().1;
        let at: Timestamp = text(&step["at"]).parse().unwrap();
        match text(&step["op"]) {
            "state" => {
                let state: Map<String, Value> = step["state"].as_object().unwrap().clone();
                record_worker_state(&db, name, state, step["error"].as_str(), at).unwrap();
            }
            "start" => hook.on_start.as_ref().unwrap()().unwrap(),
            "heartbeat" => hook.on_heartbeat.as_ref().unwrap()().unwrap(),
            "finish" => hook.on_finish.as_ref().unwrap()(step["error"].as_str()).unwrap(),
            other => panic!("step {other}"),
        }
        let expected: Vec<Value> = case["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                json!({
                    "name": row["name"],
                    "state_json": masked(text(&row["state_json"])),
                    "updated_at": masked(text(&row["updated_at"])),
                })
            })
            .collect();
        assert_eq!(worker_rows(&db), Value::Array(expected), "{step}");
    }
}

#[test]
fn record_worker_state_stamps_the_given_instant() {
    let db = BackendDb::open(":memory:").unwrap();
    let at: Timestamp = "2026-11-21T10:01:30Z".parse().unwrap();
    record_worker_state(&db, "queue", Map::new(), None, at).unwrap();
    let (state, updated): (String, String) = db::unsafe_db(&db)
        .query_row("SELECT state_json, updated_at FROM worker_state", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(updated, "2026-11-21T10:01:30.000Z");
    assert_eq!(
        state,
        r#"{"ok":true,"last_run_at":"2026-11-21T10:01:30.000Z","last_error":null,"scheduler_error":null,"last_heartbeat_at":"2026-11-21T10:01:30.000Z"}"#
    );
}

#[test]
fn liveness_and_expected_names_match_typescript() {
    for case in rows("expected_worker_names") {
        let names: Vec<&str> = case["names"].as_array().unwrap().iter().map(text).collect();
        assert_eq!(expected_worker_names(case["telegram"].as_bool().unwrap()), names);
    }
    for case in rows("liveness") {
        let liveness = worker_liveness(
            case["state"].as_object().unwrap(),
            text(&case["updatedAt"]),
            instant(&case["nowMs"]),
        );
        let actual = json!({
            "ageSeconds": liveness.age_seconds,
            "stale": liveness.stale,
            "lastHeartbeatAt": liveness.last_heartbeat_at,
        });
        assert_eq!(numbers(&actual), numbers(&case["result"]), "{case}");
    }
}

// ---- scheduler ------------------------------------------------------------------

#[tokio::test]
async fn scheduler_cycles_match_typescript() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let trace = Rc::new(RefCell::new(Vec::<String>::new()));
            let pending = Rc::new(RefCell::new(
                VecDeque::<tokio::sync::oneshot::Sender<Result<(), String>>>::new(),
            ));
            let number = Rc::new(RefCell::new(0));
            let task = {
                let (trace, pending, number) = (Rc::clone(&trace), Rc::clone(&pending), Rc::clone(&number));
                move || {
                    *number.borrow_mut() += 1;
                    trace.borrow_mut().push(format!("task {}", number.borrow()));
                    let (release, released) = tokio::sync::oneshot::channel();
                    pending.borrow_mut().push_back(release);
                    async move { released.await.unwrap() }
                }
            };
            let hooks = LoopHooks {
                on_start: Some(Box::new({
                    let trace = Rc::clone(&trace);
                    move || {
                        trace.borrow_mut().push("start".into());
                        Ok(())
                    }
                })),
                on_finish: Some(Box::new({
                    let trace = Rc::clone(&trace);
                    move |error: Option<&str>| {
                        trace.borrow_mut().push(format!("finish {}", error.unwrap_or("ok")));
                        Ok(())
                    }
                })),
                ..LoopHooks::default()
            };
            let scheduled = Rc::new(start_loop("demo", Duration::from_secs(1_000_000), task, hooks));
            let settle = || async {
                for _ in 0..10 {
                    tokio::task::yield_now().await;
                }
            };
            settle().await;
            let mut steps = vec![json!({"action": "begin", "trace": trace.take()})];
            for case in &rows("scheduler")[1..] {
                let action = text(&case["action"]);
                match action {
                    "wake" => scheduled.wake(),
                    "stop" => {
                        let (scheduled, trace) = (Rc::clone(&scheduled), Rc::clone(&trace));
                        tokio::task::spawn_local(async move {
                            scheduled.stop().await;
                            trace.borrow_mut().push("stopped".into());
                        });
                    }
                    "release-ok" | "release-error" => {
                        let release = pending.borrow_mut().pop_front().unwrap();
                        let _ = release.send(if action == "release-ok" {
                            Ok(())
                        } else {
                            Err("boom".into())
                        });
                    }
                    other => panic!("action {other}"),
                }
                settle().await;
                steps.push(json!({"action": action, "trace": trace.take()}));
            }
            assert_eq!(Value::Array(steps), Value::Array(rows("scheduler").clone()));
        })
        .await;
}

// ---- external helpers ------------------------------------------------------------

fn config(zernio: bool) -> Config {
    let env = [
        ("DATA_DIR", "/fixture/data"),
        ("DEEPSEEK_API_KEY", "fixture-deepseek-key"),
        ("YOUTUBE_RU_CLIENT_ID", "ru-client.apps.example"),
        ("YOUTUBE_RU_CLIENT_SECRET", "ru-secret"),
        ("YOUTUBE_RU_REFRESH_TOKEN", "1//ru-refresh"),
        ("YOUTUBE_EN_CLIENT_ID", "en-client.apps.example"),
        ("YOUTUBE_EN_CLIENT_SECRET", "en-secret"),
        ("YOUTUBE_EN_REFRESH_TOKEN", "1//en-refresh"),
        ("CONTROLLER_BOT_TOKEN", "123456789:fixture-controller"),
        ("TELEGRAM_API_BASE_URL", "https://bot-api.example/"),
    ];
    Config {
        zernio_api_key: zernio.then(|| "fixture-zernio-key".to_owned()),
        ..load_config(env).unwrap()
    }
}

async fn materialized(
    client: &HttpClient,
    config: &Config,
    source: TelegramFileSource<'_>,
    token: Option<&str>,
    target: Option<&Path>,
) -> Result<Value, ExternalError> {
    let placed = materialize_telegram_file(
        client,
        config,
        source,
        MaterializeOptions {
            token,
            target,
            extension: None,
        },
    )
    .await?;
    Ok(match target {
        Some(_) => json!({
            "name": placed.path.file_name().unwrap().to_str().unwrap(),
            "temporary": placed.temporary,
            "content": std::fs::read_to_string(&placed.path).unwrap(),
        }),
        None => json!({"path": placed.path.to_str().unwrap(), "temporary": placed.temporary}),
    })
}

#[tokio::test]
async fn external_helpers_send_what_typescript_sent() {
    let downloads = scratch("downloads");
    let messages = [
        DeepSeekMessage {
            role: Role::System,
            content: "Translate to English.".into(),
        },
        DeepSeekMessage {
            role: Role::User,
            content: "Привет".into(),
        },
    ];
    let chat = |temperature: f64, json: bool| ChatOptions {
        temperature,
        timeout: Duration::from_secs(40),
        json,
    };
    for case in rows("external") {
        let name = text(&case["name"]);
        let recorder = Recorder::new(&case["responses"]);
        let client = HttpClient::new(recorder.clone());
        let config = config(name.starts_with("zernio") && name != "zernio-no-key");
        let target = |file: &str| downloads.join(file);
        let result = match name {
            "deepseek-json" => outcome(deepseek_chat(&client, &config, &messages, chat(0.1, true)).await),
            "deepseek-text" => outcome(deepseek_chat(&client, &config, &messages, chat(1.0, false)).await),
            "deepseek-refused" => outcome(deepseek_chat(&client, &config, &messages, chat(0.0, false)).await),
            "youtube-token-ru" => outcome(youtube_access_token(&client, &config, Locale::Ru).await),
            "youtube-token-en" => outcome(youtube_access_token(&client, &config, Locale::En).await),
            "zernio-accounts-object" | "zernio-accounts-array" | "zernio-no-key" => outcome(
                list_zernio_accounts(&client, &config)
                    .await
                    .map(|accounts| serde_json::to_value(accounts).unwrap()),
            ),
            "zernio-account-missing" => outcome(
                zernio_account(&client, &config, "nope")
                    .await
                    .map(|account| serde_json::to_value(account).unwrap()),
            ),
            "telegram-file-by-id" => outcome(
                materialized(
                    &client,
                    &config,
                    TelegramFileSource::FileId("F1"),
                    Some("987654321:fixture-other"),
                    Some(&target("by-id.mp4")),
                )
                .await,
            ),
            "telegram-file-get-file-refused" => outcome(
                materialized(
                    &client,
                    &config,
                    TelegramFileSource::FileId("F2"),
                    None,
                    Some(&target("refused.mp4")),
                )
                .await,
            ),
            "telegram-file-download-status" | "telegram-file-download-failed" => outcome(
                materialized(
                    &client,
                    &config,
                    TelegramFileSource::FilePath("photos/file_1.jpg"),
                    None,
                    Some(&target("gone.jpg")),
                )
                .await,
            ),
            "telegram-file-absolute" => outcome(
                materialized(
                    &client,
                    &config,
                    TelegramFileSource::FilePath("/var/lib/telegram-bot-api/file.mp4"),
                    None,
                    None,
                )
                .await,
            ),
            other => panic!("case {other} is not replayed"),
        };
        assert_eq!(recorder.sent(), case["sent"], "{name}");
        assert_eq!(numbers(&result), numbers(&case["result"]), "{name}");
    }
    // Failed downloads leave nothing behind, not even the temporary file.
    let left: Vec<_> = std::fs::read_dir(&*downloads)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left, ["by-id.mp4"]);
}
