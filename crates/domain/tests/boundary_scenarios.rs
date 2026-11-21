//! Equivalence with TypeScript for the stores behind the Studio's
//! boundaries: the Story-card store, publication reminders, the credential
//! breaker, the readiness report, the video completion notice and runtime
//! usage. Every scenario in `boundary_scenarios.json` runs through the real
//! TypeScript modules (`scripts/rust/boundary-scenarios.ts`) and through their
//! Rust ports, each on its own fresh database under the same fixed clock;
//! every step's result, every table's rows and the files left in the scratch
//! directory must come out identical.

mod support;

use std::cell::Cell;
use std::path::{Path, PathBuf};

use db::{BackendDb, unsafe_db};
use domain::application::ports::StoryPublishMode;
use domain::delivery::VideoCompletionNotice;
use domain::notifications::ReminderJobs;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::observability::capabilities::capability_report;
use domain::observability::usage::UsageRecorder;
use domain::publishing::boundaries::{AuthCircuit, StoryCards, UsageMeter, VideoCompletion};
use domain::story_cards::{StoryCardStore, story_card_copy};
use domain::studio::boundaries::{Reminder, ReminderPolicy, Reminders};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use support::{FixedClock, arg, differences, dump, instant, out, resolve};

fn spec_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/boundary_scenarios.json")
}

fn files_dir() -> PathBuf {
    support::repo_root().join("_trash-rust/tmp/boundary-scenarios")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReminderArgs {
    actor_id: i64,
    #[serde(rename = "ref")]
    publication_ref: String,
    kind: String,
    publish_at: String,
    title: String,
    targets: Vec<String>,
    reminders: PolicyArgs,
}

#[derive(Deserialize)]
struct PolicyArgs {
    enabled: bool,
    minutes: i64,
}

struct World<'a> {
    sqlite: &'a db::rusqlite::Connection,
    config: &'a foundation::config::Config,
    cards: StoryCardStore<&'a FixedClock>,
    reminders: ReminderJobs<&'a FixedClock>,
    breaker: AuthCircuitBreaker<&'a FixedClock>,
    completion: VideoCompletionNotice<&'a FixedClock>,
    usage: &'a UsageRecorder<&'a FixedClock>,
}

fn call(world: &World, name: &str, args: &[Value]) -> domain::Result<Value> {
    let sqlite = world.sqlite;
    let int = |index: usize| arg::<i64>(args, index);
    let text = |index: usize| arg::<String>(args, index);
    Ok(match name {
        "storyCards.copy" => {
            let copy = story_card_copy(&text(0));
            json!({"headline": copy.headline, "emoji": copy.emoji})
        }
        "storyCards.queue" => out(world.cards.queue(sqlite, int(0))?),
        "storyCards.forDraft" => out(world.cards.for_draft(sqlite, int(0))?),
        "storyCards.readyMedia" => out(world
            .cards
            .ready_media(sqlite, int(0))?
            .map(|media| json!({"ru": media.ru, "en": media.en}))),
        "storyCards.setPublishMode" => {
            let mode = match text(1).as_str() {
                "all" => StoryPublishMode::All,
                "site_only" => StoryPublishMode::SiteOnly,
                other => panic!("unknown Story publish mode {other}"),
            };
            out(world.cards.set_publish_mode(sqlite, int(0), mode)?)
        }
        "storyCards.discard" => out(world.cards.discard(sqlite, int(0))?),
        "reminders.schedule" => {
            let input: ReminderArgs = arg(args, 0);
            out(world.reminders.schedule(
                sqlite,
                &Reminder {
                    actor_id: input.actor_id,
                    publication_ref: &input.publication_ref,
                    kind: &input.kind,
                    publish_at: instant(&json!(input.publish_at)),
                    title: &input.title,
                    targets: &input.targets,
                    reminders: ReminderPolicy {
                        enabled: input.reminders.enabled,
                        minutes: input.reminders.minutes,
                    },
                },
            )?)
        }
        "reminders.cancel" => out(world.reminders.cancel(sqlite, &text(0))?),
        "authCircuit.recordFailure" => out(world.breaker.record_failure(sqlite, &text(0))?),
        "authCircuit.recordSuccess" => out(world.breaker.record_success(sqlite, &text(0))?),
        "authCircuit.states" => out(world.breaker.states(sqlite)?),
        "readiness.report" => out(capability_report(world.config, sqlite)?),
        "videoCompletion.recordIfFinal" => out(world.completion.record_if_final(sqlite, int(0))?),
        "usage.record" => {
            world.usage.record(sqlite, &text(0), arg(args, 1), arg(args, 2));
            Value::Null
        }
        "usage.flush" => {
            world.usage.flush(sqlite);
            Value::Null
        }
        other => panic!("unknown call {other}"),
    })
}

fn run(spec: &Value, scenario: &Value) -> Value {
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
    let usage = UsageRecorder::new(&clock);
    let world = World {
        sqlite,
        config: &config,
        cards: StoryCardStore::new(&clock),
        reminders: ReminderJobs::new(&clock),
        breaker: AuthCircuitBreaker::new(&clock),
        completion: VideoCompletionNotice::new(&clock),
        usage: &usage,
    };
    let files = files_dir();
    let _ = std::fs::remove_dir_all(&files);
    std::fs::create_dir_all(&files).unwrap();
    let ignored: Vec<String> = serde_json::from_value(spec["ignoredTables"].clone()).unwrap();
    let mut vars = Map::new();
    let mut results = Vec::new();
    for sql in spec["setup"].as_array().unwrap() {
        sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    for step in scenario["steps"].as_array().unwrap() {
        if let Some(at) = step.get("clock") {
            clock.0.set(instant(at));
        } else if let Some(sql) = step.get("sql") {
            sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
        } else if let Some(file) = step.get("file") {
            std::fs::write(file.as_str().unwrap(), "card").unwrap();
        } else {
            let name = step["call"].as_str().expect("step without clock, sql, file or call");
            let args = resolve(step.get("args").unwrap_or(&json!([])), &vars);
            let result = match call(&world, name, args.as_array().unwrap()) {
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
    let mut existing: Vec<String> = std::fs::read_dir(&files)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    existing.sort();
    out(json!({ "name": scenario["name"], "results": results, "files": existing, "tables": dump(sqlite, &ignored) }))
}

fn spec() -> Value {
    let text = std::fs::read_to_string(spec_path())
        .unwrap()
        .replace("{FILES}", &files_dir().to_string_lossy());
    serde_json::from_str(&text).unwrap()
}

#[test]
fn boundary_stores_match_typescript() {
    let spec = spec();
    let typescript = support::typescript("scripts/rust/boundary-scenarios.ts", &spec_path());
    let expected = typescript["scenarios"].as_array().unwrap();
    let actual: Vec<Value> = spec["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .map(|scenario| run(&spec, scenario))
        .collect();
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
