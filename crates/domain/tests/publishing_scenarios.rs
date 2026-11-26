//! Publishing equivalence with the recorded goldens: every scenario in
//! `publishing_scenarios.json` ran through the TypeScript backend's publishing
//! modules before the cutover (`publishing_scenarios.golden.json`) and runs
//! through `domain::publishing`, each on its own fresh database under the same
//! fixed clock and jitter, and every step's result and every table's rows must
//! come out identical. The tables the spec ignores belong to boundaries faked
//! here (the credential breaker, runtime usage); the video completion notice is
//! the real one, so its journal entry is compared.

mod support;

use std::cell::Cell;
use std::path::{Path, PathBuf};

use content::Locale;
use db::{BackendDb, unsafe_db};
use domain::application::ports::{DomainEventInput, DraftPatch, DraftRecord, FixedClock};
use domain::delivery::VideoCompletionNotice;
use domain::publishing::boundaries::{Boundaries, NoWorker, ProviderOutcome, VideoProvider};
use domain::publishing::errors::PublishFailure;
use domain::publishing::extra_delivery::ExtraDeliveryScope;
use domain::publishing::publication_plan::PublishMode;
use domain::publishing::publication_workflow::PublishDraftOptions;
use domain::publishing::queue::EnqueuePublishJob;
use domain::publishing::requeue::{AudienceReached, RETRY_UNLESS_HELD, RequeueOptions, RequeueResult, RequeueScope};
use domain::publishing::scheduled_draft_mutation::ScheduledDraftMutation;
use domain::publishing::video_settle::{KnownPublication, SettleVideoInput};
use domain::publishing::video_types::VideoTarget;
use domain::publishing::{Publishing, delivery_payload, preflight, queue};
use domain::repositories::DraftStore;
use jiff::Timestamp;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use support::{FixedJitter, Inert, arg, differences, dump, instant, out, ready, resolve};

fn spec_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/publishing_scenarios.json")
}

/// The scenarios never reach a provider.
struct NoProvider;

impl VideoProvider for NoProvider {
    async fn post_outcome(&self, _: &str, _: &str) -> domain::Result<ProviderOutcome> {
        panic!("the scenarios never reach a provider")
    }
    async fn publish_instagram_reel(&self, _: &str, _: &str, _: &Value, _: &str) -> domain::Result<ProviderOutcome> {
        panic!("the scenarios never reach a provider")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Failure {
    message: String,
    status: Option<u16>,
    retry_after_seconds: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    post_id: Option<i64>,
    publication_key: String,
}

impl Scope {
    fn requeue(self) -> RequeueScope {
        RequeueScope {
            post_id: self.post_id,
            publication_key: self.publication_key,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Enqueue {
    publication_key: String,
    target: String,
    payload: Map<String, Value>,
    #[serde(default)]
    publish_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequeueArgs {
    from: Value,
    #[serde(default)]
    create_missing: bool,
    audience_reached: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PublishArgs {
    mode: Option<PublishMode>,
    ru_at: Option<String>,
    en_at: Option<String>,
    immediate_locale: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MutationArgs {
    patch: DraftPatch,
    #[serde(default)]
    event: Option<DomainEventInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArticleArgs {
    locale: String,
    targets: Vec<String>,
    markdown: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettleArgs {
    video_draft_id: i64,
    target: String,
    apply: bool,
    #[serde(default)]
    known: Option<KnownArgs>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnownArgs {
    provider_post_id: Option<String>,
    external_id: Option<String>,
    url: Option<String>,
}

fn locale(value: &str) -> Locale {
    match value {
        "ru" => Locale::Ru,
        "en" => Locale::En,
        other => panic!("locale {other}"),
    }
}

fn timestamp(value: &str) -> Timestamp {
    foundation::time::parse_iso_instant(value).unwrap()
}

fn video_target(value: &str) -> VideoTarget {
    VideoTarget::parse(value).unwrap_or_else(|| panic!("video target {value}"))
}

fn requeue_json(result: &RequeueResult) -> Value {
    let mut value = json!({ "target": result.target, "outcome": result.outcome.as_str(), "status": result.status });
    if let Some(reason) = result.reason {
        value["reason"] = json!(reason.as_str());
    }
    value
}

fn source_json(source: &domain::publishing::publication_source::PublicationSource) -> Value {
    let locale = |value: &domain::publishing::publication_source::PublicationLocaleSource| {
        json!({
            "text": value.text, "entities": value.entities, "media": value.media, "storyMedia": value.story_media,
            "siteMedia": value.site_media, "slug": value.slug, "publishAt": value.publish_at,
            "siteEnabled": value.site_enabled,
            "thread": value.thread.iter().map(|part| json!({ "text": part.text, "entities": part.entities, "media": part.media })).collect::<Vec<_>>(),
        })
    };
    json!({
        "draftId": source.draft_id, "postId": source.post_id, "targets": source.targets.to_json_value(),
        "locales": { "ru": locale(&source.ru), "en": locale(&source.en) },
    })
}

fn issue_json(issue: &preflight::PublicationPreflightIssue) -> Value {
    let mut value = json!({
        "target": issue.target, "locale": issue.locale.as_str(), "kind": issue.kind.as_str(), "label": issue.label,
    });
    for (key, field) in [("limit", issue.limit), ("actual", issue.actual)] {
        if let Some(number) = field {
            value[key] = json!(number);
        }
    }
    if let Some(written) = issue.written {
        value["written"] = json!(written.as_str());
    }
    if let Some(part) = issue.part {
        value["part"] = json!(part);
    }
    if let Some(parts) = issue.thread_parts {
        value["threadParts"] = json!(parts);
    }
    value
}

fn draft(publishing: &Publishing<'_>, id: i64) -> domain::Result<DraftRecord> {
    DraftStore::new(publishing.sqlite, publishing.clock)
        .get(id)?
        .ok_or_else(|| domain::Error::message(format!("draft {id} not found")))
}

fn call(
    publishing: &Publishing<'_>,
    config: &foundation::config::Config,
    name: &str,
    args: &[Value],
) -> domain::Result<Value> {
    let int = |index| arg::<i64>(args, index);
    let text = |index| arg::<String>(args, index);
    let source = |post_id: i64| move || publishing.publication_source_from_db(post_id);
    Ok(match name {
        "enqueue" => {
            let input: Enqueue = arg(args, 0);
            let payload = delivery_payload::new_delivery_payload(input.payload);
            out(queue::enqueue_publish_job_tx(
                publishing,
                &EnqueuePublishJob {
                    publication_key: &input.publication_key,
                    target: &input.target,
                    payload: &payload,
                    publish_at: input.publish_at.as_deref(),
                },
            )?)
        }
        "due" => out(publishing
            .due_publish_jobs(int(0))?
            .iter()
            .map(|job| json!({ "jobId": job.job_id, "target": job.target }))
            .collect::<Vec<_>>()),
        "claimDue" | "claim" => {
            let worker = text(1);
            let jobs = if name == "claim" {
                publishing.claim_publish_job(int(0), Some(&worker))?.into_iter().collect()
            } else {
                publishing.claim_due_publish_jobs(int(0), Some(&worker))?
            };
            let jobs: Vec<Value> = jobs
                .iter()
                .map(|job| {
                    json!({
                        "jobId": job.job_id, "publicationKey": job.publication_key, "target": job.target,
                        "payload": job.payload, "attemptCount": job.attempt_count, "lockId": job.lock_id,
                    })
                })
                .collect();
            if name == "claim" {
                out(jobs.into_iter().next())
            } else {
                out(jobs)
            }
        }
        "complete" => {
            let answered: Option<String> = arg(args, 3);
            publishing.complete_publish_job(int(0), &arg(args, 1), &text(2), answered.as_deref())?;
            Value::Null
        }
        "fail" => {
            let failure: Failure = arg(args, 1);
            let error = match failure.status {
                Some(status) => PublishFailure::http(failure.message, status, failure.retry_after_seconds),
                None => PublishFailure::new(failure.message),
            };
            publishing.fail_publish_job(int(0), &error, &text(2))?;
            Value::Null
        }
        "requireVerification" => out(publishing.require_publish_verification(int(0), &text(1), &text(2))?),
        "forceVerification" => {
            let result: Option<Map<String, Value>> = arg(args, 3);
            out(publishing.force_publish_job_verification(int(0), &text(1), &text(2), result.as_ref())?)
        }
        "recoverStale" => out(publishing.recover_stale_publish_jobs(arg(args, 0))?),
        "pending" => out(publishing
            .pending_delivery_targets(int(0))?
            .iter()
            .map(|pending| json!({ "target": pending.target, "started": pending.started }))
            .collect::<Vec<_>>()),
        "cancelRemaining" => {
            let report = publishing.cancel_remaining_delivery(int(0), int(1))?;
            json!({ "stopped": report.stopped, "finishing": report.finishing })
        }
        "requeue" => {
            let scope: Scope = arg(args, 0);
            let targets: Vec<String> = arg(args, 1);
            let options: RequeueArgs = arg(args, 2);
            let from: Vec<String> = match &options.from {
                Value::String(name) if name == "unlessHeld" => RETRY_UNLESS_HELD.iter().map(|s| s.to_string()).collect(),
                other => serde_json::from_value(other.clone()).unwrap(),
            };
            let from: Vec<&str> = from.iter().map(String::as_str).collect();
            let post_id = scope.post_id.expect("a requeue scenario names its post");
            let source = source(post_id);
            let results = publishing.requeue_publication_targets(
                &scope.requeue(),
                &targets.iter().map(String::as_str).collect::<Vec<_>>(),
                &RequeueOptions {
                    from: &from,
                    create_missing: options.create_missing,
                    audience_reached: if options.audience_reached == "resume" {
                        AudienceReached::Resume
                    } else {
                        AudienceReached::Republish
                    },
                    source: &source,
                },
            )?;
            Value::Array(results.iter().map(requeue_json).collect())
        }
        "abandon" => {
            let scope: Scope = arg(args, 0);
            let targets: Vec<String> = arg(args, 1);
            let results = publishing
                .abandon_publication_targets(&scope.requeue(), &targets.iter().map(String::as_str).collect::<Vec<_>>())?;
            Value::Array(
                results
                    .iter()
                    .map(|result| json!({ "target": result.target, "outcome": result.outcome.as_str(), "status": result.status }))
                    .collect(),
            )
        }
        "extraDelivery" => {
            let scope: Map<String, Value> = arg(args, 0);
            let scope = ExtraDeliveryScope {
                draft_id: scope["draftId"].as_i64().unwrap(),
                post_id: scope["postId"].as_i64().unwrap(),
                publication_key: scope["publicationKey"].as_str().unwrap().into(),
            };
            let source = source(scope.post_id);
            requeue_json(&publishing.deliver_extra_target(&scope, &text(1), &source)?)
        }
        "publishDraft" => {
            let options: Option<PublishArgs> = arg(args, 1);
            let options = options.unwrap_or_default();
            out(publishing.publish_draft_to_queue(
                int(0),
                PublishDraftOptions {
                    mode: options.mode,
                    ru_at: options.ru_at.as_deref().map(timestamp),
                    en_at: options.en_at.as_deref().map(timestamp),
                    immediate_locale: options.immediate_locale.as_deref().map(locale),
                },
            )?)
        }
        "cancelDraft" => {
            publishing.cancel_draft(int(0), int(1))?;
            Value::Null
        }
        "scheduledDrafts" => out(publishing.scheduled_drafts()?),
        "mutateScheduled" => {
            let mutation: MutationArgs = arg(args, 1);
            out(publishing.mutate_scheduled_draft(
                &draft(publishing, int(0))?,
                &ScheduledDraftMutation {
                    patch: mutation.patch,
                    queue_story_cards: false,
                    event: mutation.event,
                },
            )?)
        }
        "refreshOwner" => {
            domain::publishing::publication_owner::refresh_publication_owner(publishing, &text(0))?;
            Value::Null
        }
        "publishArticle" => {
            let input: ArticleArgs = arg(args, 0);
            let targets: Vec<&str> = input.targets.iter().map(String::as_str).collect();
            let published = publishing.publish_article(
                config,
                &domain::publishing::article_publish::PublishArticleInput {
                    locale: locale(&input.locale),
                    targets: &targets,
                    markdown: &input.markdown,
                },
            )?;
            json!({
                "ok": true, "article_id": published.article_id, "ref": published.publication_ref,
                "title": published.title, "targets": published.targets, "queued": true,
            })
        }
        "source" => source_json(&publishing.publication_source_from_db(int(0))?),
        "plan" => {
            let registered = domain::channels::registered_post_target_ids(publishing.sqlite)?;
            out(publishing.publication_plan_from_db(int(0), &registered)?)
        }
        "preflight" => {
            let limits = domain::channels::channel_upload_limits(publishing.sqlite)?;
            Value::Array(
                preflight::publication_preflight(&draft(publishing, int(0))?, &limits)
                    .iter()
                    .map(issue_json)
                    .collect(),
            )
        }
        "deliveries" => Value::Array(
            domain::publishing::chain_plan::planned_target_deliveries(&draft(publishing, int(0))?)
                .iter()
                .map(|delivery| {
                    json!({
                        "target": delivery.target, "label": delivery.label, "locale": delivery.locale.as_str(),
                        "posts": delivery.posts.iter().map(|post| json!({ "text": post.text, "entities": post.entities, "media": post.media })).collect::<Vec<_>>(),
                        "chained": delivery.chained,
                    })
                })
                .collect(),
        ),
        "video.create" => out(publishing.create_video_draft(int(0), int(1), int(2), locale(&text(3)))?),
        "video.replaceTargets" => {
            let targets: Vec<String> = arg(args, 1);
            publishing.replace_video_targets(int(0), &targets.iter().map(String::as_str).collect::<Vec<_>>())?;
            Value::Null
        }
        "video.removeTarget" => out(publishing.remove_video_target(int(0), video_target(&text(1)), int(2))?),
        "video.saveMetadata" => {
            publishing.save_video_metadata(int(0), video_target(&text(1)), &arg(args, 2))?;
            Value::Null
        }
        "video.schedule" => {
            let schedule: Map<String, Value> = arg(args, 1);
            let schedule: Vec<(VideoTarget, Timestamp)> = schedule
                .iter()
                .map(|(target, at)| (video_target(target), timestamp(at.as_str().unwrap())))
                .collect();
            publishing.schedule_video(int(0), &schedule, int(2), arg(args, 3))?;
            Value::Null
        }
        "video.cancel" => {
            let cancellation = publishing.cancel_video(int(0), int(1))?;
            json!({
                "manualRemoval": cancellation.manual_removal.iter().map(|(target, url)| json!({ "target": target, "url": url })).collect::<Vec<_>>(),
                "holdPrivateYouTubeIds": cancellation.hold_private_youtube_ids,
            })
        }
        "video.retry" => {
            let retry = ready(publishing.retry_video_target(config, &NoProvider, int(0), video_target(&text(1))))?;
            json!({ "settled": retry.settled })
        }
        "video.settle" => {
            let input: SettleArgs = arg(args, 0);
            let settled = ready(publishing.settle_video_target(
                config,
                &NoProvider,
                &SettleVideoInput {
                    video_draft_id: input.video_draft_id,
                    target: &input.target,
                    apply: input.apply,
                    known: input.known.map(|known| KnownPublication {
                        provider_post_id: known.provider_post_id,
                        external_id: known.external_id,
                        url: known.url,
                    }),
                },
            ))?;
            Value::Object(settled)
        }
        "video.updateLabel" => {
            publishing.update_video_label(int(0), &text(1))?;
            Value::Null
        }
        "video.updateScript" => {
            publishing.update_video_script(int(0), &text(1), &text(2))?;
            Value::Null
        }
        "video.replaceSource" => {
            publishing.replace_video_source(int(0), int(1), arg(args, 2))?;
            Value::Null
        }
        "video.refreshStatus" => {
            publishing.refresh_video_draft_status(int(0), int(1))?;
            Value::Null
        }
        other => panic!("unknown call {other}"),
    })
}

fn error_json(error: &domain::Error) -> Value {
    match error {
        domain::Error::Studio(studio) if !studio.params.is_empty() => json!({
            "error": studio.code,
            "params": studio.params.iter().map(|(key, value)| (key.clone(), json!(value))).collect::<Map<_, _>>(),
        }),
        other => json!({ "error": other.to_string() }),
    }
}

fn run(spec: &Value, scenario: &Value) -> Value {
    let backend_db = BackendDb::open(":memory:").unwrap();
    let clock = FixedClock(Cell::new(instant(&spec["clock"])));
    let sqlite = unsafe_db(&backend_db);
    let jitter = FixedJitter(spec["jitter"].as_f64().unwrap());
    let completion = VideoCompletionNotice::new(&clock);
    let publishing = Publishing::new(
        sqlite,
        &clock,
        Boundaries {
            jitter: &jitter,
            bell: &NoWorker,
            auth_circuit: &Inert,
            usage: &Inert,
            story_cards: &Inert,
            video_completion: &completion,
        },
    );
    let config = foundation::config::load_config(
        spec["config"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned())),
    )
    .unwrap();
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
        } else {
            let name = step["call"].as_str().expect("step without clock, sql or call");
            let args = resolve(step.get("args").unwrap_or(&json!([])), &vars);
            let result = match call(&publishing, &config, name, args.as_array().unwrap()) {
                Ok(value) => {
                    if let Some(bind) = step.get("bind").and_then(Value::as_str) {
                        vars.insert(bind.into(), value.clone());
                    }
                    value
                }
                Err(_) if step.get("error").is_some_and(|mode| mode == "any") => json!({ "error": "<any>" }),
                Err(error) => error_json(&error),
            };
            results.push(json!({ "call": name, "result": out(result) }));
        }
    }
    for sql in spec["beforeDump"].as_array().unwrap() {
        sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    out(json!({ "name": scenario["name"], "results": results, "tables": dump(sqlite, &ignored) }))
}

#[test]
fn publishing_matches_typescript() {
    let spec: Value = serde_json::from_str(&std::fs::read_to_string(spec_path()).unwrap()).unwrap();
    let typescript = support::golden(&spec_path());
    let actual: Vec<Value> = spec["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .map(|scenario| run(&spec, scenario))
        .collect();
    let failures = differences(typescript["scenarios"].as_array().unwrap(), &actual);
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The scenarios reach every call the runner dispatches.
#[test]
fn scenarios_cover_every_call() {
    let spec = std::fs::read_to_string(spec_path()).unwrap();
    let source =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/publishing_scenarios.rs")).unwrap();
    let dispatch = &source[source.find("fn call(").unwrap()..source.find("fn error_json(").unwrap()];
    let dispatched: Vec<&str> = dispatch
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"')?.split_once("\" =>").map(|(name, _)| name))
        .flat_map(|names| names.split("\" | \""))
        .collect();
    assert!(dispatched.len() > 35, "{dispatched:?}");
    let missing: Vec<&&str> = dispatched
        .iter()
        .filter(|name| !spec.contains(&format!("\"call\": \"{name}\"")))
        .collect();
    assert!(missing.is_empty(), "never called: {missing:?}");
}
