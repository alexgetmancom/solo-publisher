//! The channels and the observability probes against their goldens: every
//! scenario in `channels_scenarios.json` has a recorded result
//! (`channels_scenarios.golden.json`) and runs through this crate, each on its
//! own fresh database under the same fixed clock, against a
//! recording transport answering the same canned responses. Every step's
//! result, the requests it sent and the live config's credentials, every
//! table, and `platform_tokens` with its sealed values opened must come out
//! identical. Randomness is scripted the same way as in the recording; a sealed
//! OAuth state is compared by what it opens to.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::LazyLock;

use content::Locale;
use db::rusqlite::Connection;
use db::rusqlite::types::Value as SqlValue;
use db::{BackendDb, unsafe_db};
use domain::application::ports::{Clock, FixedClock};
use domain::delivery::VideoCompletionNotice;
use domain::notifications::ReminderJobs;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::observability::capabilities::CapabilityReadiness;
use domain::observability::credentials::update_credential_checks;
use domain::observability::dates::{date_integrity, repair_stored_dates};
use domain::observability::failures::record_publication_failures;
use domain::observability::runtime_health::{ProcessBoot, record_memory_pressure, record_process_restart};
use domain::observability::usage::UsageRecorder;
use domain::publishing::boundaries::{NoWorker, SystemJitter};
use domain::publishing::video_types::VideoTarget;
use domain::publishing::{Boundaries, Publishing};
use domain::story_cards::StoryCardStore;
use domain::studio::Studio;
use domain::studio::boundaries::{ConnectPlatform, MetaOauthPlatform, StoryDerivatives, StudioBoundaries};
use domain::studio::services::channels::{ChannelInput, ChannelService, ZernioConnectionKey};
use foundation::config::{Config, SharedConfig, load_config};
use foundation::secret_box::{SecretKey, encryption_key, fingerprint, open, seal};
use providers::adapters::ProviderCalls;
use providers::channels::api_keys::{ApiKeyTarget, store_api_key};
use providers::channels::connect::{ConnectLinks, start_connect};
use providers::channels::credentials::{Setting, apply_stored_credentials};
use providers::channels::entropy::Entropy;
use providers::channels::meta::{
    exchange_meta_code, install_meta_token, meta_authorize_url, meta_oauth_authorize_url, meta_oauth_connect_path,
    meta_oauth_connect_url, meta_platform_name, renew_meta_tokens, verify_meta_oauth_state,
};
use providers::channels::oauth_routes::{
    OauthContext, OauthResponse, Query, meta_callback, meta_start, x_callback, x_start, youtube_callback, youtube_start,
};
use providers::channels::observability::cycle::{ProcessReading, run_observability_cycle};
use providers::channels::observability::memory::{MemorySnapshot, cgroup_memory_limit_bytes};
use providers::channels::observability::token_health::check_token_health;
use providers::channels::registry::{target_routing, video_channel_identity, video_destinations};
use providers::channels::token_store::{TokenWrite, store_platform_token};
use providers::channels::x::{
    exchange_x_code, refresh_x_token, x_oauth_authorize_url, x_oauth_connect_path, x_oauth_connect_url,
};
use providers::channels::youtube::{exchange_youtube_code, install_youtube_token, youtube_oauth_authorize_url};
use regex::Regex;
use runtime::http::{Fut, HttpClient, HttpRequest, HttpResponse, Transport, TransportFailure};
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

const BOOT_ID: &str = "00000000-0000-4000-8000-000000000001";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn spec_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/channels_scenarios.json")
}

// ---- the world ------------------------------------------------------------

/// Every draw but the 12-byte IV fills its buffer with a counter, as the
/// the recording's scripted `randomBytes` does; the IV is not drawn from here.
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
            let Some(next) = next else {
                return Err(TransportFailure {
                    message: "no canned response left".into(),
                    timed_out: false,
                });
            };
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
            let body = match next.get("json") {
                Some(json) => domain::json::stringify(json),
                None => next.get("body").and_then(Value::as_str).unwrap_or_default().to_owned(),
            };
            Ok(HttpResponse::buffered(
                u16::try_from(next["status"].as_u64().unwrap()).unwrap(),
                headers,
                body,
            ))
        })
    }
}

/// The boundaries a Studio handle needs that these scenarios never reach.
struct Quiet;

impl StoryDerivatives for Quiet {
    fn ensure(&self, _: &str, _: bool, _: i64) {}
}

struct World<'a> {
    db: &'a BackendDb,
    sqlite: &'a Connection,
    config: &'a SharedConfig,
    key: Option<SecretKey>,
    clock: &'a FixedClock,
    entropy: &'a ScriptedEntropy,
    recorder: Rc<Recorder>,
    http: HttpClient,
}

/// The Studio over the live config, built as in the recorded scenarios.
fn studio_parts<'a>(world: &'a World<'a>, config: &'a Config, parts: &'a StudioParts<'a>) -> Studio<'a> {
    Studio::new(
        Publishing::new(
            world.sqlite,
            world.clock,
            Boundaries {
                jitter: &SystemJitter,
                bell: &NoWorker,
                auth_circuit: &parts.breaker,
                usage: &parts.usage,
                story_cards: &parts.cards,
                video_completion: &parts.completion,
            },
        ),
        config,
        StudioBoundaries {
            reminders: &parts.reminders,
            story_derivatives: &Quiet,
            readiness: &parts.readiness,
            connect_links: &parts.links,
        },
    )
}

struct StudioParts<'a> {
    breaker: AuthCircuitBreaker<&'a FixedClock>,
    usage: UsageRecorder<&'a FixedClock>,
    cards: StoryCardStore<&'a FixedClock>,
    completion: VideoCompletionNotice<&'a FixedClock>,
    reminders: ReminderJobs<&'a FixedClock>,
    readiness: CapabilityReadiness,
    links: ConnectLinks<&'a FixedClock, &'a ScriptedEntropy>,
}

fn parts<'a>(world: &World<'a>) -> StudioParts<'a> {
    StudioParts {
        breaker: AuthCircuitBreaker::new(world.clock),
        usage: UsageRecorder::new(world.clock),
        cards: StoryCardStore::new(world.clock),
        completion: VideoCompletionNotice::new(world.clock),
        reminders: ReminderJobs::new(world.clock),
        readiness: CapabilityReadiness::new(world.config.clone()),
        links: ConnectLinks::new(world.clock, world.entropy),
    }
}

// ---- calls ----------------------------------------------------------------

fn arg<T: DeserializeOwned>(args: &[Value], index: usize) -> T {
    serde_json::from_value(args.get(index).cloned().unwrap_or(Value::Null))
        .unwrap_or_else(|error| panic!("argument {index} of {args:?}: {error}"))
}

fn text(args: &[Value], index: usize) -> String {
    arg(args, index)
}

fn locale(args: &[Value], index: usize) -> Locale {
    match text(args, index).as_str() {
        "ru" => Locale::Ru,
        "en" => Locale::En,
        other => panic!("unknown locale {other}"),
    }
}

/// A result as JavaScript holds it, through `JSON.stringify`.
fn out(value: impl Serialize) -> Value {
    serde_json::from_str(&domain::json::stringify(&serde_json::to_value(value).unwrap())).unwrap()
}

type Outcome = Result<Value, String>;

fn done<T: Serialize, E: std::fmt::Display>(result: Result<T, E>) -> Outcome {
    result.map(out).map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenSeed {
    token: String,
    refresh_token: Option<String>,
    seed: Option<String>,
    seed_fingerprint: Option<String>,
    account_id: Option<String>,
    expires_at: Option<String>,
    refreshed_at: String,
    upload_limit_bytes: Option<i64>,
}

async fn call(world: &World<'_>, name: &str, args: &[Value]) -> Outcome {
    let config = world.config.load();
    let now = world.clock.now();
    let sqlite = world.sqlite;
    let http = &world.http;
    let parts = parts(world);
    let studio = studio_parts(world, &config, &parts);
    let directory = ProviderCalls::new(world.http.clone(), world.config.clone());
    let service = ChannelService::new(studio, &directory);
    match name {
        "tokens.seed" => {
            let seed: TokenSeed = arg(args, 1);
            let key = world.key.as_ref().expect("tokens.seed needs TOKEN_ENCRYPTION_KEY");
            done(store_platform_token(
                sqlite,
                &text(args, 0),
                &TokenWrite {
                    sealed_token: seal(&seed.token, key),
                    seed_fingerprint: seed.seed.as_deref().map(fingerprint).or(seed.seed_fingerprint),
                    account_id: seed.account_id,
                    sealed_refresh_token: Some(seed.refresh_token.map(|token| seal(&token, key))),
                    expires_at: Some(seed.expires_at),
                    refreshed_at: seed.refreshed_at.clone(),
                    upload_limit_bytes: Some(seed.upload_limit_bytes),
                    updated_at: seed.refreshed_at,
                },
            ))
        }
        "credentials.apply" => done(apply_stored_credentials(world.config, sqlite)),
        "meta.renew" => done(renew_meta_tokens(world.config, sqlite, http, now).await),
        "meta.install" => done(install_meta_token(
            world.config,
            sqlite,
            &text(args, 0),
            &text(args, 1),
            &text(args, 2),
            now,
        )),
        "meta.connectUrl" => done(meta_oauth_connect_url(
            &config,
            arg(args, 0),
            locale(args, 1),
            now,
            world.entropy,
        )),
        "meta.connectPath" => done(meta_oauth_connect_path(&config, arg(args, 0), locale(args, 1))),
        "meta.authorizeUrl" => done(meta_oauth_authorize_url(&config, &text(args, 0), now)),
        "meta.authorize" => {
            let state: Option<String> = arg(args, 1);
            done(meta_authorize_url(&config, arg(args, 0), state.as_deref()))
        }
        "meta.verify" => done(
            verify_meta_oauth_state(&config, &text(args, 0), now)
                .map(|state| json!({"platform": meta_platform_name(state.platform), "locale": state.locale.as_str()})),
        ),
        "meta.exchange" => {
            let platform: MetaOauthPlatform = arg(args, 0);
            done(exchange_meta_code(http, &config, platform, &text(args, 1)).await)
        }
        "x.connectUrl" => done(x_oauth_connect_url(&config)),
        "x.connectPath" => done(x_oauth_connect_path(&config)),
        "x.authorizeUrl" => done(x_oauth_authorize_url(&config, now, world.entropy)),
        "x.exchange" => done(exchange_x_code(world.config, sqlite, http, &text(args, 0), &text(args, 1), now).await),
        "x.refresh" => done(refresh_x_token(world.config, sqlite, http, now).await),
        "youtube.authorizeUrl" => done(youtube_oauth_authorize_url(
            &config,
            locale(args, 0),
            now,
            world.entropy,
        )),
        "youtube.exchange" => done(
            exchange_youtube_code(world.config, sqlite, http, &text(args, 0), &text(args, 1), now)
                .await
                .map(|locale| json!({"locale": locale.as_str()})),
        ),
        "youtube.install" => done(install_youtube_token(
            world.config,
            sqlite,
            locale(args, 0),
            &text(args, 1),
            now,
        )),
        "apiKeys.store" => {
            let target = ApiKeyTarget::parse(&text(args, 0)).expect("API key target");
            done(store_api_key(world.config, sqlite, http, target, &text(args, 1), now).await)
        }
        "connect.start" => {
            let platform: ConnectPlatform = arg(args, 0);
            done(start_connect(&config, platform, locale(args, 1), now, world.entropy))
        }
        "route" => {
            let query: Map<String, Value> = arg::<Option<Map<String, Value>>>(args, 1).unwrap_or_default();
            let pairs: Vec<(String, String)> = query
                .into_iter()
                .map(|(name, value)| (name, value.as_str().unwrap().to_owned()))
                .collect();
            let context = OauthContext {
                config: world.config,
                sqlite,
                http,
                clock: world.clock,
                entropy: world.entropy,
                channels: &service,
            };
            let command = args.get(2).and_then(Value::as_bool).unwrap_or(false);
            let query = Query(&pairs);
            let response = match text(args, 0).as_str() {
                "/oauth/threads/start" => meta_start(context, MetaOauthPlatform::Threads, query, command),
                "/oauth/instagram/start" => meta_start(context, MetaOauthPlatform::Instagram, query, command),
                "/oauth/threads" => meta_callback(context, MetaOauthPlatform::Threads, query).await,
                "/oauth/instagram" => meta_callback(context, MetaOauthPlatform::Instagram, query).await,
                "/oauth/x/start" => x_start(context, command),
                "/oauth/x" => x_callback(context, query).await,
                "/oauth/youtube/start" => youtube_start(context, query, command),
                "/oauth/youtube" => youtube_callback(context, query).await,
                other => panic!("no route {other}"),
            };
            Ok(route_response(response))
        }
        "channels.connect" => {
            let input: ChannelInput = arg(args, 0);
            done(service.connect(&input, None))
        }
        "zernio.discover" => done(service.discover_zernio_connections(locale(args, 0)).await),
        "zernio.connect" => {
            let key: ZernioConnectionKey = arg(args, 2);
            done(service.connect_zernio(&text(args, 0), locale(args, 1), key).await)
        }
        "registry.routing" => done(target_routing(sqlite)),
        "registry.videoDestinations" => done(video_destinations(sqlite)),
        "registry.videoIdentity" => {
            let target = match text(args, 0).as_str() {
                "youtube_shorts" => VideoTarget::YoutubeShorts,
                "instagram_reels" => VideoTarget::InstagramReels,
                other => panic!("unknown video target {other}"),
            };
            done(video_channel_identity(sqlite, target, locale(args, 1)))
        }
        "tokenHealth.check" => done(check_token_health(&config, sqlite, http, world.clock).await),
        "credentialChecks.update" => done(update_credential_checks(&config, sqlite, world.clock)),
        "failures.record" => done(record_publication_failures(sqlite, world.clock)),
        "runtime.restart" => {
            let revision: Option<String> = arg(args, 0);
            done(record_process_restart(
                sqlite,
                world.clock,
                ProcessBoot {
                    id: BOOT_ID,
                    booted_at: now,
                },
                revision.as_deref(),
            ))
        }
        "runtime.memory" => done(record_memory_pressure(sqlite, world.clock, arg(args, 0), arg(args, 1))),
        "dates.integrity" => done(date_integrity(sqlite)),
        "dates.repair" => done(repair_stored_dates(sqlite, arg(args, 0))),
        "observability.cycle" => {
            let revision = runtime::git::git_revision(&repo_root());
            let process = ProcessReading {
                boot: ProcessBoot {
                    id: BOOT_ID,
                    booted_at: now,
                },
                revision: revision.as_deref(),
                memory: MemorySnapshot {
                    rss_bytes: 1024 * 1024,
                    ..MemorySnapshot::default()
                },
                memory_limit_bytes: cgroup_memory_limit_bytes(),
            };
            done(run_observability_cycle(&config, world.db, http, world.clock, &process, None).await)
        }
        "util.stateOf" => {
            let url = url::Url::parse(&text(args, 0)).unwrap();
            let state = url
                .query_pairs()
                .find(|(name, _)| name == "state")
                .map(|(_, value)| value.into_owned());
            Ok(json!({ "state": state }))
        }
        "util.tamper" => {
            let state = text(args, 0);
            let (encoded, signature) = state.split_once('.').unwrap();
            let signature = signature.split('.').next().unwrap();
            let first = if signature.starts_with('A') { "B" } else { "A" };
            Ok(json!({"value": format!("{encoded}.{first}{}", &signature[1..])}))
        }
        other => panic!("unknown call {other}"),
    }
}

/// The answer as the client sees it, after the `/oauth/*` middleware.
fn route_response(response: OauthResponse) -> Value {
    let mut headers: Vec<(String, String)> = response
        .headers
        .into_iter()
        .filter(|(name, _)| *name != "x-robots-tag" && *name != "cache-control")
        .map(|(name, value)| (name.to_owned(), value))
        .chain([
            ("x-robots-tag".to_owned(), "noindex, nofollow".to_owned()),
            ("cache-control".to_owned(), "no-store".to_owned()),
        ])
        .collect();
    headers.sort();
    json!({
        "status": response.status,
        "headers": headers.into_iter().map(|(name, value)| json!([name, value])).collect::<Vec<_>>(),
        "body": response.body,
    })
}

// ---- normalization and dumps ------------------------------------------------

static STATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([?&]state=)([^&]*)").unwrap());
static SEALED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$").unwrap());

/// A sealed value, alone or as a URL's `state=`, shown as what it opens to;
/// anything else as it is.
fn normalize(value: &Value, key: Option<&SecretKey>) -> Value {
    match value {
        Value::String(text)
            if SEALED.is_match(text)
                && let Some(opened) = key.and_then(|key| open(text, key).ok()) =>
        {
            Value::String(format!("SEALED({opened})"))
        }
        Value::String(text) => Value::String(
            STATE
                .replace_all(text, |captures: &regex::Captures<'_>| {
                    let whole = captures[0].to_owned();
                    let Some(key) = key else { return whole };
                    let raw = format!("x={}", &captures[2]);
                    let decoded = url::form_urlencoded::parse(raw.as_bytes())
                        .next()
                        .map(|(_, value)| value.into_owned())
                        .unwrap_or_default();
                    match open(&decoded, key) {
                        Ok(opened) => format!("{}SEALED({opened})", &captures[1]),
                        Err(_) => whole,
                    }
                })
                .into_owned(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(|item| normalize(item, key)).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(name, item)| (name.clone(), normalize(item, key)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn credentials(config: &Config) -> Value {
    Value::Object(
        Setting::ALL
            .iter()
            .map(|setting| {
                (
                    setting.name().to_owned(),
                    setting.get(config).map_or(Value::Null, Value::from),
                )
            })
            .collect(),
    )
}

fn strings(sqlite: &Connection, sql: &str, param: Option<&str>) -> Vec<String> {
    let mut statement = sqlite.prepare(sql).unwrap();
    statement
        .query_map(db::rusqlite::params_from_iter(param), |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// The dump the goldens were recorded with, statement for statement.
fn dump(sqlite: &Connection, ignored: &[String]) -> Map<String, Value> {
    let mut out = Map::new();
    for table in strings(
        sqlite,
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        None,
    ) {
        if ignored.contains(&table) {
            continue;
        }
        let columns = strings(
            sqlite,
            "SELECT name FROM pragma_table_info(?) ORDER BY cid",
            Some(&table),
        );
        let cells = columns
            .iter()
            .map(|column| format!(r#"typeof("{column}") || ':' || quote("{column}")"#))
            .collect::<Vec<_>>()
            .join(" || ' ' || ");
        let rows = strings(
            sqlite,
            &format!(r#"SELECT quote(rowid) || ' ' || {cells} AS line FROM "{table}" ORDER BY rowid"#),
            None,
        );
        if !rows.is_empty() {
            out.insert(table, rows.into_iter().map(Value::String).collect());
        }
    }
    out
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
                        SqlValue::Text(text) if name.starts_with("sealed_") => match key {
                            Some(key) => open(&text, key).unwrap_or_else(|_| format!("unopenable:{text}")).into(),
                            None => text.into(),
                        },
                        SqlValue::Text(text) => text.into(),
                        SqlValue::Blob(_) => panic!("no blob columns"),
                    };
                    (name.clone(), value)
                })
                .collect();
            Value::Object(object)
        })
        .collect()
}

fn lookup<'a>(vars: &'a Map<String, Value>, reference: &str) -> &'a Value {
    let (name, field) = reference.split_once('.').expect("reference is <name>.<field>");
    &vars.get(name).unwrap_or_else(|| panic!("unbound {name}"))[field]
}

/// `{"$": "<name>.<field>"}` arguments replaced by fields of bound results.
fn resolve(value: &Value, vars: &Map<String, Value>) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| resolve(item, vars)).collect()),
        Value::Object(object) => match object.get("$") {
            Some(Value::String(reference)) if object.len() == 1 => lookup(vars, reference).clone(),
            _ => Value::Object(
                object
                    .iter()
                    .map(|(name, item)| (name.clone(), resolve(item, vars)))
                    .collect(),
            ),
        },
        other => other.clone(),
    }
}

// ---- the run ----------------------------------------------------------------

async fn run(spec: &Value, scenario: &Value) -> Value {
    let db = BackendDb::open(":memory:").unwrap();
    let sqlite = unsafe_db(&db);
    let clock = FixedClock(Cell::new(
        foundation::time::parse_iso_instant(spec["clock"].as_str().unwrap()).unwrap(),
    ));
    let entropy = ScriptedEntropy(Cell::new(0));
    let mut env: Map<String, Value> = spec["config"].as_object().unwrap().clone();
    if let Some(overrides) = scenario.get("config").and_then(Value::as_object) {
        env.extend(overrides.clone());
    }
    let config = load_config(
        env.iter()
            .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned())),
    )
    .unwrap();
    let key = encryption_key(config.token_encryption_key.as_deref()).ok().flatten();
    let config = SharedConfig::new(config);
    let recorder = Rc::new(Recorder::default());
    let world = World {
        db: &db,
        sqlite,
        config: &config,
        key: key.clone(),
        clock: &clock,
        entropy: &entropy,
        http: HttpClient::new(recorder.clone()),
        recorder,
    };
    let ignored: Vec<String> = serde_json::from_value(spec["ignoredTables"].clone()).unwrap();
    for sql in spec["setup"].as_array().unwrap() {
        sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    let mut vars = Map::new();
    let mut results = Vec::new();
    for step in scenario["steps"].as_array().unwrap() {
        if let Some(at) = step.get("clock") {
            clock
                .0
                .set(foundation::time::parse_iso_instant(at.as_str().unwrap()).unwrap());
        } else if let Some(sql) = step.get("sql") {
            sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
        } else {
            let name = step["call"].as_str().expect("step without clock, sql or call");
            *world.recorder.responses.borrow_mut() = step
                .get("responses")
                .and_then(Value::as_array)
                .map(|responses| responses.iter().cloned().collect())
                .unwrap_or_default();
            world.recorder.sent.borrow_mut().clear();
            let args = resolve(step.get("args").unwrap_or(&json!([])), &vars);
            let result = match call(&world, name, args.as_array().unwrap()).await {
                Ok(value) => {
                    if let Some(bind) = step.get("bind").and_then(Value::as_str) {
                        let bound = if value.is_object() {
                            value.clone()
                        } else {
                            json!({"value": value})
                        };
                        vars.insert(bind.into(), bound);
                    }
                    value
                }
                Err(error) => json!({ "error": error }),
            };
            results.push(normalize(
                &json!({
                    "call": name,
                    "result": result,
                    "requests": world.recorder.sent(),
                    "unanswered": world.recorder.responses.borrow().len(),
                    "config": credentials(&config.load()),
                }),
                key.as_ref(),
            ));
        }
    }
    let mut ignored_tables = ignored;
    ignored_tables.push("platform_tokens".into());
    out(json!({
        "name": scenario["name"],
        "results": results,
        "tables": dump(sqlite, &ignored_tables),
        "tokens": tokens(sqlite, key.as_ref()),
    }))
}

/// What was recorded in `channels_scenarios.golden.json`. The runtime worker row carries the
/// revision the run was built from, which `<revision>` stands for.
fn golden() -> Value {
    let path = spec_path().with_extension("golden.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let revision = runtime::git::git_revision(&repo_root()).unwrap_or_default();
    serde_json::from_str(&text.replace("<revision>", &revision)).unwrap()
}

fn differences(expected: &[Value], actual: &[Value]) -> Vec<String> {
    assert_eq!(expected.len(), actual.len(), "scenario count");
    let mut failures = Vec::new();
    for (expected, actual) in expected.iter().zip(actual) {
        let name = expected["name"].as_str().unwrap();
        let (left, right) = (
            expected["results"].as_array().unwrap(),
            actual["results"].as_array().unwrap(),
        );
        assert_eq!(left.len(), right.len(), "{name}: step count");
        for (index, (left, right)) in left.iter().zip(right).enumerate() {
            for part in ["result", "requests", "unanswered", "config"] {
                if left[part] != right[part] {
                    failures.push(format!(
                        "{name}, step #{index} ({}) {part}:\n  ts:   {}\n  rust: {}",
                        left["call"], left[part], right[part]
                    ));
                }
            }
        }
        if expected["tokens"] != actual["tokens"] {
            failures.push(format!(
                "{name}, tokens:\n  ts:   {}\n  rust: {}",
                expected["tokens"], actual["tokens"]
            ));
        }
        let (left, right) = (
            expected["tables"].as_object().unwrap(),
            actual["tables"].as_object().unwrap(),
        );
        for table in left.keys().chain(right.keys().filter(|key| !left.contains_key(*key))) {
            if left.get(table) != right.get(table) {
                failures.push(format!(
                    "{name}, table {table}:\n  ts:   {}\n  rust: {}",
                    serde_json::to_string_pretty(&left.get(table)).unwrap(),
                    serde_json::to_string_pretty(&right.get(table)).unwrap()
                ));
            }
        }
    }
    failures
}

#[tokio::test(flavor = "current_thread")]
async fn channels_match_typescript() {
    let spec: Value = serde_json::from_str(&std::fs::read_to_string(spec_path()).unwrap()).unwrap();
    let golden = golden();
    let expected = golden["scenarios"].as_array().unwrap();
    let mut actual = Vec::new();
    for scenario in spec["scenarios"].as_array().unwrap() {
        actual.push(run(&spec, scenario).await);
    }
    let failures = differences(expected, &actual);
    assert!(
        failures.is_empty(),
        "{}\n\n{} differences",
        failures.join("\n"),
        failures.len()
    );
}
