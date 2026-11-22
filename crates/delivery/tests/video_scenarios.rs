//! Video worker equivalence with TypeScript: every scenario in
//! `video_scenarios.json` ran through the real TypeScript modules before the
//! cutover (`video_scenarios.golden.json`) and runs through this crate, each on a fresh
//! database under the same clock, with the same canned platform answers;
//! every step's result, every request and every table must come out identical.

mod support;

use delivery::video_retention::{post_draft_references_asset, prune_expired_videos};
use delivery::video_worker::{recover_video_locks, run_video_cycle};
use futures_util::FutureExt as _;
use futures_util::future::LocalBoxFuture;
use serde_json::{Value, json};
use support::Scenario;

fn call<'a>(scenario: &'a Scenario, name: &'a str, args: Vec<Value>) -> LocalBoxFuture<'a, Result<Value, String>> {
    async move {
        let delivery = scenario.delivery();
        let failed = |error: delivery::Error| error.to_string();
        Ok(match name {
            "cycle" => json!(run_video_cycle(&delivery).await.map_err(failed)?),
            "recover" => json!(recover_video_locks(&delivery).map_err(failed)?),
            "prune" => {
                prune_expired_videos(&delivery).map_err(failed)?;
                Value::Null
            }
            "references" => {
                json!(post_draft_references_asset(scenario.sqlite(), args[0].as_i64().unwrap()).map_err(failed)?)
            }
            "authFailure" => {
                let target = args[0].as_str().unwrap();
                delivery
                    .boundaries
                    .auth_circuit
                    .record_failure(scenario.sqlite(), target)
                    .map_err(failed)?;
                Value::Null
            }
            "asset" => {
                // The asset row names its file by absolute path, which only the run knows.
                let (id, file, kind, sha256) = (
                    args[0].as_i64().unwrap(),
                    args[1].as_str().unwrap(),
                    args[2].as_str().unwrap(),
                    args[3].as_str().unwrap(),
                );
                let local_path = scenario.data.join(file);
                scenario
                    .sqlite()
                    .execute(
                        "INSERT INTO studio_media_assets (id, actor_id, kind, mime_type, filename, local_path, byte_size, sha256, source, created_at) VALUES (?, 42, ?, ?, ?, ?, 32, ?, 'upload', '2026-03-01T09:00:00.000Z')",
                        db::rusqlite::params![
                            id,
                            kind,
                            if kind == "video" { "video/mp4" } else { "image/jpeg" },
                            file.rsplit('/').next().unwrap(),
                            local_path.to_string_lossy(),
                            sha256
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                Value::Null
            }
            "exists" => Value::Array(
                args.iter()
                    .map(|file| scenario.data.join(file.as_str().unwrap()).exists().into())
                    .collect(),
            ),
            other => panic!("unknown call {other}"),
        })
    }
    .boxed_local()
}

#[test]
fn video_worker_matches_typescript() {
    support::compare("video_scenarios.json", call, "video");
}

/// The shared spec with these scenarios instead of its own: Rust-only cases
/// for what TypeScript does differently on purpose.
/// `Null` keeps the spec's own scenarios.
fn rust_only(scenarios: Value) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/video_scenarios.json");
    let mut spec: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    if !scenarios.is_null() {
        spec["scenarios"] = scenarios;
    }
    spec
}

fn rows<'a>(outcome: &'a Value, table: &str) -> Vec<&'a str> {
    outcome["tables"][table]
        .as_array()
        .map(|rows| rows.iter().map(|row| row.as_str().unwrap()).collect())
        .unwrap_or_default()
}

/// Deliberate deviation: after a YouTube upload lost its answer, TypeScript
/// still ran the due publish job, which failed with "upload has not completed
/// yet" and wrote the target back to `scheduled` — the state an operator
/// retries into a second upload. Rust leaves the target held for verification
/// and completes the publish job without touching it.
#[test]
fn a_publish_job_leaves_a_target_held_for_verification_alone() {
    let base = rust_only(Value::Null);
    let mut scenario = base["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|scenario| scenario["name"] == "youtube upload loses its answer twice and waits for verification")
        .unwrap()
        .clone();
    // The same draft with its publish job due in the same cycle.
    for step in scenario["steps"].as_array_mut().unwrap() {
        if let Some(sql) = step["sql"].as_str()
            && sql.starts_with("INSERT INTO video_jobs")
            && sql.contains("'publish'")
        {
            step["sql"] = sql
                .replace("'2026-03-01T11:00:00.000Z'", "'2026-03-01T09:59:30.000Z'")
                .into();
        }
    }
    let spec = rust_only(json!([scenario]));
    let outcome = &support::rust_side(&spec, call, &format!("rust-video-only-{}", std::process::id()))[0];
    let jobs = rows(outcome, "video_jobs");
    assert!(jobs[0].contains("text:'verification_required'"), "{jobs:?}");
    assert!(
        jobs[1].contains("text:'publish'") && jobs[1].contains("text:'completed'"),
        "{jobs:?}"
    );
    let targets = rows(outcome, "video_targets");
    assert!(targets[0].contains("text:'verification_required'"), "{targets:?}");
    assert!(
        !targets[0].contains("YouTube upload has not completed yet"),
        "{targets:?}"
    );
    assert_eq!(outcome["unusedResponses"], 0);
    assert_eq!(outcome["requests"].as_array().unwrap().len(), 5);
}
