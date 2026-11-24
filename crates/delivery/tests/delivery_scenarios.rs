//! Delivery equivalence with TypeScript: every scenario in
//! `delivery_scenarios.json` ran through the real TypeScript modules before
//! the cutover (`delivery_scenarios.golden.json`) and runs through this crate over the
//! adapters, each on a fresh database under the same clock, with the same
//! canned platform answers; every step's result, every request and every
//! table must come out identical.

mod support;

use std::rc::Rc;

use adapters::StoriesClient;
use adapters::social_ports::MediaPreparation;
use adapters::telegram_stories::{StoryError, StoryRequest};
use delivery::external_edits::{PublishedTargetEdit, edit_published_targets};
use delivery::external_removals::{
    RemovalOptions, attempt_published_target_removals, settle_published_target_removals,
};
use delivery::maintenance::{prune_operational_history, with_maintenance_lock};
use delivery::media_prepare::prune_media_cache;
use delivery::publish_workflow::{delivery_ports, run_delivery_publish_cycle};
use delivery::reconciliation::run_publication_reconciliation;
use delivery::story_derivatives::DeliveryMedia;
use domain::application::ports::{DomainEventInput, Severity};
use domain::repositories::{record_event, transaction};
use foundation::config::SharedConfig;
use futures_util::FutureExt as _;
use futures_util::future::LocalBoxFuture;
use runtime::http::Fut;
use serde_json::{Value, json};
use support::Scenario;

/// No scenario publishes a Telegram Story.
struct NoStories;

impl StoriesClient for NoStories {
    fn send_story<'a>(&'a self, _: &'a StoryRequest) -> Fut<'a, Result<i64, StoryError>> {
        panic!("a scenario reached the Stories client")
    }
}

fn media(scenario: &Scenario) -> Rc<dyn MediaPreparation> {
    Rc::new(DeliveryMedia::new(
        scenario.client.clone(),
        SharedConfig::new((*scenario.config()).clone()),
        Rc::new(scenario.clock.clone()),
    ))
}

fn call<'a>(scenario: &'a Scenario, name: &'a str, args: Vec<Value>) -> LocalBoxFuture<'a, Result<Value, String>> {
    async move {
        let delivery = scenario.delivery();
        let failed = |error: delivery::Error| error.to_string();
        Ok(match name {
            "publishCycle" => {
                let ports = delivery_ports(&delivery, media(scenario), Rc::new(NoStories)).map_err(failed)?;
                json!(run_delivery_publish_cycle(&delivery, &ports).await.map_err(failed)?)
            }
            "recoverStale" => {
                let seconds = args.first().and_then(Value::as_u64).unwrap_or(900);
                json!(
                    delivery
                        .publishing()
                        .recover_stale_publish_jobs(seconds)
                        .map_err(failed)?
                )
            }
            "reconcile" => json!(run_publication_reconciliation(&delivery).await.map_err(failed)?),
            "editTargets" => {
                let edit: PublishedTargetEdit = serde_json::from_value(args[0].clone()).unwrap();
                json!(edit_published_targets(&delivery, &edit).await.map_err(failed)?)
            }
            "removeTargets" => {
                // The caller's shape: the remote removals first, then their
                // settlement inside the transaction that journals it.
                let options: RemovalOptions = serde_json::from_value(args[0].clone()).unwrap();
                let attempts = attempt_published_target_removals(&delivery, &options)
                    .await
                    .map_err(failed)?;
                let sqlite = delivery.sqlite();
                let results = transaction(sqlite, || {
                    let results = settle_published_target_removals(sqlite, &attempts, &delivery.now())?;
                    record_event(
                        sqlite,
                        delivery.clock(),
                        &DomainEventInput {
                            publication_ref: Some(options.publication_key.clone()),
                            event_type: "operations.removal".into(),
                            severity: Severity::Info,
                            target: None,
                            message: "removed".into(),
                            details: Some(json!({"results": results}).as_object().unwrap().clone()),
                            cooldown_seconds: None,
                        },
                    )?;
                    Ok(results)
                })
                .map_err(failed)?;
                json!(results)
            }
            "maintenance" => json!(
                with_maintenance_lock(delivery.sqlite(), delivery.clock(), || prune_operational_history(
                    delivery.sqlite(),
                    delivery.clock()
                ))
                .map_err(failed)?
            ),
            "pruneMediaCache" => json!(prune_media_cache(delivery.config(), delivery.now_ms()).await),
            "ensureStory" => {
                let media = DeliveryMedia::new(
                    scenario.client.clone(),
                    SharedConfig::new((*scenario.config()).clone()),
                    Rc::new(scenario.clock.clone()),
                );
                let label = json!({"source": "scenario"}).as_object().unwrap().clone();
                let force = args.get(2).and_then(Value::as_bool).unwrap_or(false);
                json!(
                    media
                        .ensure_story_derivative(
                            scenario.config(),
                            args[0].as_str().unwrap(),
                            args[1].as_bool().unwrap(),
                            label,
                            force
                        )
                        .await?
                )
            }
            "preparedStory" => {
                let item = args[0].as_object().unwrap().clone();
                let config = scenario.config();
                json!(
                    media(scenario)
                        .await_prepared_story_media(&config, &item)
                        .await
                        .map_err(|error| error.to_string())?
                )
            }
            "files" => support::files(&scenario.data),
            other => panic!("unknown call {other}"),
        })
    }
    .boxed_local()
}

#[test]
fn delivery_matches_typescript() {
    support::compare("delivery_scenarios.json", call, "delivery");
}

/// The shared spec with these scenarios instead of its own: Rust-only cases
/// for what TypeScript does differently on purpose or cannot be driven to.
fn rust_only(scenarios: Value) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/delivery_scenarios.json");
    let mut spec: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    spec["scenarios"] = scenarios;
    spec
}

fn rows<'a>(outcome: &'a Value, table: &str) -> Vec<&'a str> {
    outcome["tables"][table]
        .as_array()
        .map(|rows| rows.iter().map(|row| row.as_str().unwrap()).collect())
        .unwrap_or_default()
}

const DRAFT: &str = "INSERT INTO drafts (id, actor_id, status, targets_json, post_id, created_at, updated_at) VALUES (1, 42, 'publishing', '{\"discord\":true,\"x\":true,\"telegram\":true}', 12, '2026-03-01T10:00:00.000Z', '2026-03-01T10:00:00.000Z')";

fn job(id: i64, target: &str, payload: &Value) -> Vec<Value> {
    vec![
        json!({"sql": format!(
            "INSERT INTO publish_jobs (job_id, publication_key, target, status, payload_json, attempt_count, created_at, updated_at) VALUES ({id}, 'post:12', '{target}', 'queued', '{}', 0, '2026-03-01T10:00:00.000Z', '2026-03-01T10:00:00.000Z')",
            payload.to_string().replace('\'', "''")
        )}),
        json!({"sql": format!(
            "INSERT INTO publication_targets (publication_key, target, status, updated_at) VALUES ('post:12', '{target}', 'queued', '2026-03-01T10:00:00.000Z')"
        )}),
    ]
}

fn ok(body: Value) -> Value {
    json!({"status": 200, "headers": [["content-type", "application/json"]], "body": body.to_string()})
}

/// Deliberate deviation (a second post is worse than an unclear status): a
/// split Discord post refused on its second message comes back as a partial
/// publication, and the retry sends only what is missing.
#[test]
fn discord_split_post_resumes_without_reposting() {
    let text = format!(
        "{}\n\n{}",
        "Paragraph one is here. ".repeat(80),
        "Second part. ".repeat(40)
    );
    let mut steps = vec![json!({"sql": DRAFT})];
    steps.extend(job(1, "discord", &json!({"text": text, "locale": "en"})));
    steps.extend([
        json!({"call": "publishCycle"}),
        json!({"clock": "2026-03-01T10:20:00.000Z"}),
        json!({"call": "publishCycle"}),
    ]);
    let refused = json!({"status": 429, "headers": [["content-type", "application/json"], ["retry-after", "2"]], "body": "{\"message\":\"You are being rate limited.\"}"});
    let spec = rust_only(json!([{
        "name": "discord split resume",
        "responses": [
            ok(json!({"id": "d1", "channel_id": "555"})), {"status": 200, "body": "{}"},
            refused,
            ok(json!({"id": "d2", "channel_id": "555"})), {"status": 200, "body": "{}"},
            ok(json!({"id": "d1", "channel_id": "555"})),
        ],
        "steps": steps,
    }]));
    let outcome = &support::rust_side(&spec, call, &format!("rust-only-{}", std::process::id()))[0];
    assert_eq!(outcome["unusedResponses"], 0);
    let creates: Vec<&Value> = outcome["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|request| request["method"] == "POST" && request["url"].as_str().unwrap().ends_with("/messages"))
        .collect();
    assert_eq!(
        creates.len(),
        3,
        "first part, its refused successor, and the successor again"
    );
    let body = |request: &Value| request["body"]["text"].as_str().unwrap().to_owned();
    assert!(body(creates[0]).contains("Paragraph one"));
    assert!(body(creates[1]).contains("Second part"));
    assert_eq!(
        body(creates[1]),
        body(creates[2]),
        "the retry resumed at the second part"
    );
    let target = rows(outcome, "publication_targets")[0];
    assert!(
        target.contains("text:'published'") && target.contains(r#"text:'["d1","d2"]'"#),
        "{target}"
    );
    let job = rows(outcome, "publish_jobs")[0];
    assert!(job.contains(r#""_discordMessageIds":["d1"]"#), "{job}");
}

/// A provider that never answers releases the queue at the publish timeout,
/// as ambiguous because the provider call had started; meanwhile the other
/// target's lane is not held behind it.
#[test]
fn hung_target_times_out_ambiguous_without_blocking_other_targets() {
    let mut steps = vec![json!({"sql": DRAFT})];
    steps.extend(job(1, "x", &json!({"text": "hello", "locale": "en"})));
    steps.extend(job(2, "telegram", &json!({"text": "hello", "locale": "ru"})));
    steps.push(json!({"call": "publishCycle"}));
    let spec = rust_only(json!([{
        "name": "hung target",
        "env": {"PUBLISH_JOB_TIMEOUT_SECONDS": "10"},
        "responses": [
            {"hang": true},
            ok(json!({"ok": true, "result": {"message_id": 42}})),
            ok(json!({"ok": true, "result": true})),
        ],
        "steps": steps,
    }]));
    let outcome = &support::rust_side_paused(&spec, call, &format!("rust-only-hung-{}", std::process::id()))[0];
    assert_eq!(outcome["results"][0]["result"], 2);
    let jobs = rows(outcome, "publish_jobs");
    assert!(
        jobs[0].contains("text:'verification_required'")
            && jobs[0].contains("delivery_execution_timeout: x exceeded 10s during provider.publish"),
        "{}",
        jobs[0]
    );
    assert!(jobs[1].contains("text:'published'"), "{}", jobs[1]);
    // Telegram settled while X was still waiting for its answer.
    let events = rows(outcome, "publication_events");
    let position = |kind: &str, target: &str| {
        events
            .iter()
            .position(|row| row.contains(&format!("text:'{kind}'")) && row.contains(&format!("text:'{target}'")))
            .unwrap_or_else(|| panic!("no {kind} for {target}"))
    };
    assert!(position("publish.job.published", "telegram") < position("publish.job.verification_required", "x"));
}

/// Deliberate deviation: a confirmation lands on the job and its target
/// together or not at all. An operator who settled the target while the
/// provider was being asked keeps their answer, and the job is let go for a
/// fresh read instead of being marked published beside it.
#[test]
fn reconciliation_leaves_a_target_settled_while_it_asked() {
    let steps = json!([
        {"sql": DRAFT},
        {"sql": "INSERT INTO publish_jobs (job_id, publication_key, target, status, payload_json, attempt_count, created_at, updated_at) VALUES (1, 'post:12', 'x', 'verification_required', '{}', 1, '2026-03-01T10:00:00.000Z', '2026-03-01T10:00:00.000Z')"},
        {"sql": "INSERT INTO publication_targets (publication_key, target, status, external_id, updated_at) VALUES ('post:12', 'x', 'verification_required', '555', '2026-03-01T10:00:00.000Z')"},
        {"call": "reconcile"},
    ]);
    let mut answer = ok(json!({"data": {"id": "555", "text": "hello"}}));
    answer["sql"] =
        json!("UPDATE publication_targets SET status = 'failed', error = 'operator: not published' WHERE target = 'x'");
    let spec = rust_only(json!([{"name": "target moved", "responses": [answer], "steps": steps}]));
    let outcome = &support::rust_side(&spec, call, &format!("rust-only-moved-{}", std::process::id()))[0];
    assert_eq!(outcome["results"][0]["result"]["resolved"], 0);
    let target = rows(outcome, "publication_targets")[0];
    assert!(
        target.contains("text:'failed'") && target.contains("operator: not published"),
        "{target}"
    );
    let job = rows(outcome, "publish_jobs")[0];
    assert!(
        job.contains("text:'verification_required'")
            && job.contains("integer:1 text:'2026-03-01T10:00:37.500Z' null:NULL null:NULL"),
        "the job is released with one poll counted: {job}"
    );
}
