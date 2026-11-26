//! Equivalence with the recorded Story-card worker: every scenario in
//! `worker_scenarios.json` ran through the real worker and sharp
//! renderer before the cutover (`worker_scenarios.golden.json`) and runs
//! through `story_render`, each on its own fresh database under the same fixed clock,
//! with the Studio post services queueing and scheduling the cards on both
//! sides. Every step's result, every table's rows and the card files left
//! behind must come out identical.

#[path = "../../domain/tests/support/mod.rs"]
mod support;

use std::cell::Cell;
use std::path::{Path, PathBuf};

use content::message::DraftMessage;
use db::rusqlite::Connection;
use db::{BackendDb, unsafe_db};
use domain::application::ports::StoryPublishMode;
use domain::notifications::ReminderJobs;
use domain::observability::capabilities::CapabilityReadiness;
use domain::publishing::Publishing;
use domain::publishing::boundaries::{
    AuthCircuit, AuthCircuitState, Boundaries, Jitter, UsageMeter, VideoCompletion, WorkerBell,
};
use domain::story_cards::StoryCardStore;
use domain::studio::Studio;
use domain::studio::boundaries::{
    ChannelConnectLinks, ConnectPlatform, ConnectStart, MetaOauthPlatform, StoryDerivatives, StudioBoundaries,
};
use domain::studio::services::posts::{DraftConfiguration, PostScheduleInput, PostService};
use foundation::config::{Config, SharedConfig};
use foundation::logger::{LogLevel, configure_logging};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use story_render::{recover_story_card_jobs, run_story_card_cycle};
use support::{FixedClock, arg, differences, dump, instant, out, resolve};

fn spec_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/worker_scenarios.json")
}

fn files_dir() -> PathBuf {
    support::repo_root().join("_trash-rust/tmp/story-worker-scenarios")
}

/// The boundaries no scenario reaches: nothing is published, retried or
/// connected, and no draft carries media.
struct Unreached;

impl Jitter for Unreached {
    fn unit(&self) -> f64 {
        panic!("no scenario retries a publication")
    }
}

impl WorkerBell for Unreached {
    fn ring_publish(&self) {}
    fn ring_publish_after(&self, _: u64) {}
}

impl AuthCircuit for Unreached {
    fn record_failure(&self, _: &Connection, _: &str) -> domain::Result<()> {
        panic!("no scenario settles a publish attempt")
    }
    fn record_success(&self, _: &Connection, _: &str) -> domain::Result<()> {
        panic!("no scenario settles a publish attempt")
    }
    fn states(&self, _: &Connection) -> domain::Result<Vec<AuthCircuitState>> {
        Ok(Vec::new())
    }
}

/// Usage rows are not compared: the recorded worker timed renders on its fixed clock.
impl UsageMeter for Unreached {
    fn record(&self, _: &Connection, _: &str, _: bool, _: u64) {}
}

impl VideoCompletion for Unreached {
    fn record_if_final(&self, _: &Connection, _: i64) -> domain::Result<()> {
        panic!("no scenario has a video")
    }
}

impl StoryDerivatives for Unreached {
    fn ensure(&self, local_path: &str, _: bool, _: i64) {
        panic!("no scenario's draft carries media ({local_path})")
    }
}

impl ChannelConnectLinks for Unreached {
    fn meta_oauth_connect_url(&self, _: &Config, _: MetaOauthPlatform, _: content::Locale) -> domain::Result<String> {
        panic!("no scenario connects a channel")
    }
    fn meta_oauth_connect_path(&self, _: &Config, _: MetaOauthPlatform, _: content::Locale) -> domain::Result<String> {
        panic!("no scenario connects a channel")
    }
    fn x_oauth_connect_url(&self, _: &Config) -> domain::Result<String> {
        panic!("no scenario connects a channel")
    }
    fn x_oauth_connect_path(&self, _: &Config) -> domain::Result<String> {
        panic!("no scenario connects a channel")
    }
    fn start_connect(
        &self,
        _: &Config,
        _: ConnectPlatform,
        _: content::Locale,
        _: jiff::Timestamp,
    ) -> domain::Result<ConnectStart> {
        panic!("no scenario connects a channel")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleArgs {
    ru_at: Option<String>,
    en_at: Option<String>,
}

fn message(value: &Value) -> DraftMessage {
    let records =
        |key: &str| -> Vec<Map<String, Value>> { serde_json::from_value(value[key].clone()).unwrap_or_default() };
    DraftMessage {
        text: value["text"].as_str().unwrap().into(),
        text_en: value["textEn"].as_str().map(str::to_owned),
        text_en_approved: None,
        media: records("media"),
        entities: records("entities"),
    }
}

async fn call(studio: Studio<'_>, name: &str, args: &[Value]) -> domain::Result<Value> {
    let posts = PostService::new(studio);
    let int = |index| arg::<i64>(args, index);
    Ok(match name {
        "posts.create" => out(posts.create(
            int(0),
            &message(&args[1]),
            arg::<Option<DraftConfiguration>>(args, 2).as_ref(),
        )?),
        "posts.setStoryPublishMode" => {
            let mode = match arg::<String>(args, 2).as_str() {
                "all" => StoryPublishMode::All,
                "site_only" => StoryPublishMode::SiteOnly,
                other => panic!("unknown Story publish mode {other}"),
            };
            out(posts.set_story_publish_mode(int(0), int(1), mode)?)
        }
        "posts.schedule" => {
            let input: ScheduleArgs = arg(args, 2);
            let at = |value: Option<String>| value.map(|value| instant(&json!(value)));
            out(posts.schedule(
                int(0),
                int(1),
                &PostScheduleInput {
                    ru_at: at(input.ru_at),
                    en_at: at(input.en_at),
                    allow_past: false,
                    immediate_locale: None,
                },
            )?)
        }
        "storyCards.forDraft" => out(studio
            .publishing
            .boundaries
            .story_cards
            .for_draft(studio.publishing.sqlite, int(0))?),
        "worker.recover" => out(recover_story_card_jobs(
            studio.publishing.sqlite,
            studio.publishing.clock,
        )?),
        "worker.cycle" => {
            let cycle = run_story_card_cycle(studio).await?;
            let error = cycle
                .error
                .as_deref()
                .map(|error| error.split(": ").next().unwrap_or_default().to_owned());
            json!({"claimed": cycle.claimed, "state": cycle.state, "error": error})
        }
        other => panic!("unknown call {other}"),
    })
}

async fn run(spec: &Value, scenario: &Value) -> Value {
    let backend_db = BackendDb::open(":memory:").unwrap();
    let sqlite = unsafe_db(&backend_db);
    let clock = FixedClock(Cell::new(instant(&spec["clock"])));
    let mut env: Map<String, Value> = spec["config"].as_object().unwrap().clone();
    if let Some(overrides) = scenario.get("config").and_then(Value::as_object) {
        env.extend(overrides.clone());
    }
    let config = foundation::config::load_config(
        env.iter()
            .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned())),
    )
    .unwrap();
    let readiness = CapabilityReadiness::new(SharedConfig::new(config.clone()));
    let cards = StoryCardStore::new(&clock);
    let reminders = ReminderJobs::new(&clock);
    let studio = Studio::new(
        Publishing::new(
            sqlite,
            &clock,
            Boundaries {
                jitter: &Unreached,
                bell: &Unreached,
                auth_circuit: &Unreached,
                usage: &Unreached,
                story_cards: &cards,
                video_completion: &Unreached,
            },
        ),
        &config,
        StudioBoundaries {
            reminders: &reminders,
            story_derivatives: &Unreached,
            readiness: &readiness,
            connect_links: &Unreached,
        },
    );
    let files = files_dir();
    let _ = std::fs::remove_dir_all(&files);
    std::fs::create_dir_all(&files).unwrap();
    let ignored: Vec<String> = serde_json::from_value(spec["ignoredTables"].clone()).unwrap();
    for sql in spec["setup"].as_array().unwrap() {
        sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    let mut vars = Map::new();
    let mut results = Vec::new();
    for step in scenario["steps"].as_array().unwrap() {
        if let Some(at) = step.get("clock") {
            clock.0.set(instant(at));
        } else if let Some(sql) = step.get("sql") {
            sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
        } else {
            let name = step["call"].as_str().expect("step without clock, sql or call");
            let args = resolve(step.get("args").unwrap_or(&json!([])), &vars);
            let result = match call(studio, name, args.as_array().unwrap()).await {
                Ok(value) => {
                    if let Some(bind) = step.get("bind").and_then(Value::as_str) {
                        vars.insert(bind.into(), value.clone());
                    }
                    value
                }
                Err(error) => json!({ "error": error.to_string() }),
            };
            results.push(json!({ "call": name, "result": out(result) }));
        }
    }
    for sql in spec["beforeDump"].as_array().unwrap() {
        sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    let mut existing: Vec<String> = std::fs::read_dir(&config.story_card_dir)
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    existing.sort();
    out(json!({ "name": scenario["name"], "results": results, "files": existing, "tables": dump(sqlite, &ignored) }))
}

fn spec() -> Value {
    let root = support::repo_root();
    let text = std::fs::read_to_string(spec_path())
        .unwrap()
        .replace("{FILES}", &files_dir().to_string_lossy())
        .replace(
            "{ASSETS}",
            &root.join("crates/story_render/assets/story-card").to_string_lossy(),
        );
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn story_card_worker_matches_typescript() {
    configure_logging(LogLevel::Error);
    let spec = spec();
    let typescript = support::golden(&spec_path());
    let expected = typescript["scenarios"].as_array().unwrap();
    let mut actual = Vec::new();
    for scenario in spec["scenarios"].as_array().unwrap() {
        actual.push(run(&spec, scenario).await);
    }
    let mut failures = differences(expected, &actual);
    for (left, right) in expected.iter().zip(&actual) {
        if left["files"] != right["files"] {
            failures.push(format!(
                "{}, files left:\n  ts:   {}\n  rust: {}",
                left["name"], left["files"], right["files"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
