//! The pure retry policy and the row a requeued job leaves behind.

use foundation::config::{
    PUBLISH_BACKOFF_BASE_SECONDS, PUBLISH_BACKOFF_MAX_SECONDS, PUBLISH_MAX_ATTEMPTS, PUBLISH_PARTIAL_MAX_ATTEMPTS,
};

use serde_json::Value;

use super::boundaries::Jitter;
use super::delivery_payload::DeliveryPayload;
use super::errors::{PublishErrorClass, PublishFailure, classify_publish_error, next_retry_at};
use super::queue_state::{Columns, int, json_text, opt_text, text};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub backoff_base_seconds: u64,
    pub backoff_max_seconds: u64,
}

pub fn publish_retry_policy() -> RetryPolicy {
    RetryPolicy {
        max_attempts: PUBLISH_MAX_ATTEMPTS,
        backoff_base_seconds: PUBLISH_BACKOFF_BASE_SECONDS,
        backoff_max_seconds: PUBLISH_BACKOFF_MAX_SECONDS,
    }
}

/// The publish policy widened to the partial budget: only how many attempts
/// there are differs, because the curve is about being polite to the platform.
pub fn partial_retry_policy() -> RetryPolicy {
    RetryPolicy {
        max_attempts: PUBLISH_PARTIAL_MAX_ATTEMPTS,
        ..publish_retry_policy()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FailedJobTransition {
    pub attempt: u32,
    pub error_class: PublishErrorClass,
    /// `queued` or `failed`.
    pub status: &'static str,
    pub next_attempt_at: Option<String>,
}

/// Transient errors use the configured budget (four attempts by default:
/// initial delivery plus three retries); unknown errors get one safe retry and
/// permanent, content and auth errors never risk a duplicate post.
pub fn failed_job_transition(
    error: &PublishFailure,
    current_attempt: u32,
    policy: RetryPolicy,
    now_ms: i64,
    jitter: &dyn Jitter,
) -> FailedJobTransition {
    let attempt = current_attempt + 1;
    let error_class = classify_publish_error(error);
    let retry = (error_class == PublishErrorClass::Transient && attempt < policy.max_attempts)
        || (error_class == PublishErrorClass::Unknown && attempt < 2);
    FailedJobTransition {
        attempt,
        error_class,
        status: if retry { "queued" } else { "failed" },
        next_attempt_at: retry.then(|| {
            next_retry_at(
                attempt,
                policy.backoff_base_seconds,
                policy.backoff_max_seconds,
                now_ms,
                error.retry_after_seconds.filter(|seconds| seconds.is_finite()),
                jitter,
            )
        }),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PartialTransition {
    pub attempt: u32,
    pub status: &'static str,
    pub next_attempt_at: Option<String>,
}

/// The budget a half-finished publication comes back on: the same curve, far
/// more of it, because a platform coming back takes hours rather than minutes.
pub fn partial_publication_transition(
    current_attempt: u32,
    policy: RetryPolicy,
    now_ms: i64,
    jitter: &dyn Jitter,
) -> PartialTransition {
    let attempt = current_attempt + 1;
    let retry = attempt < policy.max_attempts;
    PartialTransition {
        attempt,
        status: if retry { "queued" } else { "failed" },
        next_attempt_at: retry.then(|| {
            next_retry_at(
                attempt,
                policy.backoff_base_seconds,
                policy.backoff_max_seconds,
                now_ms,
                None,
                jitter,
            )
        }),
    }
}

/// The phases that run before the provider has been called at all. The list
/// is closed on the safe side: any other phase means the platform may already
/// have accepted the post, because a second post is worse than an unclear status.
const PHASES_BEFORE_PROVIDER: [&str; 2] = ["validate", "prepare"];

/// `None` is a job claimed that had not started a phase yet, the one state
/// that is certainly safe.
pub fn may_have_reached_audience(phase: Option<&str>) -> bool {
    phase.is_some_and(|phase| !PHASES_BEFORE_PROVIDER.contains(&phase))
}

/// The same question for a video job step. Only preparation is safe, and only
/// where preparation does not upload — a YouTube upload exists on the platform
/// the moment it succeeds.
pub fn video_step_may_have_reached_audience(kind: Option<&str>, target: Option<&str>) -> bool {
    if kind == Some("prepare") {
        target == Some("youtube_shorts")
    } else {
        true
    }
}

/// The columns a publish job takes on when it re-enters the queue. Which jobs
/// each requeue path may touch stays a guard at the call site; what must not
/// differ is the row they leave behind: a job waiting to be claimed has shed
/// its lock, its backoff and the phase of its previous attempt.
pub(crate) fn requeued_publish_job_columns(payload: &DeliveryPayload, now: &str) -> Columns {
    vec![
        ("status", text("queued")),
        ("attempt_count", int(0)),
        ("publish_at", text(now)),
        ("next_attempt_at", opt_text(None::<String>)),
        ("locked_by", opt_text(None::<String>)),
        ("locked_at", opt_text(None::<String>)),
        ("current_phase", opt_text(None::<String>)),
        ("payload_json", json_text(&Value::Object(payload.fields().clone()))),
        ("last_error", opt_text(None::<String>)),
        ("updated_at", text(now)),
    ]
}

/// The target row that mirrors a requeued job. A requeued row usually goes on
/// to describe a different remote object, so it drops the identity of the old
/// one — unless the delivery is being continued (`keep_identity`), when the
/// row still names the same live post.
pub(crate) fn requeued_post_target(now: &str, keep_identity: bool) -> Columns {
    let mut patch = vec![
        ("status", text("queued")),
        ("error", opt_text(None::<String>)),
        ("skipped", int(0)),
        ("updated_at", text(now)),
        ("raw_json", text(r#"{"requeued":true}"#)),
    ];
    if !keep_identity {
        for column in [
            "external_id",
            "external_ids_json",
            "url",
            "published_at",
            "confirmation_source",
            "verified_at",
        ] {
            patch.push((column, opt_text(None::<String>)));
        }
    }
    patch
}
