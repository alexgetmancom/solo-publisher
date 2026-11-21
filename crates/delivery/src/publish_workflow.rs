//! `delivery/publish-workflow.ts`: publishing jobs executed through the
//! delivery adapters, one lane per target, every phase authorised by a write
//! fenced on the job's lease.

use std::rc::Rc;
use std::time::Duration;

use adapters::social_ports::MediaPreparation;
use adapters::{AdapterError, DeliveryPorts, PreparedMedia, SocialAdapter, StoriesSidecar, create_platform_adapters};
use db::rusqlite::{OptionalExtension as _, params};
use domain::application::ports::{DomainEventInput, Severity};
use domain::observability::auth_circuit::{is_target_auth_blocked, provider_answered_at};
use domain::publishing::errors::{PublishFailure, PublishResult};
use domain::publishing::job_policy::may_have_reached_audience;
use domain::publishing::queue::{ClaimedPublishJob, PUBLISH_CLAIM_LIMIT};
use domain::repositories::record_event;
use foundation::config::{PUBLISH_HEARTBEAT_INTERVAL_SECONDS, PUBLISH_LOCK_TIMEOUT_SECONDS};
use foundation::logger::{LogLevel, log};
use futures_util::future::join_all;
use runtime::job_heartbeat::with_job_heartbeat;
use runtime::worker_state::record_worker_state;
use serde_json::{Map, Value, json};

use crate::routing::target_routing;
use crate::{Delivery, Result};

/// The adapters of one cycle (`createPlatformPorts(config, fetch,
/// targetRouting(db))`): routed by the registry as it stands now, with a
/// preparation cache of their own.
pub fn delivery_ports(
    delivery: &Delivery<'_>,
    media: Rc<dyn MediaPreparation>,
    stories: Rc<dyn StoriesSidecar>,
) -> Result<DeliveryPorts> {
    let routing = target_routing(delivery.sqlite())?;
    Ok(create_platform_adapters(
        delivery.adapters.clone(),
        Rc::new(PreparedMedia::new(media)),
        stories,
        &routing,
    ))
}

/// The publish-watchdog loop body (`recoverStalePublishJobs` at its default
/// age): a hung provider call must not keep a lock out of the retry policy.
pub fn recover_stale_publish_jobs(delivery: &Delivery<'_>) -> Result<usize> {
    delivery
        .publishing()
        .recover_stale_publish_jobs(PUBLISH_LOCK_TIMEOUT_SECONDS)
}

/// What one attempt came to before settlement.
enum Attempt {
    Published(PublishResult),
    Failed(AdapterError),
}

/// `runDeliveryPublishCycle`: the queue loop body. Returns how many jobs this
/// cycle claimed.
pub async fn run_delivery_publish_cycle(delivery: &Delivery<'_>, ports: &DeliveryPorts) -> Result<usize> {
    let publishing = delivery.publishing();
    publishing.recover_stale_publish_jobs(PUBLISH_LOCK_TIMEOUT_SECONDS)?;
    let candidates = publishing.due_publish_jobs(PUBLISH_CLAIM_LIMIT)?;
    // One lane per target: a hung target must not hold every slot while the
    // others wait. A target still runs its own jobs one at a time.
    let mut lanes: Vec<(String, Vec<(usize, i64)>)> = Vec::new();
    for (index, candidate) in candidates.into_iter().enumerate() {
        match lanes.iter_mut().find(|(target, _)| *target == candidate.target) {
            Some((_, jobs)) => jobs.push((index, candidate.job_id)),
            None => lanes.push((candidate.target, vec![(index, candidate.job_id)])),
        }
    }
    let mut claimed: Vec<(usize, ClaimedPublishJob)> = join_all(lanes.into_iter().map(|(_, jobs)| async move {
        let mut claimed = Vec::new();
        for (index, job_id) in jobs {
            let job = match delivery.publishing().claim_publish_job(job_id, None) {
                Ok(Some(job)) => job,
                Ok(None) => continue,
                Err(error) => {
                    log(
                        LogLevel::Error,
                        "publish job claim failed",
                        Some(json!({"jobId": job_id, "error": error.to_string()})),
                    );
                    continue;
                }
            };
            if let Err(error) = run_claimed(delivery, ports, &job).await {
                emergency_settlement(delivery, &job, &error.to_string(), None);
            }
            claimed.push((index, job));
        }
        claimed
    }))
    .await
    .into_iter()
    .flatten()
    .collect();
    claimed.sort_by_key(|(index, _)| *index);
    let claimed: Vec<ClaimedPublishJob> = claimed.into_iter().map(|(_, job)| job).collect();
    // The job carries the publication's own ref: rebuilding one would journal
    // an article's settlement against a post that does not exist.
    let mut settled: Vec<&str> = Vec::new();
    for job in &claimed {
        if !job.publication_key.is_empty() && !settled.contains(&job.publication_key.as_str()) {
            settled.push(&job.publication_key);
        }
    }
    for publication_key in settled {
        let recorded = record_event(
            delivery.sqlite(),
            delivery.clock(),
            &DomainEventInput {
                publication_ref: Some(publication_key.to_owned()),
                event_type: "delivery.publication.settled".into(),
                severity: Severity::Info,
                target: None,
                message: format!("Delivery cycle settled {publication_key}"),
                details: Some(object(json!({"publication_key": publication_key}))),
                cooldown_seconds: Some(10),
            },
        );
        if let Err(error) = recorded {
            log(
                LogLevel::Warn,
                "delivery settlement event journal failed",
                Some(json!({"publicationKey": publication_key, "error": error.to_string()})),
            );
        }
    }
    record_worker_state(
        delivery.db,
        "queue",
        object(json!({"claimed": claimed.len()})),
        None,
        delivery.clock().now(),
    )?;
    Ok(claimed.len())
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object,
        _ => unreachable!("built as an object"),
    }
}

/// One claimed job, from the adapter lookup to its settlement. An `Err` is a
/// settlement that itself failed: the caller holds the job for verification.
async fn run_claimed(delivery: &Delivery<'_>, ports: &DeliveryPorts, job: &ClaimedPublishJob) -> Result<()> {
    let publishing = delivery.publishing();
    let Some(adapter) = ports.get(&job.target) else {
        let failure = PublishFailure::new(format!("unsupported delivery target: {}", job.target));
        if let Err(error) = publishing.fail_publish_job(job.job_id, &failure, &job.lock_id) {
            emergency_settlement(delivery, job, &error.to_string(), None);
        }
        return Ok(());
    };
    match attempt(delivery, adapter, job).await {
        Attempt::Failed(error) if error.is_ambiguous() => {
            publishing.require_publish_verification(job.job_id, error.message(), &job.lock_id)?;
        }
        Attempt::Failed(error) => {
            publishing.fail_publish_job(job.job_id, &error.to_publish_failure(), &job.lock_id)?;
        }
        Attempt::Published(result) => {
            let answered = provider_answered_at(delivery.sqlite(), &job.target)?;
            if let Err(error) = publishing.complete_publish_job(job.job_id, &result, &job.lock_id, answered.as_deref())
            {
                emergency_settlement(delivery, job, &error.to_string(), Some(&result));
            }
        }
    }
    Ok(())
}

/// `settleUnexpectedFinalization`: a settlement that failed is held for
/// verification — retrying an audience mutation is the one unsafe answer.
fn emergency_settlement(delivery: &Delivery<'_>, job: &ClaimedPublishJob, error: &str, result: Option<&PublishResult>) {
    let message = format!("worker finalization failed: {error}");
    log(
        LogLevel::Error,
        "publish job finalization failed",
        Some(json!({"jobId": job.job_id, "target": job.target, "error": message})),
    );
    if let Err(failure) =
        delivery
            .publishing()
            .force_publish_job_verification(job.job_id, &message, &job.lock_id, result)
    {
        log(
            LogLevel::Error,
            "publish job emergency settlement failed",
            Some(json!({"jobId": job.job_id, "target": job.target, "error": failure.to_string()})),
        );
    }
}

/// The adapter's four phases under the job heartbeat and the publish
/// timeout, tracked as `publishing.social.job`.
async fn attempt(delivery: &Delivery<'_>, adapter: &dyn SocialAdapter, job: &ClaimedPublishJob) -> Attempt {
    let started_at = delivery.now_ms();
    let mut phases = Map::new();
    let outcome = async {
        // A target with consecutive 401/403s has a dead credential: repeating
        // the rejected request is the traffic that gets flagged as abuse.
        if is_target_auth_blocked(delivery.sqlite(), delivery.clock(), &job.target).map_err(domain_failure)? {
            return Err(AdapterError::Message(format!(
                "auth_circuit_open: {} has a failing credential, publish paused until it recovers",
                job.target
            )));
        }
        let heartbeat = || {
            delivery.sqlite().execute(
                r#"update "publish_jobs" set "locked_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ? and "publish_jobs"."locked_by" = ?)"#,
                params![delivery.now(), job.job_id, "publishing", job.lock_id],
            )
            .map(|_| ())
        };
        with_job_heartbeat(
            Duration::from_secs(PUBLISH_HEARTBEAT_INTERVAL_SECONDS),
            heartbeat,
            within_publish_timeout(delivery, job, phased(delivery, adapter, job, &mut phases)),
        )
        .await
    }
    .await;
    let success = outcome.is_ok();
    let total_ms = delivery.now_ms() - started_at;
    delivery.boundaries.usage.record(
        delivery.sqlite(),
        "publishing.social.job",
        success,
        total_ms.max(0) as u64,
    );
    let mut timing = json!({
        "operation": "publishing.social.job",
        "jobId": job.job_id,
        "target": job.target,
        "attempt": job.attempt_count,
        "success": success,
        "totalMs": total_ms,
        "phases": phases,
    });
    if let Err(error) = &outcome {
        timing["error"] = error.message().into();
    }
    log(
        if success { LogLevel::Info } else { LogLevel::Warn },
        "operation timing",
        Some(timing),
    );
    match outcome {
        Ok(result) => Attempt::Published(result),
        Err(error) => Attempt::Failed(error),
    }
}

fn domain_failure(error: domain::Error) -> AdapterError {
    AdapterError::Message(error.to_string())
}

async fn phased(
    delivery: &Delivery<'_>,
    adapter: &dyn SocialAdapter,
    job: &ClaimedPublishJob,
    phases: &mut Map<String, Value>,
) -> adapters::Result<PublishResult> {
    timed_phase(delivery, job, Phase::Validate, phases, None, async {
        adapter.validate(job).map(|()| None::<Value>)
    })
    .await?;
    let prepared = timed_phase(delivery, job, Phase::Prepare, phases, None, async {
        adapter.prepare(job.clone()).await.map(Some)
    })
    .await?
    .expect("prepare answers a job");
    let published = timed_phase(delivery, job, Phase::Publish, phases, None, async {
        adapter
            .publish(&prepared)
            .await
            .map(|result| Some(Value::Object(result)))
    })
    .await?
    .and_then(|value| match value {
        Value::Object(result) => Some(result),
        _ => None,
    })
    .expect("publish answers a result");
    let provider_result = Value::Object(published.clone());
    let verified = timed_phase(delivery, job, Phase::Verify, phases, Some(&provider_result), async {
        Ok(Some(Value::Object(adapter.verify(job, published).await)))
    })
    .await?;
    Ok(match verified {
        Some(Value::Object(result)) => result,
        _ => unreachable!("verify answers a result"),
    })
}

#[derive(Clone, Copy)]
enum Phase {
    Validate,
    Prepare,
    Publish,
    Verify,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Validate => "validate",
            Self::Prepare => "prepare",
            Self::Publish => "provider.publish",
            Self::Verify => "provider.verify",
        }
    }

    fn timing_key(self) -> &'static str {
        match self {
            Self::Validate => "validateMs",
            Self::Prepare => "prepareMs",
            Self::Publish => "publishMs",
            Self::Verify => "verifyMs",
        }
    }
}

/// What a phase answered, as the journal reads it for a request id: nothing
/// (validate), the prepared job, or a provider result.
trait PhaseOutput {
    fn request_id(&self) -> Option<String>;
}

impl PhaseOutput for Option<Value> {
    fn request_id(&self) -> Option<String> {
        self.as_ref().and_then(provider_request_id)
    }
}

/// A prepared job has none of the request-id keys a provider result does.
impl PhaseOutput for Option<ClaimedPublishJob> {
    fn request_id(&self) -> Option<String> {
        None
    }
}

/// `timedDeliveryPhase`: the lease check and the phase write are one
/// statement, and its result is what authorises the work. Read separately,
/// the ownership verified could pass to a successor before the write landed,
/// and this worker would still publish — the same post, twice.
async fn timed_phase<T: PhaseOutput>(
    delivery: &Delivery<'_>,
    job: &ClaimedPublishJob,
    phase: Phase,
    timings: &mut Map<String, Value>,
    provider_result: Option<&Value>,
    work: impl Future<Output = adapters::Result<T>>,
) -> adapters::Result<T> {
    let started_at = delivery.now_ms();
    let owned = delivery
        .sqlite()
        .query_row(
            r#"update "publish_jobs" set "current_phase" = ?, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ? and "publish_jobs"."locked_by" = ?) returning "job_id""#,
            params![phase.as_str(), delivery.now(), job.job_id, "publishing", job.lock_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| AdapterError::Message(error.to_string()))?;
    if owned.is_none() {
        return Err(AdapterError::Message(format!(
            "delivery_job_no_longer_owned:{}",
            job.job_id
        )));
    }
    let outcome = work.await;
    let duration_ms = delivery.now_ms() - started_at;
    timings.insert(phase.timing_key().into(), duration_ms.into());
    let provider_request_id = |own: Option<String>| own.or_else(|| provider_result.and_then(provider_request_id));
    let (severity, status, details_extra, request_id) = match &outcome {
        Ok(result) => (
            Severity::Info,
            "completed",
            None,
            provider_request_id(result.request_id()),
        ),
        Err(error) => (
            Severity::Error,
            "failed",
            Some(error.message().to_owned()),
            provider_request_id(None),
        ),
    };
    let mut details = object(json!({
        "job_id": job.job_id,
        "attempt": job.attempt_count,
        "phase": phase.as_str(),
        "status": status,
        "duration_ms": duration_ms,
        "provider_request_id": request_id,
    }));
    if let Some(error) = details_extra {
        details.insert("error".into(), error.into());
    }
    let recorded = record_event(
        delivery.sqlite(),
        delivery.clock(),
        &DomainEventInput {
            publication_ref: Some(job.publication_key.clone()),
            event_type: "publish.job.phase".into(),
            severity,
            target: Some(job.target.clone()),
            message: format!("{} {} {status}", job.target, phase.as_str()),
            details: Some(details),
            cooldown_seconds: None,
        },
    );
    if let Err(error) = recorded {
        log(
            LogLevel::Warn,
            "publish phase event journal failed",
            Some(
                json!({"jobId": job.job_id, "target": job.target, "phase": phase.as_str(), "error": error.to_string()}),
            ),
        );
    }
    outcome
}

/// `providerRequestId`: the first request id a provider result names, at
/// the top or under `raw`.
fn provider_request_id(value: &Value) -> Option<String> {
    let row = value.as_object()?;
    for key in ["providerRequestId", "requestId", "request_id", "xRequestId"] {
        if let Some(Value::String(candidate)) = row.get(key)
            && !candidate.is_empty()
        {
            return Some(candidate.clone());
        }
    }
    match row.get("raw") {
        Some(raw @ Value::Object(_)) => provider_request_id(raw),
        _ => None,
    }
}

/// `withinPublishTimeout`: a stuck provider call releases the queue loop. The
/// timeout is ambiguous only in a phase that may have reached the audience;
/// a preparation or verification timeout is an ordinary failure.
async fn within_publish_timeout(
    delivery: &Delivery<'_>,
    job: &ClaimedPublishJob,
    work: impl Future<Output = adapters::Result<PublishResult>>,
) -> adapters::Result<PublishResult> {
    let limit = delivery.config().publish_job_timeout_seconds;
    match tokio::time::timeout(Duration::from_secs(limit), work).await {
        Ok(outcome) => outcome,
        Err(_) => {
            let phase: Option<String> = delivery
                .sqlite()
                .query_row(
                    r#"select "current_phase" from "publish_jobs" where "publish_jobs"."job_id" = ?"#,
                    [job.job_id],
                    |row| row.get(0),
                )
                .optional()
                .ok()
                .flatten()
                .flatten();
            let message = format!(
                "delivery_execution_timeout: {} exceeded {limit}s during {}",
                job.target,
                phase.as_deref().unwrap_or("unknown")
            );
            Err(if may_have_reached_audience(phase.as_deref()) {
                adapters::error::ambiguous_error(&job.target, &message)
            } else {
                AdapterError::Message(message)
            })
        }
    }
}
