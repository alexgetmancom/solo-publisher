//! The TypeScript tests that pin the delivery invariants, ported: leases
//! fence every settlement, an ambiguous outcome is never republished, a
//! half-published chain resumes rather than repeats, cancellation binds at the
//! claim, and taking a target down or putting it back journals in the same
//! transaction. Sources: jobPolicy, jobPhase, publicationState, publishErrors,
//! queue, deliveryCancellation, postRecoveryScenario, postRetry,
//! replanUnfinished, schedule and videoRescheduleGuard `.test.ts`.

mod support;

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use db::rusqlite::{Connection, OptionalExtension};
use db::{BackendDb, unsafe_db};
use domain::application::ports::{DraftPatch, StoryPublishMode};
use domain::publishing::boundaries::{
    AuthCircuit, AuthCircuitState, Boundaries, Jitter, MediaMetadata, MediaProbe, ProviderOutcome, StoryCardMedia,
    StoryCardState, StoryCards, UsageMeter, VideoCompletion, VideoProvider, WorkerBell,
};
use domain::publishing::delivery_payload::{
    deferred_delivery_payload, has_resume_state, new_delivery_payload, resumed_delivery_payload,
};
use domain::publishing::errors::{PublishErrorClass, PublishFailure, classify_publish_error, next_retry_at};
use domain::publishing::job_policy::{
    RetryPolicy, failed_job_transition, may_have_reached_audience, partial_publication_transition,
};
use domain::publishing::publication_plan::PublishMode;
use domain::publishing::publication_workflow::PublishDraftOptions;
use domain::publishing::queue::{EnqueuePublishJob, enqueue_publish_job_tx};
use domain::publishing::requeue::{AudienceReached, RETRY_UNLESS_HELD, RequeueOptions, RequeueOutcome, RequeueScope};
use domain::publishing::schedule::{parse_manual_schedule, publication_slot_time};
use domain::publishing::scheduled_draft_mutation::ScheduledDraftMutation;
use domain::publishing::state::{
    is_audience_mutation_retryable, is_post_target_retryable, is_video_target_editable, is_video_target_schedulable,
    publication_status, video_draft_status,
};
use domain::publishing::video_service::validate_video_source;
use domain::publishing::video_settle::SettleVideoInput;
use domain::publishing::video_types::VideoTarget;
use domain::publishing::{Publishing, abandon::AbandonOutcome};
use domain::repositories::DraftStore;
use foundation::config::{PUBLISH_MAX_ATTEMPTS, PUBLISH_PARTIAL_MAX_ATTEMPTS};
use foundation::time::{Zone, parse_iso_instant, to_iso_string};
use jiff::Timestamp;
use serde_json::{Map, Value, json};
use support::FixedClock;

const T0: &str = "2026-03-01T10:00:00.000Z";

struct Half;

impl Jitter for Half {
    fn unit(&self) -> f64 {
        0.5
    }
}

/// Records what publishing told the boundaries it reports to.
#[derive(Default)]
struct Recorder(RefCell<Vec<String>>);

impl Recorder {
    fn push(&self, entry: String) {
        self.0.borrow_mut().push(entry);
    }

    fn entries(&self) -> Vec<String> {
        self.0.borrow().clone()
    }
}

impl WorkerBell for Recorder {
    fn ring_publish(&self) {
        self.push("ring".into());
    }
    fn ring_publish_after(&self, delay_ms: u64) {
        self.push(format!("ring after {delay_ms}"));
    }
}

impl AuthCircuit for Recorder {
    fn record_failure(&self, _: &Connection, target: &str) -> domain::Result<()> {
        self.push(format!("auth failure {target}"));
        Ok(())
    }
    fn record_success(&self, _: &Connection, target: &str) -> domain::Result<()> {
        self.push(format!("auth success {target}"));
        Ok(())
    }
    fn states(&self, _: &Connection) -> domain::Result<Vec<AuthCircuitState>> {
        Ok(Vec::new())
    }
}

impl UsageMeter for Recorder {
    fn record(&self, _: &Connection, feature: &str, success: bool, _: u64) {
        self.push(format!("usage {feature} {success}"));
    }
}

impl StoryCards for Recorder {
    fn queue(&self, _: &Connection, draft_id: i64) -> domain::Result<()> {
        self.push(format!("story cards queued {draft_id}"));
        Ok(())
    }
    fn ready_media(&self, _: &Connection, _: i64) -> domain::Result<Option<StoryCardMedia>> {
        Ok(None)
    }
    fn for_draft(&self, _: &Connection, _: i64) -> domain::Result<Vec<StoryCardState>> {
        Ok(Vec::new())
    }
    fn set_publish_mode(&self, _: &Connection, _: i64, _: StoryPublishMode) -> domain::Result<()> {
        panic!("no scenario sets a Story publish mode")
    }
    fn discard(&self, _: &Connection, draft_id: i64) -> domain::Result<()> {
        self.push(format!("story cards discarded {draft_id}"));
        Ok(())
    }
}

impl VideoCompletion for Recorder {
    fn record_if_final(&self, _: &Connection, video_draft_id: i64) -> domain::Result<()> {
        self.push(format!("video completion {video_draft_id}"));
        Ok(())
    }
}

struct World {
    db: BackendDb,
    clock: FixedClock,
    recorder: Recorder,
}

impl World {
    fn new() -> Self {
        Self {
            db: BackendDb::open(":memory:").unwrap(),
            clock: FixedClock(Cell::new(parse_iso_instant(T0).unwrap())),
            recorder: Recorder::default(),
        }
    }

    fn publishing(&self) -> Publishing<'_> {
        let recorder = &self.recorder;
        Publishing::new(
            unsafe_db(&self.db),
            &self.clock,
            Boundaries {
                jitter: &Half,
                bell: recorder,
                auth_circuit: recorder,
                usage: recorder,
                story_cards: recorder,
                video_completion: recorder,
            },
        )
    }

    fn sql(&self, statement: &str) {
        unsafe_db(&self.db).execute_batch(statement).unwrap();
    }

    fn text(&self, query: &str) -> Option<String> {
        unsafe_db(&self.db)
            .query_row(query, [], |row| row.get::<_, Option<String>>(0))
            .optional()
            .unwrap()
            .flatten()
    }

    fn int(&self, query: &str) -> i64 {
        unsafe_db(&self.db).query_row(query, [], |row| row.get(0)).unwrap()
    }

    fn job(&self, job_id: i64) -> (String, i64, Option<String>, Map<String, Value>) {
        unsafe_db(&self.db)
            .query_row(
                "SELECT status, attempt_count, locked_by, payload_json FROM publish_jobs WHERE job_id = ?",
                [job_id],
                |row| {
                    let payload: Option<String> = row.get(3)?;
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        payload.map_or_else(Map::new, |text| serde_json::from_str(&text).unwrap()),
                    ))
                },
            )
            .unwrap()
    }

    fn target(&self, target: &str) -> (String, Option<String>) {
        unsafe_db(&self.db)
            .query_row(
                "SELECT status, external_id FROM publication_targets WHERE target = ?",
                [target],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    fn at(&self, iso: &str) {
        self.clock.0.set(parse_iso_instant(iso).unwrap());
    }

    fn enqueue(&self, publication_key: &str, target: &str, payload: Value) -> i64 {
        let payload = new_delivery_payload(payload.as_object().unwrap().clone());
        self.enqueue_payload(publication_key, target, &payload, None)
    }

    fn enqueue_payload(
        &self,
        publication_key: &str,
        target: &str,
        payload: &domain::publishing::delivery_payload::DeliveryPayload,
        publish_at: Option<&str>,
    ) -> i64 {
        enqueue_publish_job_tx(
            &self.publishing(),
            &EnqueuePublishJob {
                publication_key,
                target,
                payload,
                publish_at,
            },
        )
        .unwrap()
    }

    fn claim(&self, worker: &str) -> Vec<i64> {
        self.publishing()
            .claim_due_publish_jobs(10, Some(worker))
            .unwrap()
            .into_iter()
            .map(|job| job.job_id)
            .collect()
    }

    fn complete(&self, job_id: i64, result: Value, lock: &str, answered: Option<&str>) {
        self.publishing()
            .complete_publish_job(job_id, result.as_object().unwrap(), lock, answered)
            .unwrap();
    }

    fn seed_post(&self, draft_id: i64, post_id: i64, targets: &str, ru: &str, en: &str) {
        self.sql(&format!(
            "INSERT INTO drafts (id, actor_id, status, targets_json, post_id, created_at, updated_at) VALUES ({draft_id}, 42, 'scheduled', '{targets}', {post_id}, '{T0}', '{T0}');
             INSERT INTO post_locales (draft_id, locale, source_text, updated_at) VALUES ({draft_id}, 'ru', '{ru}', '{T0}'), ({draft_id}, 'en', '{en}', '{T0}');"
        ));
    }

    fn connect(&self, targets: &[&str]) {
        for target in targets {
            let locale = domain::targets::target_locale(target).unwrap().as_str();
            self.sql(&format!(
                "INSERT INTO channel_connections (id, platform, locale, provider, target_id, label, created_at, updated_at) VALUES ('{target}', '{target}', '{locale}', 'native', '{target}', '{target}', '{T0}', '{T0}')"
            ));
        }
    }
}

fn scope(post_id: i64) -> RequeueScope {
    RequeueScope {
        post_id: Some(post_id),
        publication_key: format!("post:{post_id}"),
    }
}

fn ready<T>(future: impl Future<Output = T>) -> T {
    match pin!(future).poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("a fake boundary never waits"),
    }
}

const POLICY: RetryPolicy = RetryPolicy {
    max_attempts: 4,
    backoff_base_seconds: 60,
    backoff_max_seconds: 3600,
};

// ------------------------------------------------------------ jobPolicy.test.ts

#[test]
fn retries_transient_errors_within_the_configured_budget() {
    let transition = failed_job_transition(
        &PublishFailure::new("HTTP 503 service unavailable"),
        0,
        POLICY,
        0,
        &Half,
    );
    assert_eq!(
        (transition.attempt, transition.error_class, transition.status),
        (1, PublishErrorClass::Transient, "queued")
    );
    assert!(transition.next_attempt_at.is_some());
}

#[test]
fn gives_unknown_errors_one_safe_retry_and_never_retries_permanent_errors() {
    let unknown = PublishFailure::new("unexpected parser failure");
    assert_eq!(failed_job_transition(&unknown, 0, POLICY, 0, &Half).status, "queued");
    assert_eq!(failed_job_transition(&unknown, 1, POLICY, 0, &Half).status, "failed");
    assert_eq!(
        failed_job_transition(&PublishFailure::new("HTTP 403 forbidden"), 0, POLICY, 0, &Half).status,
        "failed"
    );
}

#[test]
fn a_partial_publication_uses_the_same_curve() {
    assert_eq!(partial_publication_transition(0, POLICY, 0, &Half).status, "queued");
    let last = partial_publication_transition(3, POLICY, 0, &Half);
    assert_eq!((last.attempt, last.status, last.next_attempt_at), (4, "failed", None));
}

// ------------------------------------------------------------ jobPhase.test.ts

#[test]
fn a_job_before_the_provider_call_goes_back_and_everything_after_is_held() {
    assert!(!may_have_reached_audience(None));
    assert!(!may_have_reached_audience(Some("validate")));
    assert!(!may_have_reached_audience(Some("prepare")));
    assert!(may_have_reached_audience(Some("provider.publish")));
    assert!(may_have_reached_audience(Some("provider.verify")));
    assert!(may_have_reached_audience(Some("provider.something-new")));
}

// ------------------------------------------------------------ publicationState.test.ts

#[test]
fn publication_states_fold_consistently_and_never_read_empty_as_success() {
    assert!(is_video_target_editable("editing"));
    assert!(!is_video_target_editable("scheduled"));
    assert!(is_video_target_schedulable("scheduled"));
    assert!(!is_video_target_schedulable("published"));
    assert_eq!(video_draft_status(&["published", "published"]), "published");
    assert_eq!(video_draft_status(&["published", "failed"]), "partial");
    assert_eq!(video_draft_status(&["published", "scheduled"]), "scheduled");
    assert_eq!(publication_status(&["published", "failed"]), Some("failed"));
    assert_eq!(publication_status(&["published", "queued"]), None);
    assert_eq!(video_draft_status::<&str>(&[]), "scheduled");
    assert_eq!(publication_status::<&str>(&[]), None);
    assert!(is_audience_mutation_retryable("failed"));
    assert!(!is_audience_mutation_retryable("verification_required"));
    assert!(!is_post_target_retryable("threads_en", "verification_required", None));
    assert!(is_post_target_retryable("site_en", "verification_required", None));
}

// ------------------------------------------------------------ publishErrors.test.ts

#[test]
fn auth_is_its_own_class_and_an_open_breaker_is_transient() {
    let http = |status| PublishFailure::http("nope", status, None);
    assert_eq!(classify_publish_error(&http(401)), PublishErrorClass::Auth);
    assert_eq!(classify_publish_error(&http(403)), PublishErrorClass::Auth);
    assert_eq!(classify_publish_error(&http(400)), PublishErrorClass::Permanent);
    assert_eq!(
        classify_publish_error(&PublishFailure::new("Unauthorized")),
        PublishErrorClass::Auth
    );
    assert_eq!(
        classify_publish_error(&PublishFailure::new(
            "auth_circuit_open: test_platform has a failing credential"
        )),
        PublishErrorClass::Transient
    );
}

#[test]
fn next_retry_honours_and_caps_a_provider_delay() {
    let now = parse_iso_instant("2026-01-01T00:00:00.000Z").unwrap().as_millisecond();
    assert_eq!(
        next_retry_at(1, 60, 3600, now, Some(45.0), &Half),
        "2026-01-01T00:00:45.000Z"
    );
    assert_eq!(
        next_retry_at(1, 60, 300, now, Some(10_000.0), &Half),
        "2026-01-01T00:05:00.000Z"
    );
}

// ------------------------------------------------------------ queue.test.ts

#[test]
fn a_stale_worker_cannot_fail_a_job_another_worker_claimed() {
    let world = World::new();
    let id = world.enqueue("post:90", "telegram", json!({ "text": "Queued" }));
    assert_eq!(world.claim("active-worker"), [id]);
    world
        .publishing()
        .fail_publish_job(id, &PublishFailure::http("server error", 503, None), "stale-worker")
        .unwrap();
    let (status, _, locked_by, _) = world.job(id);
    assert_eq!(
        (status.as_str(), locked_by.as_deref()),
        ("publishing", Some("active-worker"))
    );
    assert_eq!(world.recorder.entries(), ["ring"]);
}

#[test]
fn a_transient_failure_keeps_the_published_external_id() {
    let world = World::new();
    let id = world.enqueue("post:91", "telegram", json!({ "text": "Queued" }));
    world.claim("active-worker");
    world.sql("UPDATE publication_targets SET external_id = 'existing-id'");
    world
        .publishing()
        .fail_publish_job(id, &PublishFailure::http("server error", 503, None), "active-worker")
        .unwrap();
    let (status, attempts, ..) = world.job(id);
    assert_eq!((status.as_str(), attempts), ("queued", 1));
    assert_eq!(world.target("telegram"), ("queued".into(), Some("existing-id".into())));
}

#[test]
fn a_scheduled_job_is_claimed_only_once_due() {
    let world = World::new();
    let payload = new_delivery_payload(Map::new());
    let id = world.enqueue_payload("post:92", "telegram", &payload, Some("2026-03-01T11:00:00.000Z"));
    assert!(world.claim("w").is_empty());
    world.at("2026-03-01T11:00:00.000Z");
    assert_eq!(world.claim("w"), [id]);
}

#[test]
fn a_stale_lock_is_held_after_the_provider_and_requeued_before_it() {
    let world = World::new();
    let published = world.enqueue("post:103", "telegram", json!({ "text": "a" }));
    let verified = world.enqueue("post:103", "x", json!({ "text": "b" }));
    let prepared = world.enqueue("post:103", "discord", json!({ "text": "c" }));
    for (id, phase) in [
        (published, "provider.publish"),
        (verified, "provider.verify"),
        (prepared, "prepare"),
    ] {
        world.sql(&format!(
            "UPDATE publish_jobs SET status = 'publishing', current_phase = '{phase}', locked_by = 'old-worker', locked_at = '2000-01-01T00:00:00.000Z' WHERE job_id = {id}"
        ));
    }
    assert_eq!(world.publishing().recover_stale_publish_jobs(900).unwrap(), 3);
    assert_eq!(world.job(published).0, "verification_required");
    assert_eq!(world.job(verified).0, "verification_required");
    assert_eq!(world.job(prepared).0, "queued");
    assert_eq!(world.job(published).2, None);
    assert_eq!(world.target("telegram").0, "verification_required");
    assert_eq!(
        world.text("SELECT current_phase FROM publish_jobs WHERE job_id = 3"),
        None
    );
}

#[test]
fn a_stale_worker_cannot_overwrite_a_recovered_job() {
    let world = World::new();
    let id = world.enqueue("post:104", "telegram", json!({ "text": "a" }));
    world.claim("old-worker");
    world.sql("UPDATE publish_jobs SET current_phase = 'provider.publish', locked_at = '2000-01-01T00:00:00.000Z'");
    world.publishing().recover_stale_publish_jobs(900).unwrap();
    world.complete(id, json!({ "ok": true, "id": "late" }), "old-worker", None);
    assert_eq!(world.job(id).0, "verification_required");
}

#[test]
fn a_retryable_result_with_an_external_id_goes_to_reconciliation_never_back_to_the_queue() {
    let world = World::new();
    let id = world.enqueue("post:106", "x", json!({ "text": "Queued" }));
    world.claim("test-worker");
    world.complete(
        id,
        json!({ "ok": false, "id": "at://root", "retryable": true, "error": "test_visibility_failed:not_in_author_feed" }),
        "test-worker",
        None,
    );
    let (status, _, _, payload) = world.job(id);
    assert_eq!(status, "verification_required");
    assert!(!payload.contains_key("_reconcile_ids"));
    assert_eq!(
        world.target("x"),
        ("verification_required".into(), Some("at://root".into()))
    );
    // Neither retry path may put it in front of the audience again.
    let source = || world.publishing().publication_source_from_db(106);
    for (from, reached) in [
        (&["failed"][..], AudienceReached::Resume),
        (&RETRY_UNLESS_HELD[..], AudienceReached::Republish),
    ] {
        let results = world
            .publishing()
            .requeue_publication_targets(
                &scope(106),
                &["x"],
                &RequeueOptions {
                    from,
                    create_missing: false,
                    audience_reached: reached,
                    source: &source,
                },
            )
            .unwrap();
        assert_eq!(results[0].outcome, RequeueOutcome::NotRetryable);
    }
    assert!(world.claim("w").is_empty());
}

#[test]
fn deferred_provider_state_spends_no_attempt_and_rings_when_due() {
    let world = World::new();
    let id = world.enqueue("post:107", "instagram_stories_ru", json!({ "text": "Story" }));
    world.claim("test-worker");
    world.complete(
        id,
        json!({
            "deferred": true, "progressKey": "instagramStoryProgress",
            "progressValue": { "stage": "processing", "containerId": "container-1", "polls": 0 },
            "retryAfterMs": 250, "state": "processing",
        }),
        "test-worker",
        None,
    );
    let (status, attempts, _, payload) = world.job(id);
    assert_eq!((status.as_str(), attempts), ("queued", 0));
    assert_eq!(payload["instagramStoryProgress"]["containerId"], "container-1");
    assert_eq!(
        world.text("SELECT next_attempt_at FROM publish_jobs").as_deref(),
        Some("2026-03-01T10:00:00.250Z")
    );
    assert_eq!(world.recorder.entries(), ["ring", "ring after 250"]);
}

#[test]
fn in_flight_progress_is_not_resume_state_until_something_reaches_the_audience() {
    let world = World::new();
    let id = world.enqueue("post:108", "threads_ru", json!({ "text": "Chain" }));
    world.claim("w");
    world.complete(
        id,
        json!({ "deferred": true, "progressKey": "threadsProgress", "progressValue": { "stage": "wait_primary" }, "retryAfterMs": 0 }),
        "w",
        None,
    );
    assert!(!has_resume_state(&world.job(id).3));
    world.claim("w");
    world.complete(
        id,
        json!({
            "deferred": true, "progressKey": "threadsProgress", "progressValue": { "stage": "create_reply" },
            "resumeKey": "_threadsPublishedIds", "resumeValue": ["root-1"], "retryAfterMs": 0,
        }),
        "w",
        None,
    );
    assert_eq!(world.job(id).3["_threadsPublishedIds"], json!(["root-1"]));
    assert!(has_resume_state(&world.job(id).3));
}

#[test]
fn in_flight_progress_cannot_be_filed_as_resume_state() {
    let world = World::new();
    let id = world.enqueue("post:109", "threads_ru", json!({ "text": "Chain" }));
    world.claim("w");
    let error = world
        .publishing()
        .complete_publish_job(
            id,
            json!({ "deferred": true, "progressKey": "_threadsProgress", "progressValue": {}, "retryAfterMs": 0 })
                .as_object()
                .unwrap(),
            "w",
            None,
        )
        .unwrap_err();
    assert!(error.to_string().contains("claims to be resume state"), "{error}");
    assert!(deferred_delivery_payload(&Map::new(), "progress", json!(1), Some(("plain", json!([])))).is_err());
}

#[test]
fn a_job_naming_a_live_post_with_nothing_to_continue_from_is_refused_at_the_claim() {
    let world = World::new();
    world.sql(&format!(
        "INSERT INTO publication_targets (publication_key, target, status, external_id, updated_at) VALUES ('post:110', 'threads_ru', 'published', 'live-1', '{T0}')"
    ));
    let id = world.enqueue("post:110", "threads_ru", json!({ "text": "again" }));
    assert!(world.claim("w").is_empty());
    let (status, ..) = world.job(id);
    assert_eq!(status, "verification_required");
    assert!(
        world
            .text("SELECT last_error FROM publish_jobs")
            .unwrap()
            .starts_with("duplicate_refused")
    );
    // The same job, carrying what it already published, is delivered.
    world.sql("DELETE FROM publish_jobs");
    let payload = resumed_delivery_payload(&Map::new(), "_threadsPublishedIds", json!(["live-1"]));
    let id = world.enqueue_payload("post:110", "threads_ru", &payload, None);
    assert_eq!(world.claim("w"), [id]);
}

#[test]
fn a_partial_publication_stops_early_once_the_platform_answers_and_waits_otherwise() {
    let refusal = || json!({ "ok": false, "partial": true, "resumeKey": "_threadsPublishedIds", "ids": ["root-id"], "error": "reply refused" });
    // Something else published on the target since this attempt.
    let world = World::new();
    let id = world.enqueue("post:111", "threads_ru", json!({ "text": "chain" }));
    world.claim("w");
    world.complete(id, refusal(), "w", None);
    assert_eq!(world.job(id).0, "queued");
    world.sql(&format!(
        "INSERT INTO publication_targets (publication_key, target, status, published_at, updated_at) VALUES ('post:999', 'threads_ru', 'published', '2026-03-01T11:00:01.000Z', '{T0}')"
    ));
    world.at("2026-03-01T11:00:00.000Z");
    world.claim("w");
    world.complete(id, refusal(), "w", None);
    let (status, _, _, payload) = world.job(id);
    assert_eq!(status, "failed");
    assert!(
        world
            .text("SELECT last_error FROM publish_jobs")
            .unwrap()
            .contains("stopped early")
    );
    assert_eq!(payload["_threadsPublishedIds"], json!(["root-id"]));

    // The provider answered after this attempt started.
    let world = World::new();
    let id = world.enqueue("post:112", "threads_ru", json!({ "text": "chain" }));
    world.claim("w");
    world.complete(id, refusal(), "w", None);
    world.at("2026-03-01T11:00:00.000Z");
    world.claim("w");
    world.complete(id, refusal(), "w", Some("2026-03-01T11:00:01.000Z"));
    assert_eq!(world.job(id).0, "failed");

    // An answer older than this attempt says nothing about the platform now.
    let world = World::new();
    let id = world.enqueue("post:113", "threads_ru", json!({ "text": "chain" }));
    world.claim("w");
    world.complete(id, refusal(), "w", Some("2026-03-01T09:00:00.000Z"));
    let (status, attempts, ..) = world.job(id);
    assert_eq!((status.as_str(), attempts), ("queued", 1));
    assert_eq!(world.target("threads_ru"), ("queued".into(), Some("root-id".into())));
}

#[test]
fn a_partial_publication_keeps_finishing_past_the_ordinary_budget() {
    let world = World::new();
    let id = world.enqueue("post:114", "threads_ru", json!({ "text": "chain" }));
    let attempt = || {
        world.sql("UPDATE publish_jobs SET next_attempt_at = NULL");
        world.claim("w");
        world.complete(
            id,
            json!({ "ok": false, "partial": true, "resumeKey": "_threadsPublishedIds", "ids": ["root-id"] }),
            "w",
            None,
        );
        world.job(id).0
    };
    for _ in 0..PUBLISH_PARTIAL_MAX_ATTEMPTS - 1 {
        assert_eq!(attempt(), "queued");
    }
    const { assert!(PUBLISH_PARTIAL_MAX_ATTEMPTS > PUBLISH_MAX_ATTEMPTS) };
    assert_eq!(attempt(), "failed");
}

#[test]
fn a_settlement_whose_lease_was_taken_mid_flight_updates_nothing_and_rolls_back() {
    let world = World::new();
    world.sql(&format!(
        "INSERT INTO publish_jobs (publication_key, target, status, payload_json, created_at, updated_at) VALUES ('post:115', 'telegram', 'failed', '{{}}', '{T0}', '{T0}')"
    ));
    let id = world.enqueue("post:115", "telegram", json!({ "text": "a" }));
    world.claim("w1");
    // Another worker takes the job between the superseded-row cleanup and the
    // fenced write: the write matches no row, and the cleanup is undone with it.
    world.sql("CREATE TRIGGER steal AFTER DELETE ON publish_jobs BEGIN UPDATE publish_jobs SET locked_by = 'w2' WHERE status = 'publishing'; END");
    let events_before = world.int("SELECT count(*) FROM publication_events");
    world
        .publishing()
        .fail_publish_job(id, &PublishFailure::http("server error", 503, None), "w1")
        .unwrap();
    assert_eq!(world.int("SELECT count(*) FROM publish_jobs"), 2);
    assert_eq!(world.job(id).0, "publishing");
    assert_eq!(world.job(id).2.as_deref(), Some("w1"));
    assert_eq!(world.int("SELECT count(*) FROM publication_events"), events_before);
    assert_eq!(world.target("telegram").0, "publishing");
}

#[test]
fn an_auth_refusal_reaches_the_credential_breaker() {
    let world = World::new();
    let id = world.enqueue("post:116", "x", json!({ "text": "a" }));
    world.claim("w");
    world
        .publishing()
        .fail_publish_job(id, &PublishFailure::http("nope", 401, None), "w")
        .unwrap();
    assert_eq!(world.recorder.entries(), ["ring", "auth failure x"]);
    let id = world.enqueue("post:117", "x", json!({ "text": "b" }));
    world.claim("w");
    world.complete(id, json!({ "ok": true, "id": "x-1" }), "w", None);
    assert!(world.recorder.entries().contains(&"auth success x".to_owned()));
}

// ------------------------------------------------------------ deliveryCancellation.test.ts

fn seed_publication(world: &World, draft_id: i64, post_id: i64) -> String {
    world.sql(&format!(
        "INSERT INTO drafts (id, actor_id, status, targets_json, post_id, created_at, updated_at) VALUES ({draft_id}, 42, 'scheduled', '{{}}', {post_id}, '{T0}', '{T0}')"
    ));
    format!("post:{post_id}")
}

#[test]
fn cancelling_stops_a_queued_target_and_the_worker_refuses_it_afterwards() {
    let world = World::new();
    let key = seed_publication(&world, 1, 1);
    world.enqueue(&key, "telegram", json!({ "text": "hi" }));
    let report = world.publishing().cancel_remaining_delivery(1, 42).unwrap();
    assert_eq!(
        (report.stopped, report.finishing),
        (vec!["telegram".to_owned()], vec![])
    );
    assert!(world.claim("w").is_empty());
    assert_eq!(world.job(1).0, "cancelled");
}

#[test]
fn a_cancellation_arriving_late_is_enforced_by_the_claim() {
    let world = World::new();
    let key = seed_publication(&world, 2, 2);
    let id = world.enqueue(&key, "threads_ru", json!({ "text": "hi" }));
    world.sql(&format!(
        "INSERT INTO publication_cancellations (publication_key, actor_id, requested_at) VALUES ('{key}', 42, '{T0}')"
    ));
    assert!(world.claim("w").is_empty());
    assert_eq!(world.job(id).0, "cancelled");
}

#[test]
fn a_chain_that_published_part_of_itself_is_finished() {
    let world = World::new();
    let key = seed_publication(&world, 3, 3);
    let payload = resumed_delivery_payload(
        json!({ "text": "hi" }).as_object().unwrap(),
        "_threadsPublishedIds",
        json!(["17841"]),
    );
    world.enqueue_payload(&key, "threads_ru", &payload, None);
    let report = world.publishing().cancel_remaining_delivery(3, 42).unwrap();
    assert_eq!(
        (report.stopped, report.finishing),
        (vec![], vec!["threads_ru".to_owned()])
    );
    assert_eq!(world.job(1).0, "queued");
    assert_eq!(world.claim("w"), [1]);
}

#[test]
fn the_targets_a_cancellation_would_stop_are_named_first() {
    let world = World::new();
    let key = seed_publication(&world, 4, 4);
    world.enqueue(&key, "telegram", json!({ "text": "hi" }));
    let payload = resumed_delivery_payload(
        json!({ "text": "hi" }).as_object().unwrap(),
        "_threadsPublishedIds",
        json!(["1"]),
    );
    world.enqueue_payload(&key, "threads_en", &payload, None);
    let pending: Vec<(String, bool)> = world
        .publishing()
        .pending_delivery_targets(4)
        .unwrap()
        .into_iter()
        .map(|pending| (pending.target, pending.started))
        .collect();
    assert_eq!(
        pending,
        [("telegram".to_owned(), false), ("threads_en".to_owned(), true)]
    );
}

// ------------------------------------------------------------ postRecoveryScenario.test.ts

#[test]
fn failed_targets_are_retried_once_and_leave_no_duplicate_queue_rows() {
    let world = World::new();
    world.seed_post(
        7,
        700,
        r#"{"telegram":true,"threads_ru":true}"#,
        "Ночной пост",
        "Night post",
    );
    for target in ["telegram", "threads_ru"] {
        world.enqueue("post:700", target, json!({ "text": "Night post" }));
    }
    let claimed = world.claim("scenario-worker");
    assert_eq!(claimed.len(), 2);
    for id in claimed {
        world
            .publishing()
            .fail_publish_job(
                id,
                &PublishFailure::http("Provider rejected the post", 400, None),
                "scenario-worker",
            )
            .unwrap();
    }
    let source = || world.publishing().publication_source_from_db(700);
    let retry = || {
        world
            .publishing()
            .requeue_publication_targets(
                &scope(700),
                &["telegram", "threads_ru"],
                &RequeueOptions {
                    from: &["failed"],
                    create_missing: false,
                    audience_reached: AudienceReached::Resume,
                    source: &source,
                },
            )
            .unwrap()
    };
    assert!(retry().iter().all(|result| result.outcome == RequeueOutcome::Requeued));
    assert_eq!(
        world.int("SELECT count(*) FROM publish_jobs WHERE status = 'queued'"),
        2
    );
    assert_eq!(world.int("SELECT count(*) FROM publish_jobs"), 2);
    assert_eq!(
        world.int("SELECT count(*) FROM publication_targets WHERE status = 'queued'"),
        2
    );
    assert!(
        retry()
            .iter()
            .all(|result| result.outcome == RequeueOutcome::AlreadyQueued)
    );
    assert_eq!(world.int("SELECT count(*) FROM publish_jobs"), 2);
}

// ------------------------------------------------------------ postRetry.test.ts

#[test]
fn a_retry_requeues_failed_targets_but_not_ambiguous_ones() {
    let world = World::new();
    world.seed_post(
        7,
        700,
        r#"{"telegram":true,"site_en":true}"#,
        "Пост для повтора",
        "Retryable post",
    );
    world.sql(&format!(
        "INSERT INTO publish_jobs (publication_key, target, status, payload_json, attempt_count, last_error, created_at, updated_at) VALUES
           ('post:700', 'telegram', 'failed', '{{\"text\":\"Retryable post\"}}', 4, 'Telegram timed out', '{T0}', '{T0}'),
           ('post:700', 'threads_en', 'verification_required', '{{\"text\":\"Retryable post\"}}', 1, 'ambiguous', '{T0}', '{T0}');
         INSERT INTO site_jobs (publication_key, reason, status, attempt_count, last_error, created_at, updated_at) VALUES
           ('post:700', 'site_en', 'verification_required', 2, 'Site verification expired', '{T0}', '{T0}');"
    ));
    let source = || world.publishing().publication_source_from_db(700);
    let results = world
        .publishing()
        .requeue_publication_targets(
            &scope(700),
            &["threads_en", "telegram", "site_en"],
            &RequeueOptions {
                from: &["failed"],
                create_missing: false,
                audience_reached: AudienceReached::Resume,
                source: &source,
            },
        )
        .unwrap();
    let outcomes: Vec<RequeueOutcome> = results.iter().map(|result| result.outcome).collect();
    assert_eq!(
        outcomes,
        [
            RequeueOutcome::NotRetryable,
            RequeueOutcome::Requeued,
            RequeueOutcome::Requeued
        ]
    );
    assert_eq!(
        world
            .text("SELECT status FROM publish_jobs WHERE target = 'threads_en'")
            .unwrap(),
        "verification_required"
    );
    assert_eq!(
        world.int("SELECT attempt_count FROM publish_jobs WHERE target = 'telegram'"),
        0
    );
    assert_eq!(world.text("SELECT status FROM site_jobs").unwrap(), "queued");
    assert_eq!(world.text("SELECT status FROM drafts").unwrap(), "scheduled");
}

#[test]
fn a_retry_carries_what_a_half_published_chain_delivered_and_refuses_when_nothing_says_so() {
    let world = World::new();
    world.seed_post(9, 900, r#"{"threads_ru":true}"#, "Тред", "Thread");
    world.sql(&format!(
        "INSERT INTO publish_jobs (publication_key, target, status, payload_json, created_at, updated_at) VALUES ('post:900', 'threads_ru', 'failed', '{{\"text\":\"Тред\",\"_threadsPublishedIds\":[\"root\"]}}', '{T0}', '{T0}');
         INSERT INTO publication_targets (publication_key, target, status, external_id, updated_at) VALUES ('post:900', 'threads_ru', 'failed', 'root', '{T0}');"
    ));
    let source = || world.publishing().publication_source_from_db(900);
    let options = |reached| RequeueOptions {
        from: &["failed"],
        create_missing: false,
        audience_reached: reached,
        source: &source,
    };
    let requeue = |reached| {
        world
            .publishing()
            .requeue_publication_targets(&scope(900), &["threads_ru"], &options(reached))
            .unwrap()
    };
    assert_eq!(requeue(AudienceReached::Resume)[0].outcome, RequeueOutcome::Requeued);
    let (_, _, _, payload) = world.job(1);
    assert_eq!(payload["_threadsPublishedIds"], json!(["root"]));
    assert_eq!(payload["locale"], "ru");
    // A continued delivery keeps naming its live post, and journals no loss.
    assert_eq!(world.target("threads_ru"), ("queued".into(), Some("root".into())));
    assert_eq!(
        world.int("SELECT count(*) FROM publication_events WHERE event_type = 'publish.target.identity_dropped'"),
        0
    );

    // The same live post with no ids on the job: a button may not repeat it,
    // an operator republishing may — and the journal keeps the dropped id.
    world.sql("UPDATE publish_jobs SET status = 'failed', payload_json = '{}'");
    let refused = requeue(AudienceReached::Resume);
    assert_eq!(refused[0].outcome, RequeueOutcome::NotRetryable);
    assert_eq!(
        refused[0].reason.map(|reason| reason.as_str()),
        Some("already_delivered")
    );
    assert_eq!(requeue(AudienceReached::Republish)[0].outcome, RequeueOutcome::Requeued);
    assert!(!has_resume_state(&world.job(1).3));
    assert_eq!(world.target("threads_ru"), ("queued".into(), None));
    assert_eq!(
        world.text("SELECT details_json FROM publication_events WHERE event_type = 'publish.target.identity_dropped'"),
        Some(r#"{"external_id":"root","url":null}"#.into())
    );
}

#[test]
fn an_abandoned_target_is_taken_down_with_its_journal_in_one_transaction() {
    let world = World::new();
    world.seed_post(10, 1000, r#"{"telegram":true,"x":true}"#, "Пост", "Post");
    let telegram = world.enqueue("post:1000", "telegram", json!({ "text": "Пост" }));
    let x = world.enqueue("post:1000", "x", json!({ "text": "Post" }));
    world.claim("w");
    for id in [telegram, x] {
        world
            .publishing()
            .fail_publish_job(id, &PublishFailure::http("bad request", 400, None), "w")
            .unwrap();
    }
    // A journal entry that cannot be written takes the whole takedown with it.
    world.sql("CREATE TRIGGER refuse BEFORE INSERT ON publication_events WHEN NEW.event_type = 'publish.target.abandoned' AND NEW.target = 'x' BEGIN SELECT RAISE(ABORT, 'journal refused'); END");
    assert!(
        world
            .publishing()
            .abandon_publication_targets(&scope(1000), &["telegram", "x"])
            .is_err()
    );
    assert_eq!(world.job(telegram).0, "failed");
    assert_eq!(
        world.int("SELECT count(*) FROM publication_events WHERE event_type = 'publish.target.abandoned'"),
        0
    );
    world.sql("DROP TRIGGER refuse");
    let results = world
        .publishing()
        .abandon_publication_targets(&scope(1000), &["telegram", "x"])
        .unwrap();
    assert!(results.iter().all(|result| result.outcome == AbandonOutcome::Abandoned));
    world.publishing().refresh_publication_status(1000).unwrap();
    assert_eq!(world.text("SELECT status FROM drafts").unwrap(), "cancelled");
    // Putting it back is a requeue, journalled with it.
    let source = || world.publishing().publication_source_from_db(1000);
    let back = world
        .publishing()
        .requeue_publication_targets(
            &scope(1000),
            &["telegram"],
            &RequeueOptions {
                from: &RETRY_UNLESS_HELD,
                create_missing: false,
                audience_reached: AudienceReached::Republish,
                source: &source,
            },
        )
        .unwrap();
    assert_eq!(back[0].outcome, RequeueOutcome::Requeued);
    assert_eq!(world.job(telegram).0, "queued");
}

// ------------------------------------------------------------ replanUnfinished.test.ts

#[test]
fn replanning_leaves_a_half_delivered_target_on_its_job() {
    let world = World::new();
    world.connect(&["threads_ru"]);
    world.sql(&format!(
        "INSERT INTO drafts (id, actor_id, status, targets_json, created_at, updated_at) VALUES (12, 42, 'needs_review', '{{\"threads_ru\":true}}', '{T0}', '{T0}');
         INSERT INTO post_locales (draft_id, locale, source_text, updated_at) VALUES (12, 'ru', 'Часть один', '{T0}'), (12, 'en', '', '{T0}');"
    ));
    let post_id = world
        .publishing()
        .publish_draft_to_queue(
            12,
            PublishDraftOptions {
                mode: Some(PublishMode::Scheduled),
                ru_at: Some(parse_iso_instant("2026-03-01T11:00:00.000Z").unwrap()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        world
            .recorder
            .entries()
            .contains(&"usage publishing.plan.create true".to_owned())
    );
    world.sql(&format!(
        "UPDATE publish_jobs SET payload_json = '{{\"text\":\"Часть один\",\"_threadsPublishedIds\":[\"18027986108896341\"]}}', attempt_count = 2;
         INSERT INTO publication_targets (publication_key, target, status, external_id, updated_at) VALUES ('post:{post_id}', 'threads_ru', 'queued', '18027986108896341', '{T0}');"
    ));
    let job_id = world.int("SELECT job_id FROM publish_jobs");
    let draft = DraftStore::new(unsafe_db(&world.db), &world.clock)
        .get(12)
        .unwrap()
        .unwrap();
    world.at("2026-03-01T10:05:00.000Z");
    assert!(
        world
            .publishing()
            .mutate_scheduled_draft(
                &draft,
                &ScheduledDraftMutation {
                    patch: DraftPatch {
                        text_ru: Some("Часть один, исправленная".into()),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )
            .unwrap()
    );
    assert_eq!(world.int("SELECT count(*) FROM publish_jobs"), 1);
    assert_eq!(world.int("SELECT job_id FROM publish_jobs"), job_id);
    assert_eq!(
        world.job(job_id).3["_threadsPublishedIds"],
        json!(["18027986108896341"])
    );
    // The draft moved on: a mutation fenced on the revision it read no longer lands.
    assert!(
        !world
            .publishing()
            .mutate_scheduled_draft(&draft, &ScheduledDraftMutation::default())
            .unwrap()
    );
}

// ------------------------------------------------------------ schedule.test.ts

#[test]
fn manual_times_and_slot_clocks_resolve_in_the_studio_zone() {
    let moscow = Zone::parse("Europe/Moscow").unwrap();
    let now = parse_iso_instant("2026-07-10T15:00:00.000Z").unwrap();
    let parsed = |input: &str| {
        parse_manual_schedule(input, &moscow, now)
            .map(to_iso_string)
            .map_err(|error| error.code)
    };
    assert_eq!(parsed("21:15"), Ok("2026-07-10T18:15:00.000Z".into()));
    assert_eq!(parsed("09:00"), Ok("2026-07-11T06:00:00.000Z".into()));
    assert_eq!(parsed("12.07 10:30"), Ok("2026-07-12T07:30:00.000Z".into()));
    assert_eq!(parsed("09.07 10:30"), Err("err.schedule-date-past".into()));
    assert_eq!(parsed("10.08 10:30"), Err("err.schedule-too-far".into()));
    assert_eq!(parsed("25:00"), Err("common.schedule-parse-error".into()));
    assert_eq!(parsed("31.02 10:00"), Err("common.schedule-parse-error".into()));
    assert_eq!(parsed("01.01.2020 10:00"), Err("err.schedule-time-past".into()));
    let slot = |clock: &str| to_iso_string(publication_slot_time(clock, &moscow, now).unwrap());
    assert_eq!(slot("21:00"), "2026-07-10T18:00:00.000Z");
    assert_eq!(slot("10:00"), "2026-07-11T07:00:00.000Z");
}

#[test]
fn wall_clock_times_resolve_on_both_sides_of_dst() {
    let zone = Zone::parse("America/New_York").unwrap();
    let spring = parse_iso_instant("2026-03-07T12:00:00.000Z").unwrap();
    let parsed = |input: &str, now: Timestamp| {
        parse_manual_schedule(input, &zone, now)
            .map(to_iso_string)
            .map_err(|error| error.code)
    };
    assert_eq!(parsed("08.03 01:30", spring), Ok("2026-03-08T06:30:00.000Z".into()));
    assert_eq!(parsed("08.03 03:30", spring), Ok("2026-03-08T07:30:00.000Z".into()));
    assert_eq!(
        to_iso_string(
            publication_slot_time("01:30", &zone, parse_iso_instant("2026-03-07T08:00:00.000Z").unwrap()).unwrap()
        ),
        "2026-03-08T06:30:00.000Z"
    );
    // A wall clock that occurs twice resolves to its first occurrence.
    let fall = parse_iso_instant("2026-10-31T12:00:00.000Z").unwrap();
    assert_eq!(parsed("01.11 01:30", fall), Ok("2026-11-01T05:30:00.000Z".into()));
    assert_eq!(parsed("08.03 02:30", spring), Err("common.schedule-parse-error".into()));
}

// ------------------------------------------------------------ videoRescheduleGuard.test.ts

fn video_world() -> World {
    let world = World::new();
    world.sql(&format!(
        "INSERT INTO channel_connections (id, platform, locale, provider, label, created_at, updated_at) VALUES ('youtube:ru', 'youtube', 'ru', 'native', 'YouTube RU', '{T0}', '{T0}');
         INSERT INTO studio_media_assets (id, actor_id, kind, mime_type, filename, local_path, byte_size, sha256, source, created_at) VALUES (1, 42, 'video', 'video/mp4', 'v.mp4', '/nowhere/v.mp4', 1, 'sha', 'upload', '{T0}');"
    ));
    world
        .publishing()
        .create_video_draft(42, 1, 24, content::Locale::Ru)
        .unwrap();
    world
        .publishing()
        .replace_video_targets(1, &["youtube_shorts"])
        .unwrap();
    world
}

fn in_an_hour() -> Vec<(VideoTarget, Timestamp)> {
    vec![(
        VideoTarget::YoutubeShorts,
        parse_iso_instant("2026-03-01T11:00:00.000Z").unwrap(),
    )]
}

#[test]
fn a_platform_that_already_published_is_never_rescheduled() {
    let world = video_world();
    world.sql("UPDATE video_targets SET status = 'published'");
    let error = world
        .publishing()
        .schedule_video(1, &in_an_hour(), 10, Some(24.0))
        .unwrap_err();
    assert_eq!(error.to_string(), "err.video-target-not-schedulable");
    assert_eq!(world.text("SELECT status FROM video_targets").unwrap(), "published");
    assert_eq!(world.int("SELECT count(*) FROM video_jobs"), 0);
}

#[test]
fn an_undelivered_platform_is_scheduled_with_a_prepare_and_publish_pair() {
    let world = video_world();
    world
        .publishing()
        .schedule_video(1, &in_an_hour(), 10, Some(24.0))
        .unwrap();
    assert_eq!(world.text("SELECT status FROM video_targets").unwrap(), "scheduled");
    assert_eq!(
        world.text(
            "SELECT group_concat(kind || '@' || run_at, ' ') FROM (SELECT kind, run_at FROM video_jobs ORDER BY kind)"
        ),
        Some("prepare@2026-03-01T10:50:00.000Z publish@2026-03-01T11:00:00.000Z".into())
    );
    assert_eq!(
        world.text("SELECT metadata_json FROM video_targets").as_deref(),
        Some(r#"{"videoDurationMs":24000}"#)
    );
}

#[test]
fn metadata_stays_editable_while_waiting_and_locks_once_preparation_starts() {
    let world = video_world();
    world.publishing().schedule_video(1, &in_an_hour(), 10, None).unwrap();
    let metadata = json!({ "title": "Changed", "description": "", "tags": [] });
    world
        .publishing()
        .save_video_metadata(1, VideoTarget::YoutubeShorts, metadata.as_object().unwrap())
        .unwrap();
    world.publishing().update_video_label(1, "Changed").unwrap();
    assert_eq!(
        world.text("SELECT metadata_json FROM video_targets").as_deref(),
        Some(r#"{"title":"Changed","description":"","tags":[]}"#)
    );
    world.sql("UPDATE video_targets SET status = 'prepared'");
    let error = world
        .publishing()
        .save_video_metadata(1, VideoTarget::YoutubeShorts, metadata.as_object().unwrap())
        .unwrap_err();
    assert_eq!(error.to_string(), "err.video-metadata-locked");
}

// ------------------------------------------------------------ video boundaries

struct Provider(ProviderOutcome, RefCell<Vec<String>>);

impl VideoProvider for Provider {
    async fn post_outcome(&self, provider_post_id: &str, platform: &str) -> domain::Result<ProviderOutcome> {
        self.1
            .borrow_mut()
            .push(format!("outcome {provider_post_id} {platform}"));
        Ok(self.0.clone())
    }
    async fn publish_instagram_reel(
        &self,
        account_id: &str,
        public_url: &str,
        _: &Value,
        request_id: &str,
    ) -> domain::Result<ProviderOutcome> {
        self.1
            .borrow_mut()
            .push(format!("publish {account_id} {public_url} {request_id}"));
        Ok(self.0.clone())
    }
}

#[test]
fn a_provider_held_reel_is_asked_about_before_a_retry_repeats_it() {
    let world = World::new();
    world.sql(&format!(
        "INSERT INTO channel_connections (id, platform, locale, provider, provider_account_id, label, created_at, updated_at) VALUES ('instagram:ru', 'instagram', 'ru', 'zernio', 'acc-1', 'IG', '{T0}', '{T0}');
         INSERT INTO studio_media_assets (id, actor_id, kind, mime_type, filename, local_path, byte_size, sha256, source, created_at) VALUES (1, 42, 'video', 'video/mp4', 'v.mp4', '/nowhere/v.mp4', 1, 'sha256digest', 'upload', '{T0}');"
    ));
    let publishing = world.publishing();
    publishing.create_video_draft(42, 1, 24, content::Locale::Ru).unwrap();
    publishing.replace_video_targets(1, &["instagram_reels"]).unwrap();
    publishing
        .schedule_video(
            1,
            &[(
                VideoTarget::InstagramReels,
                parse_iso_instant("2026-03-01T11:00:00.000Z").unwrap(),
            )],
            10,
            None,
        )
        .unwrap();
    let config = foundation::config::load_config([("PUBLIC_BASE_URL", "https://studio.example/")]).unwrap();
    // The provider says the "failed" Reel is live: the retry settles it and
    // arms nothing.
    world.sql("UPDATE video_targets SET status = 'failed', provider_post_id = 'zp-1'");
    let live = Provider(
        ProviderOutcome {
            provider_post_id: Some("zp-1".into()),
            external_id: Some("ig-1".into()),
            url: Some("https://instagram.com/reel/1".into()),
            failure: None,
        },
        RefCell::default(),
    );
    let retry = ready(publishing.retry_video_target(&config, &live, 1, VideoTarget::InstagramReels)).unwrap();
    assert_eq!(retry.settled.as_deref(), Some("published"));
    assert_eq!(live.1.borrow().as_slice(), ["outcome zp-1 instagram"]);
    assert_eq!(world.text("SELECT status FROM video_targets").unwrap(), "published");
    assert_eq!(world.recorder.entries(), ["video completion 1"]);

    // With no post id on record, the provider is asked under the job's fence.
    world.sql("UPDATE video_targets SET status = 'verification_required', provider_post_id = NULL, external_id = NULL, external_url = NULL");
    let pending = Provider(
        ProviderOutcome {
            provider_post_id: Some("zp-2".into()),
            external_id: None,
            url: None,
            failure: Some("ignored for a publish".into()),
        },
        RefCell::default(),
    );
    let settled = ready(publishing.settle_video_target(
        &config,
        &pending,
        &SettleVideoInput {
            video_draft_id: 1,
            target: "instagram_reels",
            apply: true,
            known: None,
        },
    ))
    .unwrap();
    assert_eq!(settled["status"], "verification_required");
    assert_eq!(
        pending.1.borrow().as_slice(),
        ["publish acc-1 https://studio.example/media/video/asset/sha256digest video-job:2:2026-03-01T11:00:00.000Z"]
    );
}

struct Probe(
    std::result::Result<MediaMetadata, String>,
    std::result::Result<String, String>,
);

impl MediaProbe for Probe {
    async fn probe(&self, _: &str) -> std::result::Result<MediaMetadata, String> {
        self.0.clone()
    }
    async fn audio_stats(&self, _: &str) -> std::result::Result<String, String> {
        self.1.clone()
    }
}

#[test]
fn a_video_source_is_checked_through_the_media_probe() {
    let dir = support::repo_root().join("_trash-rust/tmp/publishing-probe");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("clip.mp4");
    std::fs::write(&file, b"not really a video").unwrap();
    let metadata = MediaMetadata {
        width: 1080.0,
        height: 1920.0,
        duration_seconds: 41.6,
        video_codec: "h264".into(),
        audio_codec: Some("aac".into()),
        fps: 30.0,
    };
    let quiet = "lavfi.astats.Overall.RMS_trough=-70.5\nlavfi.astats.Overall.Noise_floor=-80\n".to_owned();
    let check = ready(validate_video_source(
        &Probe(Ok(metadata.clone()), Ok(quiet)),
        file.to_str().unwrap(),
    ))
    .unwrap();
    assert_eq!((check.seconds, check.aspect_ok, check.size_bytes), (42.0, true, 18));
    assert!(check.background_music_likely_missing);
    let loud = ready(validate_video_source(
        &Probe(Ok(metadata), Err("ffmpeg failed".into())),
        file.to_str().unwrap(),
    ))
    .unwrap();
    assert!(!loud.background_music_likely_missing);
    let missing = ready(validate_video_source(
        &Probe(
            Err("media_probe_failed: ffprobe did not find a video stream".into()),
            Ok(String::new()),
        ),
        file.to_str().unwrap(),
    ))
    .unwrap_err();
    assert_eq!(missing.to_string(), "err.no-video-stream");
    let wrong = ready(validate_video_source(
        &Probe(Err(String::new()), Ok(String::new())),
        "/tmp/clip.mov",
    ))
    .unwrap_err();
    assert_eq!(wrong.to_string(), "err.need-mp4");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A stored schedule that is no instant refuses the whole scheduling, as the
/// TypeScript `new Date(NaN).toISOString()` does, and arms nothing.
#[test]
fn an_unreadable_stored_schedule_refuses_scheduling() {
    let world = video_world();
    world.sql(&format!(
        "INSERT INTO video_targets (video_draft_id, target, metadata_json, scheduled_at, status, created_at, updated_at) VALUES (1, 'instagram_reels', '{{}}', '2026-13-45T99:99:99Z', 'editing', '{T0}', '{T0}')"
    ));
    let error = world
        .publishing()
        .schedule_video(1, &in_an_hour(), 10, None)
        .unwrap_err();
    assert_eq!(error.to_string(), "Invalid Date");
    assert_eq!(
        world
            .text("SELECT status FROM video_targets WHERE target = 'youtube_shorts'")
            .unwrap(),
        "editing"
    );
    assert_eq!(world.int("SELECT count(*) FROM video_jobs"), 0);
    assert_eq!(world.text("SELECT status FROM video_drafts").unwrap(), "editing");
}
