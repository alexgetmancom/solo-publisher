//! The pure publishing rules against the reference outputs in
//! `fixtures/publishing.json`, recorded from the TypeScript backend before the
//! cutover: schedule and zone math across DST edges, error classes and retry
//! curves, result normalization, preflight, job payloads, chain cuts and status
//! folds.

mod support;

use content::thread::{LocalizedThreadPart, ThreadPart};
use domain::application::ports::DraftRecord;
use domain::publishing::chain_plan::planned_target_deliveries;
use domain::publishing::errors::{
    PublishFailure, classify_message, classify_publish_error, next_retry_at, normalize_publish_result,
};
use domain::publishing::job_policy::{
    RetryPolicy, failed_job_transition, may_have_reached_audience, partial_publication_transition,
    video_step_may_have_reached_audience,
};
use domain::publishing::media_policy::{MediaPolicyMode, media_policy_for_target};
use domain::publishing::payload::localize_target_payload;
use domain::publishing::platform_profiles::format_platform_text;
use domain::publishing::preflight::{UploadLimits, publication_preflight};
use domain::publishing::publication_plan::effective_publication_targets;
use domain::publishing::publication_source::{PublicationLocaleSource, PublicationSource};
use domain::publishing::schedule::{
    assert_future_schedule, immediate_schedule_time, is_immediate_schedule, parse_manual_schedule,
    publication_slot_time,
};
use domain::publishing::state::{
    effective_publication_status, has_unscheduled_locale, is_partial_delivery, is_post_target_retryable,
    publication_status, video_draft_status,
};
use domain::publishing::threads_text::threads_body;
use domain::publishing::video_metadata_limits::youtube_tags_length;
use domain::targets::TargetMap;
use foundation::time::{Zone, parse_iso_instant, to_iso_string};
use serde_json::{Map, Value, json};
use support::{FixedJitter, out};

fn fixture() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/publishing.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn rows<'a>(fixture: &'a Value, key: &str) -> &'a Vec<Value> {
    fixture[key]
        .as_array()
        .unwrap_or_else(|| panic!("fixture has no {key}"))
}

fn ms(value: &Value) -> i64 {
    parse_iso_instant(value.as_str().unwrap()).unwrap().as_millisecond()
}

fn opt_str(value: &Value) -> Option<&str> {
    value.as_str()
}

fn failure(input: &Value) -> PublishFailure {
    let message = input["message"].as_str().unwrap();
    match input["status"].as_u64() {
        Some(status) => PublishFailure::http(message, status as u16, input["retryAfterSeconds"].as_f64()),
        None => PublishFailure::new(message),
    }
}

fn targets(value: &Value) -> TargetMap {
    TargetMap::from_json(value.as_object().unwrap())
}

fn strings(value: &Value) -> Vec<String> {
    serde_json::from_value(value.clone()).unwrap()
}

/// Every mismatch, so one run shows them all.
#[derive(Default)]
struct Mismatches(Vec<String>);

impl Mismatches {
    fn check(&mut self, what: impl std::fmt::Display, expected: &Value, actual: Value) {
        let actual = out(actual);
        if *expected != actual {
            self.0.push(format!("{what}\n  ts:   {expected}\n  rust: {actual}"));
        }
    }

    fn assert(self) {
        assert!(self.0.is_empty(), "{} mismatches:\n{}", self.0.len(), self.0.join("\n"));
    }
}

#[test]
fn schedule_and_zone_math_match_typescript() {
    let fixture = fixture();
    let mut mismatches = Mismatches::default();
    for row in rows(&fixture, "schedule") {
        let zone = Zone::parse(row["zone"].as_str().unwrap()).unwrap();
        let now = parse_iso_instant(row["now"].as_str().unwrap()).unwrap();
        let input = row["input"].as_str().unwrap();
        let result = match row["fn"].as_str().unwrap() {
            "publicationSlotTime" => match publication_slot_time(input, &zone, now) {
                Ok(at) => json!({ "ok": to_iso_string(at) }),
                Err(error) => json!({ "error": error.to_string() }),
            },
            _ => match parse_manual_schedule(input, &zone, now) {
                Ok(at) => json!({ "ok": to_iso_string(at) }),
                Err(error) => json!({ "error": error.code }),
            },
        };
        mismatches.check(
            format!("{} {} {} {input:?}", row["fn"], row["zone"], row["now"]),
            &row["result"],
            result,
        );
    }
    let now = parse_iso_instant(fixture["now"].as_str().unwrap()).unwrap();
    for row in rows(&fixture, "bounds") {
        let at = jiff::Timestamp::from_millisecond(now.as_millisecond() + row["offset"].as_i64().unwrap()).unwrap();
        mismatches.check(
            format!("bounds {}", row["offset"]),
            row,
            json!({
                "offset": row["offset"],
                "immediate": to_iso_string(immediate_schedule_time(now)),
                "isImmediate": is_immediate_schedule(at, now),
                "future": match assert_future_schedule(at, now) {
                    Ok(()) => json!({ "ok": null }),
                    Err(error) => json!({ "error": error.code }),
                },
            }),
        );
    }
    assert!(rows(&fixture, "schedule").len() > 2000);
    mismatches.assert();
}

#[test]
fn error_classes_and_retry_curves_match_typescript() {
    let fixture = fixture();
    let jitter = FixedJitter(fixture["jitter"].as_f64().unwrap());
    let now = ms(&fixture["now"]);
    let policy = RetryPolicy {
        max_attempts: 4,
        backoff_base_seconds: 60,
        backoff_max_seconds: 3600,
    };
    let mut mismatches = Mismatches::default();
    for row in rows(&fixture, "errors") {
        let error = failure(&row["input"]);
        mismatches.check(
            format!("class of {}", row["input"]),
            &row["class"],
            json!(classify_publish_error(&error).as_str()),
        );
        let transitions: Vec<Value> = (0..4)
            .map(|attempt| {
                let transition = failed_job_transition(&error, attempt, policy, now, &jitter);
                json!({
                    "attempt": transition.attempt, "errorClass": transition.error_class.as_str(),
                    "status": transition.status, "nextAttemptAt": transition.next_attempt_at,
                })
            })
            .collect();
        mismatches.check(
            format!("transitions of {}", row["input"]),
            &row["transitions"],
            json!(transitions),
        );
    }
    for row in rows(&fixture, "messages") {
        mismatches.check(
            format!("class of message {}", row["message"]),
            &row["class"],
            json!(classify_message(opt_str(&row["message"])).as_str()),
        );
    }
    for row in rows(&fixture, "retries") {
        let at = next_retry_at(
            row["attempt"].as_u64().unwrap() as u32,
            60,
            3600,
            now,
            row["retryAfter"].as_f64(),
            &jitter,
        );
        mismatches.check(format!("retry {row}"), &row["at"], json!(at));
    }
    for row in rows(&fixture, "partials") {
        let transition = partial_publication_transition(
            row["attempt"].as_u64().unwrap() as u32,
            RetryPolicy {
                max_attempts: 12,
                ..policy
            },
            now,
            &jitter,
        );
        mismatches.check(
            format!("partial {}", row["attempt"]),
            row,
            json!({
                "attempt": row["attempt"], "status": transition.status, "attemptOut": transition.attempt,
                "nextAttemptAt": transition.next_attempt_at,
            }),
        );
    }
    for row in rows(&fixture, "normalized") {
        let result = normalize_publish_result(row["input"].as_object().unwrap());
        mismatches.check(
            format!("normalize {}", row["input"]),
            &row["output"],
            json!({
                "status": result.status, "externalId": result.external_id, "externalIds": result.external_ids,
                "url": result.url, "error": result.error, "skipped": result.skipped, "rawJson": result.raw_json,
            }),
        );
    }
    for row in rows(&fixture, "phases") {
        mismatches.check(
            format!("phase {}", row["phase"]),
            &row["reached"],
            json!(may_have_reached_audience(opt_str(&row["phase"]))),
        );
    }
    for row in rows(&fixture, "videoSteps") {
        mismatches.check(
            format!("video step {row}"),
            &row["reached"],
            json!(video_step_may_have_reached_audience(
                opt_str(&row["kind"]),
                opt_str(&row["target"])
            )),
        );
    }
    mismatches.assert();
}

#[test]
fn status_folds_match_typescript() {
    let fixture = fixture();
    let mut mismatches = Mismatches::default();
    for row in rows(&fixture, "folds") {
        let statuses = strings(&row["statuses"]);
        mismatches.check(
            format!("folds {}", row["statuses"]),
            row,
            json!({ "statuses": statuses, "publication": publication_status(&statuses), "video": video_draft_status(&statuses) }),
        );
    }
    for row in rows(&fixture, "retryable") {
        let (target, status) = (row["target"].as_str().unwrap(), row["status"].as_str().unwrap());
        mismatches.check(
            format!("retryable {row}"),
            row,
            json!({
                "target": target, "status": status, "error": row["error"],
                "retryable": is_post_target_retryable(target, status, opt_str(&row["error"])),
                "partial": is_partial_delivery(status, (status == "failed").then_some("id")),
            }),
        );
    }
    for row in rows(&fixture, "effective") {
        let jobs: Vec<(String, String)> = row["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|job| {
                (
                    job["target"].as_str().unwrap().into(),
                    job["status"].as_str().unwrap().into(),
                )
            })
            .collect();
        mismatches.check(
            format!("effective {row}"),
            &row["status"],
            json!(effective_publication_status(
                &jobs,
                row["plan"].as_object(),
                &strings(&row["registered"])
            )),
        );
    }
    for row in rows(&fixture, "unscheduled") {
        mismatches.check(
            format!("unscheduled {row}"),
            &row["pending"],
            json!(has_unscheduled_locale(
                &targets(&row["targets"]),
                opt_str(&row["ruAt"]),
                opt_str(&row["enAt"])
            )),
        );
    }
    for row in rows(&fixture, "effectiveTargets") {
        let available = row["available"].as_array().map(|_| strings(&row["available"]));
        let count = |locale: &str| row["media"][locale].as_array().unwrap().len();
        mismatches.check(
            format!("effective targets {row}"),
            &row["effective"],
            Value::Object(
                effective_publication_targets(
                    &targets(&row["requested"]),
                    available.as_deref(),
                    [count("ru"), count("en")],
                    row["cards"].as_bool().unwrap(),
                    opt_str(&row["mode"]),
                )
                .to_json_value(),
            ),
        );
    }
    mismatches.assert();
}

fn draft(value: &Value) -> DraftRecord {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    DraftRecord {
        id: 1,
        actor_id: 42,
        status: "draft".into(),
        text_ru: text("text_ru").unwrap_or_default(),
        text_en_machine: text("text_en_machine"),
        text_en_approved: text("text_en_approved"),
        targets_json: text("targets_json").unwrap(),
        media_ru_json: text("media_ru_json"),
        media_en_json: text("media_en_json"),
        scheduled_at: None,
        scheduled_en_at: None,
        post_id: None,
        text_ru_entities_json: text("text_ru_entities_json"),
        text_en_entities_json: text("text_en_entities_json"),
        story_publish_mode: None,
        updated_at: "2026-03-01T10:00:00.000Z".into(),
        thread: value
            .get("thread")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|part| ThreadPart {
                position: part["position"].as_i64().unwrap(),
                text_ru: part["textRu"].as_str().unwrap().into(),
                entities_ru: serde_json::from_value(part["entitiesRu"].clone()).unwrap(),
                text_en: part["textEn"].as_str().map(str::to_owned),
                text_en_approved: part["textEnApproved"].as_str().map(str::to_owned),
                media: serde_json::from_value(part["media"].clone()).unwrap(),
            })
            .collect(),
    }
}

fn locale_source(value: &Value) -> PublicationLocaleSource {
    let records = |key: &str| serde_json::from_value(value[key].clone()).unwrap();
    PublicationLocaleSource {
        text: value["text"].as_str().unwrap().into(),
        entities: records("entities"),
        media: records("media"),
        story_media: records("storyMedia"),
        site_media: records("siteMedia"),
        slug: value["slug"].as_str().unwrap().into(),
        publish_at: value["publishAt"].as_str().map(str::to_owned),
        site_enabled: value["siteEnabled"].as_bool().unwrap(),
        thread: value["thread"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| LocalizedThreadPart {
                text: part["text"].as_str().unwrap().into(),
                entities: serde_json::from_value(part["entities"].clone()).unwrap(),
                media: serde_json::from_value(part["media"].clone()).unwrap(),
            })
            .collect(),
    }
}

#[test]
fn preflight_payloads_and_platform_text_match_typescript() {
    let fixture = fixture();
    let mut mismatches = Mismatches::default();
    let limits = UploadLimits::from([("discord".to_owned(), 15_000_000)]);
    for row in rows(&fixture, "preflight") {
        let record = draft(&row["draft"]);
        let issues: Vec<Value> = publication_preflight(&record, &limits)
            .iter()
            .map(|issue| {
                let mut value = Map::new();
                value.insert("target".into(), json!(issue.target));
                value.insert("locale".into(), json!(issue.locale.as_str()));
                value.insert("kind".into(), json!(issue.kind.as_str()));
                value.insert("label".into(), json!(issue.label));
                for (key, field) in [("limit", issue.limit), ("actual", issue.actual)] {
                    if let Some(number) = field {
                        value.insert(key.into(), json!(number));
                    }
                }
                if let Some(written) = issue.written {
                    value.insert("written".into(), json!(written.as_str()));
                }
                if let Some(part) = issue.part {
                    value.insert("part".into(), json!(part));
                }
                if let Some(parts) = issue.thread_parts {
                    value.insert("threadParts".into(), json!(parts));
                }
                Value::Object(value)
            })
            .collect();
        mismatches.check(format!("preflight {}", row["draft"]), &row["issues"], json!(issues));
        let deliveries: Vec<Value> = planned_target_deliveries(&record)
            .iter()
            .map(|delivery| {
                json!({
                    "target": delivery.target, "label": delivery.label, "locale": delivery.locale.as_str(),
                    "posts": delivery.posts.iter().map(|post| json!({ "text": post.text, "entities": post.entities, "media": post.media })).collect::<Vec<_>>(),
                    "chained": delivery.chained,
                })
            })
            .collect();
        mismatches.check(
            format!("deliveries {}", row["draft"]),
            &row["deliveries"],
            json!(deliveries),
        );
    }
    let source = &fixture["source"];
    let source = PublicationSource {
        draft_id: source["draftId"].as_i64().unwrap(),
        post_id: source["postId"].as_i64().unwrap(),
        targets: targets(&source["targets"]),
        ru: locale_source(&source["locales"]["ru"]),
        en: locale_source(&source["locales"]["en"]),
    };
    for row in rows(&fixture, "payloads") {
        let target = row["target"].as_str().unwrap();
        mismatches.check(
            format!("payload for {target}"),
            &row["payload"],
            Value::Object(localize_target_payload(&source, target)),
        );
    }
    for row in rows(&fixture, "texts") {
        mismatches.check(
            format!("text {row}"),
            &row["formatted"],
            json!(format_platform_text(
                row["target"].as_str().unwrap(),
                row["text"].as_str().unwrap()
            )),
        );
    }
    for row in rows(&fixture, "threads") {
        let entities = serde_json::from_value::<Vec<_>>(row["entities"].clone()).unwrap();
        let body = threads_body(
            row["target"].as_str().unwrap(),
            row["text"].as_str().unwrap(),
            &entities,
        );
        mismatches.check(
            format!("threads {}", row["target"]),
            &row["body"],
            json!({ "text": body.text, "url": body.url, "droppedUrl": body.dropped_url, "shortfall": body.shortfall }),
        );
    }
    for row in rows(&fixture, "media") {
        let policy = media_policy_for_target(row["target"].as_str().unwrap(), row["items"].as_array().unwrap());
        mismatches.check(
            format!("media policy {}", row["target"]),
            &row["policy"],
            json!({
                "target": policy.target, "inputCount": policy.input_count, "deliveredCount": policy.delivered_count,
                "mode": match policy.mode {
                    MediaPolicyMode::All => "all",
                    MediaPolicyMode::Limited => "limited",
                    MediaPolicyMode::First => "first",
                    MediaPolicyMode::StoryFirst => "story-first",
                },
                "note": policy.note,
            }),
        );
    }
    for row in rows(&fixture, "tags") {
        mismatches.check(
            format!("tags {}", row["tags"]),
            &row["length"],
            json!(youtube_tags_length(&strings(&row["tags"]))),
        );
    }
    mismatches.assert();
}
