//! The golden replay: each case of parity/bot-goldens/ runs against the Rust
//! bot on the database the TypeScript recorder seeded for it, with the same
//! updates, the same clock and a fake Telegram that answers and normalises as
//! the recorder's did; the recorded calls must come out byte for byte.
//!
//! The recorder's seeds are committed as SQL (`parity/bot-goldens/seeds/`:
//! `schema.sql`, then per database its rows, `<file>.schema.sql` where its
//! schema differs, and each case's `<case>.meta.json`), with the recorder's
//! temporary directory written as `<tmp>`. [`ensure_seeds`] builds them into
//! `_trash-rust/tmp/bot-goldens-seeds/` and puts the recorder's files under
//! [`recorder_tmp`], once per change of the committed seeds.
//!
//! The seeds are shared and only read. Everything a case writes — its copy of
//! the database, its `DATA_DIR` — is in a [`Scratch`] directory of its own
//! (`_trash-rust/tmp/bot-tests/<pid>-<n>-<label>/`, removed when the case is
//! done), so test threads and concurrent `cargo test` runs never share a file.

pub mod deepseek;
pub mod deploy_agent;
pub mod host;
pub mod media_probe;
pub mod pending;
pub mod telegram;
pub mod triggers;
pub mod zernio;

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bot::api::types::Update;
use bot::{Bot, BotDeps, DynAdapters};
use db::BackendDb;
use foundation::config::{SharedConfig, load_config};
use foundation::i18n::{Key, t};
use jiff::Timestamp;
use runtime::http::HttpClient;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use std::future::Future;

use deepseek::GoldenDeepSeek;
use deploy_agent::GoldenDeployAgent;
use host::{FixedClock, GoldenAdapters, GoldenHost};
use telegram::FakeTelegram;
use zernio::GoldenZernio;

const BOT_TOKEN: &str = "123456:TEST-TOKEN";
const NOW: &str = "2026-08-20T09:00:00.000Z";

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn goldens_dir() -> PathBuf {
    repo_root().join("parity/bot-goldens")
}

fn seeds_dir() -> PathBuf {
    repo_root().join("_trash-rust/tmp/bot-goldens-seeds")
}

fn committed_seeds() -> PathBuf {
    goldens_dir().join("seeds")
}

/// Ends the tables of a schema file; its indexes and triggers follow, and are
/// created after the rows, so no trigger rewrites what was recorded.
const SCHEMA_REST: &str = "-- indexes and triggers, created after the rows\n";

/// The recorder's temporary directory, which `<tmp>` stands for.
pub fn recorder_tmp() -> PathBuf {
    repo_root().join("_trash-rust/tmp/bot-goldens")
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Every committed golden, as `(area, case)`, in directory order.
pub fn cases(area: &str) -> Vec<String> {
    let mut cases: Vec<String> = std::fs::read_dir(goldens_dir().join(area))
        .unwrap_or_else(|error| panic!("parity/bot-goldens/{area}: {error}"))
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().into_string().ok()?;
            name.strip_suffix(".json").map(str::to_owned)
        })
        .collect();
    cases.sort();
    cases
}

pub fn areas() -> Vec<String> {
    let mut areas: Vec<String> = std::fs::read_dir(goldens_dir())
        .unwrap()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            entry
                .file_type()
                .ok()?
                .is_dir()
                .then(|| entry.file_name().into_string().ok())?
        })
        .filter(|area| area != "seeds" && area != "fixtures")
        .collect();
    areas.sort();
    areas
}

/// Builds the seed databases and the recorder's files from the committed
/// seeds, unless the last build was of the same seeds.
pub fn ensure_seeds() {
    static READY: OnceLock<Result<(), String>> = OnceLock::new();
    let ready = READY.get_or_init(|| {
        // Another `cargo test` may be checking or building the same seeds.
        let lock_path = repo_root().join("_trash-rust/tmp/bot-goldens-seeds.lock");
        std::fs::create_dir_all(lock_path.parent().unwrap()).map_err(|error| error.to_string())?;
        let lock = std::fs::File::create(&lock_path).map_err(|error| format!("{}: {error}", lock_path.display()))?;
        lock.lock()
            .map_err(|error| format!("{}: {error}", lock_path.display()))?;
        let stamp = seeds_stamp()?;
        let stamp_path = seeds_dir().join("stamp");
        if std::fs::read_to_string(&stamp_path).is_ok_and(|built| built == stamp) {
            return Ok(());
        }
        build_seeds()?;
        std::fs::write(&stamp_path, stamp).map_err(|error| error.to_string())
    });
    if let Err(error) = ready {
        panic!("{error}");
    }
}

/// Every committed seed and fixture file, in order, by name and content.
fn seeds_stamp() -> Result<String, String> {
    let mut files = Vec::new();
    for dir in [committed_seeds(), goldens_dir().join("fixtures")] {
        collect_files(&dir, &mut files)?;
    }
    files.sort();
    let mut hash = Sha256::new();
    for file in files {
        hash.update(file.display().to_string().as_bytes());
        hash.update(std::fs::read(&file).map_err(|error| format!("{}: {error}", file.display()))?);
    }
    Ok(hex(&hash.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

fn io_error(path: &Path) -> impl Fn(std::io::Error) -> String + '_ {
    move |error| format!("{}: {error}", path.display())
}

fn build_seeds() -> Result<(), String> {
    let tmp = recorder_tmp();
    let tmp_text = tmp.display().to_string();
    // The recorder's fixtures, and the content-addressed copies of them its
    // cases left under `<tmp>/cases/` (`<first 24 hex of the sha256>.<ext>`).
    let fixtures = tmp.join("fixtures");
    std::fs::create_dir_all(&fixtures).map_err(io_error(&fixtures))?;
    let mut by_hash = Vec::new();
    for entry in std::fs::read_dir(goldens_dir().join("fixtures")).map_err(|error| error.to_string())? {
        let source = entry.map_err(|error| error.to_string())?.path();
        let bytes = std::fs::read(&source).map_err(io_error(&source))?;
        let target = fixtures.join(source.file_name().unwrap());
        std::fs::write(&target, &bytes).map_err(io_error(&target))?;
        by_hash.push((hex(&Sha256::digest(&bytes)), target));
    }
    let case_file = regex::Regex::new(r"<tmp>/cases/[^'\s]+").unwrap();

    let _ = std::fs::remove_dir_all(seeds_dir());
    let shared = std::fs::read_to_string(committed_seeds().join("schema.sql")).map_err(|error| error.to_string())?;
    for area in areas() {
        let source = committed_seeds().join(&area);
        let target = seeds_dir().join(&area);
        std::fs::create_dir_all(&target).map_err(io_error(&target))?;
        for entry in std::fs::read_dir(&source).map_err(io_error(&source))? {
            let path = entry.map_err(|error| error.to_string())?.path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(&path).map_err(io_error(&path))?;
            if name.ends_with(".meta.json") {
                std::fs::write(target.join(&name), text.replace("<tmp>", &tmp_text)).map_err(io_error(&path))?;
                continue;
            }
            let Some(base) = name.strip_suffix(".sql").filter(|base| !base.ends_with(".schema")) else {
                continue;
            };
            for found in case_file.find_iter(&text) {
                let file = PathBuf::from(found.as_str().replacen("<tmp>", &tmp_text, 1));
                let stem = file.file_stem().unwrap().to_string_lossy().into_owned();
                let (_, fixture) = by_hash
                    .iter()
                    .find(|(hash, _)| hash.starts_with(&stem))
                    .ok_or_else(|| format!("{name}: no fixture for {}", file.display()))?;
                std::fs::create_dir_all(file.parent().unwrap()).map_err(io_error(&file))?;
                std::fs::copy(fixture, &file).map_err(io_error(&file))?;
            }
            let own = source.join(format!("{base}.schema.sql"));
            let schema = if own.exists() {
                std::fs::read_to_string(&own).map_err(io_error(&own))?
            } else {
                shared.clone()
            };
            let (tables, rest) = schema
                .split_once(SCHEMA_REST)
                .ok_or_else(|| format!("{base}: schema without its marker"))?;
            let rows = text.replace("<tmp>", &tmp_text);
            let sqlite =
                db::rusqlite::Connection::open(target.join(format!("{base}.db"))).map_err(|error| error.to_string())?;
            sqlite
                // Rows go in table order, not in the order their references
                // allow; the bundled SQLite enforces foreign keys by default.
                .execute_batch(&format!("PRAGMA foreign_keys = OFF;BEGIN;{tables}{rows}{rest}COMMIT;"))
                .map_err(|error| format!("{area}/{name}: {error}"))?;
        }
    }
    Ok(())
}

fn instant(text: &str) -> Timestamp {
    foundation::time::parse_iso_instant(text).unwrap()
}

/// The configuration harness.ts gives every case, plus the case's own env.
fn env(data_dir: &Path, case_env: &Value) -> Vec<(String, String)> {
    let mut vars: Vec<(String, String)> = [
        ("NODE_ENV", "test"),
        ("CONTROLLER_BOT_TOKEN", BOT_TOKEN),
        ("CONTROLLER_ADMIN_IDS", "1001"),
        ("TELEGRAM_API_BASE_URL", "http://telegram.invalid"),
        ("DEPLOY_AGENT_URL", "http://deploy-agent.invalid"),
        ("DEPLOY_AGENT_TOKEN", "deploy-agent-test-token"),
        ("YOUTUBE_RU_CLIENT_ID", "youtube-ru-client"),
        ("YOUTUBE_RU_CLIENT_SECRET", "youtube-ru-secret"),
        ("YOUTUBE_RU_REFRESH_TOKEN", "youtube-ru-refresh"),
        ("YOUTUBE_EN_CLIENT_ID", "youtube-en-client"),
        ("YOUTUBE_EN_CLIENT_SECRET", "youtube-en-secret"),
        ("YOUTUBE_EN_REFRESH_TOKEN", "youtube-en-refresh"),
        ("INSTAGRAM_RU_ACCESS_TOKEN", "instagram-ru-token"),
        ("INSTAGRAM_RU_USER_ID", "1700000000000001"),
        ("INSTAGRAM_EN_ACCESS_TOKEN", "instagram-en-token"),
        ("INSTAGRAM_EN_USER_ID", "1700000000000002"),
    ]
    .iter()
    .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
    .collect();
    vars.push(("DATA_DIR".into(), data_dir.display().to_string()));
    for (key, value) in case_env.as_object().into_iter().flatten() {
        vars.retain(|(known, _)| known != key);
        vars.push((key.clone(), value.as_str().unwrap_or_default().to_owned()));
    }
    vars
}

fn bot_user() -> Value {
    json!({"first_name": "Studio", "id": 123456, "is_bot": true, "username": "studio_test_bot"})
}

/// Loads a step's database seed into the live connection: every table's rows
/// replaced by the seed's, and a table the seed no longer has dropped.
pub fn reseed(sqlite: &db::rusqlite::Connection, path: &Path) {
    let tables: Vec<String> = {
        let mut statement = sqlite
            .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    sqlite.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    sqlite
        .execute("ATTACH DATABASE ? AS seed", [path.display().to_string()])
        .unwrap();
    let seeded: Vec<String> = {
        let mut statement = sqlite
            .prepare("select name from seed.sqlite_master where type = 'table'")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let mut script = String::from("BEGIN;");
    for table in &tables {
        // A table the recorder dropped between steps is dropped here too.
        if !seeded.contains(table) {
            script.push_str(&format!(r#"DROP TABLE main."{table}";"#));
            continue;
        }
        script.push_str(&format!(
            r#"DELETE FROM main."{table}"; INSERT INTO main."{table}" SELECT * FROM seed."{table}";"#
        ));
    }
    let has_sequence: bool = sqlite
        .query_row(
            "select count(*) > 0 from main.sqlite_master where name = 'sqlite_sequence'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    if has_sequence {
        script.push_str(
            "DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM seed.sqlite_sequence;",
        );
    }
    script.push_str("COMMIT;");
    sqlite.execute_batch(&script).unwrap();
    sqlite
        .execute_batch("DETACH DATABASE seed; PRAGMA foreign_keys = ON")
        .unwrap();
}

/// Where the Rust bot differs from the recording on purpose
/// (docs/decisions.md), applied to the expected calls and checked to be
/// exactly what the decision says.
fn deliberate_deviations(area: &str, case: &str, steps: &mut [Value]) {
    if (area, case) == ("entry", "bootstrap") {
        let description = &mut steps[0]["calls"][0]["payload"]["commands"][0]["description"];
        assert_eq!(
            description,
            &json!("Restore bot menu"),
            "the TypeScript bot sends the EN command description"
        );
        *description = json!(t(Key::BotCommandStart, &[]));
    }
    without_language_button(steps);
    without_language_in_system_body(steps);
}

/// The System screen's body no longer names the language setting
/// (docs/decisions.md): every recorded body carries the TypeScript text,
/// and the Rust bot sends the catalog's, in the calls and in the updates that
/// tap a message showing it.
fn without_language_in_system_body(steps: &mut [Value]) {
    const RECORDED: &str = "⚙️ Система\n\nЧасы, язык, копия базы и цифры, которые вводятся руками.";
    const RUST: &str = "⚙️ Система\n\nЧасы, копия базы и цифры, которые вводятся руками.";
    assert_eq!(
        t(Key::SettingsCategorySystemBody, &[]),
        RUST,
        "ru.json carries the new System body"
    );
    fn replace(value: &mut Value) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(replace),
            Value::Object(object) => object.values_mut().for_each(replace),
            Value::String(text) if text.starts_with("⚙️ Система\n\n") => {
                assert_eq!(text, RECORDED, "the recorded System body is the TypeScript one");
                *text = RUST.to_owned();
            }
            _ => {}
        }
    }
    steps.iter_mut().for_each(replace);
}

/// The System menu has no 🌐 Language button in Rust (Russian only): every
/// recorded System keyboard loses it, and its other buttons carry the hash of
/// the keyboard without it, in the calls and in the updates that tap them.
fn without_language_button(steps: &mut [Value]) {
    const MENU: &str = "settings-system/";
    fn keyboards(value: &mut Value, renamed: &mut Vec<(String, String)>) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(|item| keyboards(item, renamed)),
            Value::Object(object) => {
                if let Some(Value::Array(rows)) = object.get_mut("inline_keyboard") {
                    let system = rows.iter().filter_map(Value::as_array).flatten().any(|button| {
                        button["callback_data"]
                            .as_str()
                            .is_some_and(|data| data.starts_with(MENU))
                    });
                    if system {
                        let language = rows[0].as_array_mut().unwrap().remove(1);
                        assert_eq!(
                            language["text"], "🌐 Язык",
                            "the TypeScript System menu has the language button"
                        );
                        let shape: Vec<u32> = std::iter::once(rows.len() as u32)
                            .chain(rows.iter().map(|row| row.as_array().unwrap().len() as u32))
                            .collect();
                        for (i, row) in rows.iter_mut().enumerate() {
                            for (j, button) in row.as_array_mut().unwrap().iter_mut().enumerate() {
                                let label: Vec<u32> = button["text"].as_str().unwrap().chars().map(u32::from).collect();
                                let hash = bot::menu::tiny_hash(shape.iter().copied().chain(label));
                                let data = format!("{MENU}{i:x}/{j:x}//h{hash}");
                                let old = std::mem::replace(&mut button["callback_data"], json!(data));
                                renamed.push((old.as_str().unwrap().to_owned(), data));
                            }
                        }
                    }
                }
                object.values_mut().for_each(|item| keyboards(item, renamed));
            }
            _ => {}
        }
    }
    fn rename(value: &mut Value, renamed: &[(String, String)]) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(|item| rename(item, renamed)),
            Value::Object(object) => object.values_mut().for_each(|item| rename(item, renamed)),
            Value::String(text) => {
                if let Some((_, new)) = renamed.iter().find(|(old, _)| old == text) {
                    *text = new.clone();
                }
            }
            _ => {}
        }
    }
    let mut renamed = Vec::new();
    steps.iter_mut().for_each(|step| keyboards(step, &mut renamed));
    steps.iter_mut().for_each(|step| rename(step, &renamed));
}

/// Calls of a step that fed several updates at once, grouped by the chat they
/// write to (acknowledgements by themselves): their order across chats is the
/// scheduler's, not the bot's; within a chat it is compared as recorded.
fn by_chat(calls: &[Value]) -> Vec<(String, Vec<String>)> {
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for call in calls {
        let key = if call["method"] == "answerCallbackQuery" {
            "answerCallbackQuery".to_owned()
        } else {
            call["payload"]["chat_id"].to_string()
        };
        match groups.iter_mut().find(|(known, _)| *known == key) {
            Some((_, list)) => list.push(call.to_string()),
            None => groups.push((key, vec![call.to_string()])),
        }
    }
    groups.sort_by(|a, b| a.0.cmp(&b.0));
    groups
}

fn describe_difference(index: usize, expected: &[Value], actual: &[Value]) -> String {
    let pretty = |calls: &[Value]| serde_json::to_string_pretty(calls).unwrap();
    format!(
        "step {index}: calls differ\n--- expected (golden)\n{}\n--- actual (Rust)\n{}",
        pretty(expected),
        pretty(actual)
    )
}

/// A Rust bot on a database, a pinned clock and the fake Telegram, built the
/// way harness.ts builds the TypeScript one.
pub struct Harness {
    pub bot: Bot,
    pub telegram: Rc<FakeTelegram>,
    pub clock: Rc<FixedClock>,
    pub deploy_agent: Rc<GoldenDeployAgent>,
    pub zernio: Rc<GoldenZernio>,
    pub deepseek: Rc<GoldenDeepSeek>,
    /// The HTTP client the worker loops are started with, on the golden DeepSeek.
    pub http: HttpClient,
    /// What the bot sent while it was built (`setMyCommands`).
    pub construction: Vec<Value>,
    /// The case's seed notes: what the recorder put in place outside the bot.
    pub seed: Value,
    /// Where this bot's database and `DATA_DIR` live; last, so it is removed
    /// after the bot is gone.
    _scratch: Scratch,
}

impl Harness {
    /// Must run inside a `LocalSet`.
    pub async fn new(scratch: Scratch, db: BackendDb, case_env: &Value, at: Timestamp) -> Result<Self, String> {
        let config = load_config(env(&scratch.data_dir(), case_env)).map_err(|error| error.to_string())?;
        let clock = Rc::new(FixedClock(Cell::new(at)));
        let telegram = Rc::new(FakeTelegram::new(&recorder_tmp().display().to_string(), bot_user()));
        let deploy_agent = Rc::new(GoldenDeployAgent::new(telegram.clone()));
        let zernio = Rc::new(GoldenZernio::new(telegram.clone()));
        let deepseek = Rc::new(GoldenDeepSeek::new(telegram.clone()));
        let http = HttpClient::new(deepseek.clone());
        let config = SharedConfig::new(config);
        let bot = Bot::new(BotDeps {
            db,
            clock: clock.clone(),
            config: config.clone(),
            host: Rc::new(GoldenHost::new(config, clock.clone())),
            adapters: DynAdapters(Box::new(GoldenAdapters { zernio: zernio.clone() })),
            transport: telegram.clone(),
            deploy_agent: deploy_agent.clone(),
        });
        let mut info = bot_user();
        info["can_join_groups"] = json!(true);
        info["can_read_all_group_messages"] = json!(false);
        info["supports_inline_queries"] = json!(false);
        bot.set_info(serde_json::from_value(info).unwrap());
        bot.settled().await;
        if let Some(panic) = bot.take_panic() {
            return Err(format!("a background task panicked while the bot was built: {panic}"));
        }
        let construction = telegram.take_calls();
        Ok(Self {
            bot,
            telegram,
            clock,
            deploy_agent,
            zernio,
            deepseek,
            http,
            construction,
            seed: Value::Null,
            _scratch: scratch,
        })
    }

    /// Hands these updates to the bot at once (one is an ordinary step), lets
    /// a held call go after 50 ms as the recorder did, waits for the bot to be
    /// quiet and returns what it sent.
    pub async fn feed(&self, updates: &[Value]) -> Result<Vec<Value>, String> {
        let mut handles = Vec::new();
        for update in updates {
            self.telegram.observe(update);
            let parsed: Update = serde_json::from_value(update.clone()).map_err(|error| error.to_string())?;
            let bot = self.bot.clone();
            handles.push(tokio::task::spawn_local(async move { bot.handle_update(parsed).await }));
        }
        if self.telegram.holds() {
            tokio::time::sleep(Duration::from_millis(50)).await;
            self.telegram.release();
        }
        for handle in handles {
            handle.await.map_err(|error| format!("the update panicked: {error}"))?;
        }
        self.bot.settled().await;
        Ok(self.telegram.take_calls())
    }
}

/// Runs `test` inside a fresh single-threaded runtime and `LocalSet`.
pub fn on_bot_thread<F: Future>(test: F) -> F::Output {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&runtime, test)
}

/// A directory only one test owns: `<pid>-<n>-<label>` under
/// `_trash-rust/tmp/bot-tests/`, removed when dropped.
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = repo_root()
            .join("_trash-rust/tmp/bot-tests")
            .join(format!("{}-{n}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(path.join("data")).unwrap();
        Self(path)
    }

    /// The bot's `DATA_DIR`.
    pub fn data_dir(&self) -> PathBuf {
        self.0.join("data")
    }

    /// A seed database (`<area>/<file>` of the shared seeds), copied here
    /// where the Rust bot may write to it.
    pub fn seed_database(&self, area: &str, file: &str) -> BackendDb {
        let db_path = self.0.join("seed.db");
        std::fs::copy(seeds_dir().join(area).join(file), &db_path).unwrap();
        BackendDb::open(&db_path).unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Replays one case; `Err` carries the first difference.
pub fn replay(area: &str, case: &str) -> Result<(), String> {
    replay_steps(area, case, usize::MAX)
}

/// Replays the first `count` steps of a case.
pub fn replay_steps(area: &str, case: &str, count: usize) -> Result<(), String> {
    on_bot_thread(replay_case(area, case, count))
}

async fn replay_case(area: &str, case: &str, count: usize) -> Result<(), String> {
    let seeds = seeds_dir().join(area);
    let meta = read_json(&seeds.join(format!("{case}.meta.json")));
    let golden = read_json(&goldens_dir().join(area).join(format!("{case}.json")));
    let mut expected_steps = golden["steps"].as_array().cloned().unwrap_or_default();
    deliberate_deviations(area, case, &mut expected_steps);
    let step_meta = meta["steps"].as_array().cloned().unwrap_or_default();
    assert_eq!(
        step_meta.len(),
        expected_steps.len(),
        "{area}/{case}: meta and golden disagree on the steps"
    );

    let scratch = Scratch::new(&format!("{area}-{case}"));
    let db = scratch.seed_database(area, &format!("{case}.db"));
    let first_at = step_meta.first().and_then(|step| step["at"].as_str()).unwrap_or(NOW);
    let mut harness = Harness::new(scratch, db, &meta["env"], instant(first_at)).await?;
    harness.seed = golden["seed"].clone();
    harness.deploy_agent.script(&golden["seed"]);
    harness.zernio.script(&golden["seed"], &harness.bot.deps().config);
    harness.deepseek.script(&golden["seed"]);
    // The Story-card waiter outlives the tap that started it; with the
    // recorder's shortened polls (`fastStoryWait`) a step lasts until it ends.
    let fast_story_wait = meta["fastStoryWait"] == json!(true);
    bot::screens::post::set_story_card_poll(Duration::from_millis(if fast_story_wait { 1 } else { 1000 }));

    for (index, (expected, meta)) in expected_steps.iter().zip(&step_meta).enumerate().take(count) {
        let at = instant(meta["at"].as_str().unwrap_or(NOW));
        harness.clock.0.set(at);
        harness.telegram.prepare(meta, at.as_second());
        if let Some(reseed_file) = meta["reseed"].as_str() {
            reseed(db::unsafe_db(&harness.bot.deps().db), &seeds.join(reseed_file));
        }
        let step = async {
            let actual = match (&expected["update"], expected["trigger"].as_str()) {
                (Value::Null, Some("createBot")) if index == 0 => harness.construction.clone(),
                (Value::Null, Some(name)) => match triggers::find(name) {
                    Some(trigger) => trigger(&harness).await?,
                    None => {
                        return Err(format!(
                            "step {index}: trigger {name:?} has no row in support/triggers.rs"
                        ));
                    }
                },
                (Value::Array(updates), _) => harness.feed(updates).await?,
                (update, _) => harness.feed(std::slice::from_ref(update)).await?,
            };
            if fast_story_wait {
                bot::screens::post::story_card_waiters_settled().await;
                return Ok([actual, harness.telegram.take_calls()].concat());
            }
            Ok(actual)
        };
        // A background task that panicked or never ends would otherwise keep
        // the step waiting for quiet forever.
        let actual = match tokio::time::timeout(STEP_TIMEOUT, step).await {
            Ok(actual) => actual?,
            Err(_) => {
                return Err(format!(
                    "{area}/{case} step {index}: no quiet after {}s ({})",
                    STEP_TIMEOUT.as_secs(),
                    describe_step(expected)
                ));
            }
        };
        if let Some(panic) = harness.bot.take_panic() {
            return Err(format!(
                "{area}/{case} step {index}: a background task panicked ({}): {panic}",
                describe_step(expected)
            ));
        }
        let expected_calls = expected["calls"].as_array().cloned().unwrap_or_default();
        let same = if expected["update"].is_array() {
            by_chat(&expected_calls) == by_chat(&actual)
        } else {
            expected_calls
                .iter()
                .map(Value::to_string)
                .eq(actual.iter().map(Value::to_string))
        };
        if !same {
            return Err(describe_difference(index, &expected_calls, &actual));
        }
        let effects = database_effects(db::unsafe_db(&harness.bot.deps().db), &expected["db"]);
        if effects != expected["db"] {
            return Err(format!(
                "step {index}: database effects differ\n--- expected (golden)\n{}\n--- actual (Rust)\n{}",
                serde_json::to_string_pretty(&expected["db"]).unwrap(),
                serde_json::to_string_pretty(&effects).unwrap()
            ));
        }
    }
    Ok(())
}

/// What the step's watched queries (`h.watch` in the recorder) return on the
/// Rust bot's database, as the recorder writes them: each row an object with
/// sorted keys. `Null` when the step watches nothing.
fn database_effects(sqlite: &db::rusqlite::Connection, watched: &Value) -> Value {
    use db::rusqlite::types::ValueRef;
    let Some(watched) = watched.as_array() else {
        return Value::Null;
    };
    let effects = watched.iter().map(|effect| {
        let sql = effect["sql"].as_str().unwrap();
        let mut statement = sqlite.prepare(sql).unwrap_or_else(|error| panic!("{sql}: {error}"));
        let columns: Vec<String> = statement.column_names().map(str::to_owned).collect();
        let rows: Vec<Value> = statement
            .query_map([], |row| {
                let mut object = serde_json::Map::new();
                for (index, column) in columns.iter().enumerate() {
                    let value = match row.get_ref(index)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(value) => json!(value),
                        ValueRef::Real(value) => json!(value),
                        ValueRef::Text(text) => json!(String::from_utf8_lossy(text)),
                        ValueRef::Blob(_) => panic!("{sql}: a watched query returns a blob"),
                    };
                    object.insert(column.clone(), value);
                }
                Ok(Value::Object(object))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        json!({"sql": sql, "rows": telegram::sort_keys(&Value::Array(rows), &recorder_tmp().display().to_string())})
    });
    Value::Array(effects.collect())
}

/// How long one step may take before the case fails as hung.
const STEP_TIMEOUT: Duration = Duration::from_secs(60);

/// A step as a failure names it: its trigger, or the update it fed.
fn describe_step(step: &Value) -> String {
    match step["trigger"].as_str() {
        Some(trigger) => format!("trigger {trigger}"),
        None => {
            let updates = match &step["update"] {
                Value::Array(updates) => updates.iter().collect(),
                update => vec![update],
            };
            let ids: Vec<String> = updates.iter().map(|update| update["update_id"].to_string()).collect();
            format!("update {}", ids.join(", "))
        }
    }
}

/// What one area's run found.
pub struct Report {
    pub passed: Vec<String>,
    pub not_ported: Vec<(String, Vec<&'static str>)>,
    pub failed: Vec<(String, String)>,
}

/// Replays every case of a golden directory that is ported, and lists the
/// rest with the areas they wait for.
pub fn run_area(area: &str) -> Report {
    ensure_seeds();
    foundation::logger::configure_logging(foundation::logger::LogLevel::Error);
    let mut report = Report {
        passed: Vec::new(),
        not_ported: Vec::new(),
        failed: Vec::new(),
    };
    for case in cases(area) {
        let pending = pending::pending_for(area, &case);
        if !pending.is_empty() {
            report.not_ported.push((case, pending));
            continue;
        }
        match replay(area, &case) {
            Ok(()) => report.passed.push(case),
            Err(error) => report.failed.push((case, error)),
        }
    }
    for case in &report.passed {
        println!("PASS        {area}/{case}");
    }
    for (case, pending) in &report.not_ported {
        println!("NOT PORTED  {area}/{case} (waits for: {})", pending.join(", "));
    }
    for (case, error) in &report.failed {
        println!("FAIL        {area}/{case}\n{error}");
    }
    report
}

/// The registrations of a bot built the way the harness builds one.
pub fn missing_registrations() -> Vec<(&'static str, String)> {
    on_bot_thread(async {
        let db = BackendDb::open(":memory:").unwrap();
        let harness = Harness::new(Scratch::new("registry"), db, &json!({}), instant(NOW))
            .await
            .unwrap();
        harness.bot.registry().missing()
    })
}
