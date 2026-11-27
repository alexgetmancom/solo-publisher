//! The video loop. Jobs run one at a time, each
//! claimed only when its provider call is about to start, under a 30 s
//! heartbeat; every write after the claim is fenced on the job's lease, and a
//! step that may have reached the audience settles as ambiguous rather than
//! being sent again.

use std::time::Duration;

use content::Locale;
use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension as _, Row, params, params_from_iter};
use domain::application::ports::{DomainEventInput, Severity};
use domain::application::publication_ref::{PublicationRefKind, publication_ref};
use domain::observability::alerts::ALERT_COOLDOWN_SECONDS;
use domain::observability::auth_circuit::is_target_auth_blocked;
use domain::publishing::errors::{PublishErrorClass, PublishFailure};
use domain::publishing::job_policy::{
    failed_job_transition, publish_retry_policy, video_step_may_have_reached_audience,
};
use domain::publishing::queue::PUBLISH_CLAIM_LIMIT;
use domain::publishing::video_assets::{video_public_url, video_source_path};
use domain::publishing::video_data::VideoDraftRow;
use domain::publishing::video_fence::zernio_publish_fence;
use domain::publishing::video_types::VideoTarget;
use domain::repositories::{StudioSettingsStore, random_uuid, record_event, transaction};
use foundation::config::PUBLISH_MAX_ATTEMPTS;
use foundation::text::TrimText;
use foundation::time::iso_at;
use providers::adapters::video_publishers::{
    YoutubeMetadata, instagram_container_ready, keep_youtube_upload_private, prepare_instagram_reel,
    prepare_youtube_video, publish_instagram_reel,
};
use providers::adapters::zernio::publish_zernio_instagram_reel;
use providers::adapters::{AdapterError, instagram::verify_instagram_publication};
use providers::external::instagram::{InstagramCredentials, instagram_credentials_for_locale};
use runtime::job_heartbeat::with_job_heartbeat;
use serde_json::{Map, Value};

use crate::routing::video_channel_identity;
use crate::video_retention::prune_expired_videos;
use crate::{Delivery, Result};

const VIDEO_HEARTBEAT_INTERVAL_SECONDS: u64 = 30;

/// Video jobs heartbeat at a tighter interval than the social pipeline, so
/// this only has to be a few missed heartbeats wide to detect a crash.
const VIDEO_LOCK_TIMEOUT_SECONDS: i64 = 120;

const LOST_WORKER_ERROR: &str = "worker_lost: video lock expired before completion";

/// A claimed job, as the claim's `returning` gave it back. `lock` is the
/// `locked_by` this worker wrote: every later write names it.
struct VideoJob {
    id: i64,
    video_draft_id: i64,
    video_target_id: Option<i64>,
    kind: String,
    run_at: String,
    attempt_count: u32,
    lock: String,
}

/// The target columns a job step reads.
struct Target {
    id: i64,
    target: String,
    metadata: Map<String, Value>,
    scheduled_at: Option<String>,
    status: String,
    delivery_provider: String,
    provider_account_id: Option<String>,
    external_id: Option<String>,
    confirmation_source: Option<String>,
}

/// The columns one write sets, in the order the recorded goldens name them.
/// An absent field is left out, a null one is written as NULL.
type Patch = Vec<(&'static str, SqlValue)>;

fn text(value: impl Into<String>) -> SqlValue {
    SqlValue::Text(value.into())
}

fn nullable(value: Option<impl Into<String>>) -> SqlValue {
    value.map_or(SqlValue::Null, text)
}

/// `Boolean(value)` of an optional text column.
fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

/// A failure the database answered inside a job step, handled like a
/// provider's refusal.
fn local(error: impl ToString) -> AdapterError {
    AdapterError::Message(error.to_string())
}

/// The lease fence: this job, still running, still held by this worker.
const ACTIVE_JOB: &str =
    r#"("video_jobs"."id" = ? and "video_jobs"."status" = 'running' and "video_jobs"."locked_by" = ?)"#;

fn retention_hours(sqlite: &Connection) -> Result<i64> {
    Ok(StudioSettingsStore::new(sqlite).profile()?.video_retention_hours)
}

/// `runVideoCycle`: the `video` loop body. Returns how many jobs it claimed.
pub async fn run_video_cycle(delivery: &Delivery<'_>) -> Result<usize> {
    recover_video_locks(delivery)?;
    let sqlite = delivery.sqlite();
    let mut claimed = 0;
    // Deliberately serial, unlike the social pipeline's per-target lanes:
    // every job here moves a video file of a few hundred MB, and two
    // concurrent uploads share one uplink, so they finish no sooner together
    // than one after the other — and risk timing each other out.
    while claimed < PUBLISH_CLAIM_LIMIT as usize {
        // Claim only the job about to run. Claiming the whole serial batch
        // made untouched jobs look in-flight during a long upload; after a
        // restart, recovery then treated their publish calls as ambiguous.
        let Some(job) = claim_video_job(delivery)? else {
            break;
        };
        claimed += 1;
        let credential_target = video_job_credential_target(delivery, &job)?;
        if let Some(target) = &credential_target
            && is_target_auth_blocked(sqlite, delivery.clock(), target)?
        {
            defer_blocked_video_job(delivery, &job)?;
            continue;
        }
        let started_at = delivery.now_ms();
        let heartbeat = || {
            sqlite
                .execute(
                    &format!(r#"update "video_jobs" set "locked_at" = ? where {ACTIVE_JOB}"#),
                    params![delivery.now(), job.id, job.lock],
                )
                .map(|_| ())
        };
        let outcome = with_job_heartbeat(
            Duration::from_secs(VIDEO_HEARTBEAT_INTERVAL_SECONDS),
            heartbeat,
            execute_video_job(delivery, &job),
        )
        .await;
        let elapsed = || (delivery.now_ms() - started_at).max(0) as u64;
        match outcome {
            Ok(settled) => {
                if settled || complete_video_job(delivery, &job)? {
                    if let Some(target) = &credential_target {
                        delivery.boundaries.auth_circuit.record_success(sqlite, target)?;
                    }
                    record_video_progress_event(delivery, &job, "video.job.completed")?;
                    delivery
                        .boundaries
                        .video_completion
                        .record_if_final(sqlite, job.video_draft_id)?;
                }
                delivery
                    .boundaries
                    .usage
                    .record(sqlite, "publishing.video.job", true, elapsed());
            }
            Err(error) => {
                let ambiguous = error.is_ambiguous();
                let settled = if ambiguous {
                    require_video_verification(delivery, &job, error.message())?
                } else {
                    fail_video_job(delivery, &job, &error)?
                };
                // An upload the provider answered ambiguously and verification
                // took over is the pipeline doing its job, not a failed one.
                delivery
                    .boundaries
                    .usage
                    .record(sqlite, "publishing.video.job", ambiguous && settled, elapsed());
                if settled {
                    if let Some(target) = &credential_target
                        && error.class() == PublishErrorClass::Auth
                    {
                        delivery.boundaries.auth_circuit.record_failure(sqlite, target)?;
                    }
                    record_video_progress_event(delivery, &job, "video.job.failed")?;
                    delivery
                        .boundaries
                        .video_completion
                        .record_if_final(sqlite, job.video_draft_id)?;
                }
            }
        }
    }
    prune_expired_videos(delivery)?;
    Ok(claimed)
}

/// `videoJobCredentialTarget`: the connected account whose credential a
/// YouTube or native Reels job uses.
fn video_job_credential_target(delivery: &Delivery<'_>, job: &VideoJob) -> Result<Option<String>> {
    let Some(target_id) = job.video_target_id else {
        return Ok(None);
    };
    let target: Option<String> = delivery
        .sqlite()
        .query_row(
            r#"select "target" from "video_targets" where "video_targets"."id" = ?"#,
            [target_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(target) = target.as_deref().and_then(VideoTarget::parse) else {
        return Ok(None);
    };
    let locale = if delivery.publishing().get_video_draft(job.video_draft_id)?.locale == "en" {
        "en"
    } else {
        "ru"
    };
    Ok(Some(video_channel_identity(delivery.sqlite(), target, locale)?))
}

/// `deferBlockedVideoJob`: a dead credential pauses the job five minutes
/// without spending an attempt.
fn defer_blocked_video_job(delivery: &Delivery<'_>, job: &VideoJob) -> Result<()> {
    delivery.sqlite().execute(
        &format!(
            r#"update "video_jobs" set "status" = 'queued', "next_attempt_at" = ?, "locked_at" = null, "locked_by" = null, "updated_at" = ? where {ACTIVE_JOB}"#
        ),
        params![iso_at(delivery.now_ms() + 5 * 60_000), delivery.now(), job.id, job.lock],
    )?;
    Ok(())
}

/// `updateVideoTarget`: one target write, stamped.
fn update_video_target(delivery: &Delivery<'_>, target_id: i64, mut patch: Patch) -> Result<()> {
    patch.push(("updated_at", text(delivery.now())));
    let sets = patch
        .iter()
        .map(|(column, _)| format!(r#""{column}" = ?"#))
        .collect::<Vec<_>>()
        .join(", ");
    let values = patch.into_iter().map(|(_, value)| value).chain([target_id.into()]);
    delivery.sqlite().execute(
        &format!(r#"update "video_targets" set {sets} where "video_targets"."id" = ?"#),
        params_from_iter(values),
    )?;
    Ok(())
}

/// `claimVideoJobs(db, 1)`: the next due job, taken under the conditions it
/// was found by.
fn claim_video_job(delivery: &Delivery<'_>) -> Result<Option<VideoJob>> {
    const DUE: &str = r#""video_jobs"."status" = 'queued' and "video_jobs"."run_at" <= ? and ("video_jobs"."next_attempt_at" is null or "video_jobs"."next_attempt_at" <= ?)"#;
    let sqlite = delivery.sqlite();
    let now = delivery.now();
    let Some(id) = sqlite
        .query_row(
            &format!(
                r#"select "id" from "video_jobs" where ({DUE}) order by "video_jobs"."run_at" asc, "video_jobs"."id" asc limit 1"#
            ),
            params![now, now],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let lock = format!("{}:{}", std::process::id(), random_uuid());
    transaction(sqlite, || {
        Ok(sqlite
            .query_row(
                &format!(
                    r#"update "video_jobs" set "status" = 'running', "locked_by" = ?, "locked_at" = ?, "updated_at" = ? where ("video_jobs"."id" = ? and {DUE}) returning "id", "video_draft_id", "video_target_id", "kind", "run_at", "attempt_count", "locked_by""#
                ),
                params![lock, now, now, id, now, now],
                |row| {
                    Ok(VideoJob {
                        id: row.get(0)?,
                        video_draft_id: row.get(1)?,
                        video_target_id: row.get(2)?,
                        kind: row.get(3)?,
                        run_at: row.get(4)?,
                        attempt_count: row.get(5)?,
                        lock: row.get(6)?,
                    })
                },
            )
            .optional()?)
    })
}

fn target_row(row: &Row<'_>) -> db::rusqlite::Result<Target> {
    let metadata: String = row.get(2)?;
    Ok(Target {
        id: row.get(0)?,
        target: row.get(1)?,
        metadata: match serde_json::from_str(&metadata) {
            Ok(Value::Object(object)) => object,
            _ => Map::new(),
        },
        scheduled_at: row.get(3)?,
        status: row.get(4)?,
        delivery_provider: row.get(5)?,
        provider_account_id: row.get(6)?,
        external_id: row.get(7)?,
        confirmation_source: row.get(8)?,
    })
}

/// `executeVideoJob`: the job's one platform step. `Ok(false)` is a step
/// that did not settle the job (cancelled, published, or the lease lost).
async fn execute_video_job(delivery: &Delivery<'_>, job: &VideoJob) -> providers::adapters::Result<bool> {
    let Some(target_id) = job.video_target_id else {
        return Err(AdapterError::message_text("Video platform job has no target."));
    };
    let target = delivery
        .sqlite()
        .query_row(
            r#"select "id", "target", "metadata_json", "scheduled_at", "status", "delivery_provider", "provider_account_id", "external_id", "confirmation_source" from "video_targets" where "video_targets"."id" = ?"#,
            [target_id],
            target_row,
        )
        .optional()
        .map_err(local)?;
    let draft = delivery
        .publishing()
        .get_video_draft(job.video_draft_id)
        .map_err(local)?;
    // Deliberate deviation: the goldens also run the step for a target held
    // for verification. After an upload that lost its answer, the queued
    // publish job then failed with "upload has not completed yet" and wrote
    // the target back to `scheduled`/`failed` — the state an operator retries,
    // uploading the video a second time. A target whose outcome is unknown
    // is left for verification to settle.
    let Some(target) =
        target.filter(|target| !["cancelled", "published", "verification_required"].contains(&target.status.as_str()))
    else {
        return Ok(false);
    };
    let Some(file_path) = video_source_path(delivery.sqlite(), draft.studio_media_asset_id).map_err(local)? else {
        return Err(AdapterError::message_text(
            "Video source was removed before publication completed.",
        ));
    };
    let locale = if draft.locale == "en" { Locale::En } else { Locale::Ru };
    let config = delivery.config();
    let credentials = instagram_credentials_for_locale(config, locale);
    if job.kind == "prepare" {
        return if target.target == "youtube_shorts" {
            prepare_youtube(delivery, job, &target, &file_path, locale).await
        } else if target.delivery_provider == "zernio" {
            prepare_zernio(delivery, job, &target)
        } else {
            prepare_instagram(delivery, job, &target, &draft, credentials).await
        };
    }
    let settled = if target.target == "youtube_shorts" {
        publish_youtube(delivery, job, &target)?
    } else if target.delivery_provider == "zernio" {
        publish_zernio(delivery, job, &target, &draft).await?
    } else {
        publish_instagram(delivery, job, &target, credentials).await?
    };
    if settled {
        let hours = retention_hours(delivery.sqlite()).map_err(local)?;
        delivery
            .publishing()
            .refresh_video_draft_status(draft.id, hours)
            .map_err(local)?;
    }
    Ok(settled)
}

fn metadata_text<'a>(target: &'a Target, field: &str) -> &'a str {
    target.metadata.get(field).and_then(Value::as_str).unwrap_or_default()
}

/// `prepareYouTube`: the private upload, scheduled for the target's time.
async fn prepare_youtube(
    delivery: &Delivery<'_>,
    job: &VideoJob,
    target: &Target,
    file_path: &str,
    locale: Locale,
) -> providers::adapters::Result<bool> {
    let metadata = YoutubeMetadata {
        title: metadata_text(target, "title").to_owned(),
        description: compose_youtube_description(delivery.sqlite(), &target.metadata).map_err(local)?,
        tags: target
            .metadata
            .get("tags")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
    };
    let publish_at = target.scheduled_at.clone().unwrap_or_else(|| delivery.now());
    let result = prepare_youtube_video(
        &delivery.adapters,
        std::path::Path::new(file_path),
        &metadata,
        &publish_at,
        locale,
    )
    .await?;
    let mut patch: Patch = vec![("status", text("prepared"))];
    if let Some(id) = &result.id {
        patch.push(("external_id", text(id)));
    }
    patch.extend([
        ("external_url", text(&result.url)),
        ("prepared_at", text(delivery.now())),
        ("confirmation_source", text("publish_response")),
    ]);
    if settle_video_target_job(delivery, job, target.id, patch).map_err(local)? {
        return Ok(true);
    }
    // Cancellation can happen while the resumable upload is in flight. The
    // id exists only in this response, so fence its future public release
    // before discarding it from local state.
    let video_id = result.id.as_deref().unwrap_or("undefined");
    if let Err(error) = keep_youtube_upload_private(&delivery.adapters, video_id, locale).await {
        let mut details = Map::new();
        details.insert("videoDraftId".into(), job.video_draft_id.into());
        if let Some(id) = &result.id {
            details.insert("videoId".into(), id.clone().into());
        }
        details.insert("error".into(), error.message().into());
        record_event(
            delivery.sqlite(),
            delivery.clock(),
            &DomainEventInput {
                publication_ref: Some(publication_ref(PublicationRefKind::Video, job.video_draft_id)),
                event_type: "studio.notification.video_cancelled".into(),
                severity: Severity::Warn,
                target: Some("youtube_shorts".into()),
                message: "A cancelled YouTube upload could not be kept private; check it manually.".into(),
                details: Some(details),
                cooldown_seconds: None,
            },
        )
        .map_err(local)?;
    }
    Ok(false)
}

/// `prepareZernio`: Zernio takes the public video at its publish time, so
/// prepare is a local checkpoint only; publishing early would break the schedule.
fn prepare_zernio(delivery: &Delivery<'_>, job: &VideoJob, target: &Target) -> providers::adapters::Result<bool> {
    if present(target.provider_account_id.as_deref()).is_none() {
        return Err(AdapterError::message_text("Zernio Instagram account is missing"));
    }
    settle_video_target_job(
        delivery,
        job,
        target.id,
        vec![("status", text("prepared")), ("prepared_at", text(delivery.now()))],
    )
    .map_err(local)
}

/// `prepareInstagram`: the Reels container, from the public media URL.
async fn prepare_instagram(
    delivery: &Delivery<'_>,
    job: &VideoJob,
    target: &Target,
    draft: &VideoDraftRow,
    credentials: InstagramCredentials<'_>,
) -> providers::adapters::Result<bool> {
    let public_url =
        video_public_url(delivery.sqlite(), delivery.config(), draft.studio_media_asset_id).map_err(local)?;
    let id = prepare_instagram_reel(
        &delivery.adapters,
        credentials,
        &public_url,
        metadata_text(target, "caption"),
    )
    .await?;
    let mut patch: Patch = vec![("status", text("prepared"))];
    if let Some(id) = id {
        patch.push(("external_id", text(id)));
    }
    patch.push(("prepared_at", text(delivery.now())));
    settle_video_target_job(delivery, job, target.id, patch).map_err(local)
}

/// `publishYouTube`: the upload already carries its release time, so
/// publishing is a local settlement.
fn publish_youtube(delivery: &Delivery<'_>, job: &VideoJob, target: &Target) -> providers::adapters::Result<bool> {
    if present(target.external_id.as_deref()).is_none() {
        return Err(AdapterError::message_text("YouTube upload has not completed yet."));
    }
    settle_video_target_job(
        delivery,
        job,
        target.id,
        vec![
            ("status", text("published")),
            ("published_at", text(delivery.now())),
            (
                "confirmation_source",
                text(target.confirmation_source.as_deref().unwrap_or("publish_response")),
            ),
        ],
    )
    .map_err(local)
}

/// `publishZernio`: the provider publication, fenced by the attempt's
/// request id. An answer without a platform link is not a published Reel.
async fn publish_zernio(
    delivery: &Delivery<'_>,
    job: &VideoJob,
    target: &Target,
    draft: &VideoDraftRow,
) -> providers::adapters::Result<bool> {
    let Some(account_id) = present(target.provider_account_id.as_deref()) else {
        return Err(AdapterError::message_text("Zernio Instagram account is missing"));
    };
    let public_url =
        video_public_url(delivery.sqlite(), delivery.config(), draft.studio_media_asset_id).map_err(local)?;
    let result = publish_zernio_instagram_reel(
        &delivery.adapters,
        account_id,
        &public_url,
        metadata_text(target, "caption"),
        &zernio_publish_fence(job.id, &job.run_at),
    )
    .await?;
    if !owns_video_job(delivery, job).map_err(local)? {
        return Ok(false);
    }
    // The provider takes a publication before the platform does, so a
    // response with no platform link is one nobody has confirmed. Recorded as
    // published, it showed a live post the account did not have and left the
    // row outside the reconciliation sweep that fills the link in later.
    if present(result.external_id.as_deref()).is_none() && present(result.url.as_deref()).is_none() {
        if !update_active_video_target(delivery, job, target.id, &result.provider_post_id).map_err(local)? {
            return Ok(false);
        }
        return Err(providers::adapters::error::ambiguous_error(
            "zernio",
            "the provider accepted the publication and the platform has not confirmed it",
        ));
    }
    settle_video_target_job(
        delivery,
        job,
        target.id,
        vec![
            ("status", text("published")),
            ("provider_post_id", text(&result.provider_post_id)),
            ("external_id", nullable(result.external_id)),
            ("external_url", nullable(result.url)),
            ("published_at", text(delivery.now())),
            ("confirmation_source", text("provider_verify")),
            ("verified_at", text(delivery.now())),
        ],
    )
    .map_err(local)
}

/// `publishInstagram`: the container once ready, then `media_publish`, each
/// provider call behind the lease.
async fn publish_instagram(
    delivery: &Delivery<'_>,
    job: &VideoJob,
    target: &Target,
    credentials: InstagramCredentials<'_>,
) -> providers::adapters::Result<bool> {
    let Some(container_id) = present(target.external_id.as_deref()) else {
        return Err(AdapterError::message_text("Instagram upload has not completed yet."));
    };
    instagram_container_ready(&delivery.adapters, credentials, container_id).await?;
    if !owns_video_job(delivery, job).map_err(local)? {
        return Ok(false);
    }
    let result = publish_instagram_reel(&delivery.adapters, credentials, container_id).await?;
    if !owns_video_job(delivery, job).map_err(local)? {
        return Ok(false);
    }
    let mut external_url = result.url.clone();
    let mut verified_at = None;
    // The publish response already returned the media id. Verification
    // failure is diagnostic and must not replay media_publish.
    let media_id = result.id.as_deref().unwrap_or("undefined");
    if let Ok((_, permalink)) = verify_instagram_publication(&delivery.adapters, media_id, credentials).await {
        if let Value::String(permalink) = permalink {
            external_url = permalink;
        }
        verified_at = Some(delivery.now());
    }
    let mut patch: Patch = vec![("status", text("published"))];
    if let Some(id) = &result.id {
        patch.push(("external_id", text(id)));
    }
    patch.extend([
        ("external_url", text(external_url)),
        ("published_at", text(delivery.now())),
        (
            "confirmation_source",
            text(if verified_at.is_some() {
                "provider_verify"
            } else {
                "publish_response"
            }),
        ),
        ("verified_at", nullable(verified_at)),
    ]);
    settle_video_target_job(delivery, job, target.id, patch).map_err(local)
}

/// `settleVideoTargetJob`: the job's completion, fenced on its lease, and
/// the target write it authorises, in one transaction.
fn settle_video_target_job(delivery: &Delivery<'_>, job: &VideoJob, target_id: i64, patch: Patch) -> Result<bool> {
    let sqlite = delivery.sqlite();
    transaction(sqlite, || {
        if !complete_video_job(delivery, job)? {
            return Ok(false);
        }
        update_video_target(delivery, target_id, patch)?;
        Ok(true)
    })
}

/// `updateActiveVideoTarget`: the provider's post id, written only while
/// this worker still holds the job.
fn update_active_video_target(
    delivery: &Delivery<'_>,
    job: &VideoJob,
    target_id: i64,
    provider_post_id: &str,
) -> Result<bool> {
    Ok(delivery
        .sqlite()
        .query_row(
            &format!(
                r#"update "video_targets" set "provider_post_id" = ?, "updated_at" = ? where ("video_targets"."id" = ? and exists (select "id" from "video_jobs" where {ACTIVE_JOB})) returning "id""#
            ),
            params![provider_post_id, delivery.now(), target_id, job.id, job.lock],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

fn job_details(job: &VideoJob) -> Map<String, Value> {
    let mut details = Map::new();
    details.insert("videoDraftId".into(), job.video_draft_id.into());
    details.insert("videoTargetId".into(), job.video_target_id.into());
    details.insert("jobId".into(), job.id.into());
    details.insert("kind".into(), job.kind.clone().into());
    details
}

/// `recordVideoProgressEvent`.
fn record_video_progress_event(delivery: &Delivery<'_>, job: &VideoJob, event_type: &str) -> Result<()> {
    record_event(
        delivery.sqlite(),
        delivery.clock(),
        &DomainEventInput {
            publication_ref: Some(publication_ref(PublicationRefKind::Video, job.video_draft_id)),
            event_type: event_type.into(),
            severity: Severity::Info,
            target: None,
            message: format!("Video job {} settled for draft #{}", job.kind, job.video_draft_id),
            details: Some(job_details(job)),
            cooldown_seconds: None,
        },
    )?;
    Ok(())
}

/// `completeVideoJob`: a step that settled nothing on the target still
/// completes the job it held.
fn complete_video_job(delivery: &Delivery<'_>, job: &VideoJob) -> Result<bool> {
    Ok(delivery
        .sqlite()
        .query_row(
            &format!(
                r#"update "video_jobs" set "status" = 'completed', "locked_at" = null, "locked_by" = null, "updated_at" = ? where {ACTIVE_JOB} returning "id""#
            ),
            params![delivery.now(), job.id, job.lock],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

/// `failVideoJob`: the retry policy's answer, fenced on the lease. A
/// container still processing waits 30 s without touching the target; a dead
/// one sends the target back to preparation; a preparation that failed for
/// good cancels the publication waiting on it.
fn fail_video_job(delivery: &Delivery<'_>, job: &VideoJob, cause: &AdapterError) -> Result<bool> {
    let sqlite = delivery.sqlite();
    let error = cause.message();
    let transition = failed_job_transition(
        &cause.to_publish_failure(),
        job.attempt_count,
        publish_retry_policy(),
        delivery.now_ms(),
        delivery.boundaries.jitter,
    );
    let now = delivery.now();
    if matches!(cause, AdapterError::ContainerProcessing(_)) && transition.attempt < PUBLISH_MAX_ATTEMPTS {
        return transaction(sqlite, || {
            let updated = sqlite
                .query_row(
                    &format!(
                        r#"update "video_jobs" set "status" = 'queued', "attempt_count" = ?, "next_attempt_at" = ?, "locked_at" = null, "locked_by" = null, "last_error" = ?, "updated_at" = ? where {ACTIVE_JOB} returning "id""#
                    ),
                    params![
                        transition.attempt,
                        iso_at(delivery.now_ms() + 30_000),
                        error,
                        now,
                        job.id,
                        job.lock
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if updated.is_none() {
                return Ok(false);
            }
            if let Some(target_id) = job.video_target_id {
                update_video_target(
                    delivery,
                    target_id,
                    vec![("status", text("prepared")), ("last_error", SqlValue::Null)],
                )?;
            }
            Ok(true)
        });
    }
    let retry = transition.status == "queued";
    let failed = transaction(sqlite, || {
        let updated = sqlite
            .query_row(
                &format!(
                    r#"update "video_jobs" set "status" = ?, "attempt_count" = ?, "next_attempt_at" = ?, "locked_at" = null, "locked_by" = null, "last_error" = ?, "updated_at" = ? where {ACTIVE_JOB} returning "id""#
                ),
                params![
                    transition.status,
                    transition.attempt,
                    transition.next_attempt_at,
                    error,
                    now,
                    job.id,
                    job.lock
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if updated.is_none() {
            return Ok(false);
        }
        let Some(target_id) = job.video_target_id else {
            return Ok(true);
        };
        if matches!(cause, AdapterError::ContainerInvalid(_)) && job.kind == "publish" && retry {
            requeue_instagram_preparation(delivery, job, target_id, error, &now, transition.attempt)?;
        } else {
            update_video_target(
                delivery,
                target_id,
                vec![
                    ("status", text(if retry { "scheduled" } else { "failed" })),
                    ("last_error", text(error)),
                ],
            )?;
            // Preparation is what produces the thing publication sends. When
            // it fails for good, the publish job would run anyway and fail with
            // "upload has not completed yet" — a consequence that replaced the
            // cause on the card and sent the operator looking in the wrong place.
            if job.kind == "prepare" && !retry {
                sqlite.execute(
                    r#"update "video_jobs" set "status" = 'cancelled', "last_error" = ?, "locked_at" = null, "locked_by" = null, "updated_at" = ? where ("video_jobs"."video_target_id" = ? and "video_jobs"."kind" = 'publish' and "video_jobs"."status" = 'queued')"#,
                    params![error, now, target_id],
                )?;
            }
        }
        Ok(true)
    })?;
    if !failed {
        return Ok(false);
    }
    delivery
        .publishing()
        .refresh_video_draft_status(job.video_draft_id, retention_hours(sqlite)?)?;
    if !retry {
        record_video_target_outcome(delivery, job, error, "failed")?;
    }
    Ok(true)
}

/// `requireVideoVerification`: a step that may have reached the audience is
/// held for verification, never retried.
fn require_video_verification(delivery: &Delivery<'_>, job: &VideoJob, error: &str) -> Result<bool> {
    let sqlite = delivery.sqlite();
    let now = delivery.now();
    let settled = transaction(sqlite, || {
        let updated = sqlite
            .query_row(
                &format!(
                    r#"update "video_jobs" set "status" = 'verification_required', "attempt_count" = ?, "next_attempt_at" = null, "locked_at" = null, "locked_by" = null, "last_error" = ?, "updated_at" = ? where {ACTIVE_JOB} returning "id""#
                ),
                params![job.attempt_count + 1, error, now, job.id, job.lock],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if updated.is_none() {
            return Ok(false);
        }
        if let Some(target_id) = job.video_target_id {
            update_video_target(
                delivery,
                target_id,
                vec![("status", text("verification_required")), ("last_error", text(error))],
            )?;
        }
        Ok(true)
    })?;
    if !settled {
        return Ok(false);
    }
    delivery
        .publishing()
        .refresh_video_draft_status(job.video_draft_id, retention_hours(sqlite)?)?;
    record_video_target_outcome(delivery, job, error, "verification_required")?;
    Ok(true)
}

/// `requeueInstagramPreparation`: an Instagram container can go stale between
/// prepare and publish; prepare runs again from scratch instead of retrying
/// the publish call against a dead container. Runs inside the transaction
/// whose fenced write released this job.
fn requeue_instagram_preparation(
    delivery: &Delivery<'_>,
    job: &VideoJob,
    target_id: i64,
    error: &str,
    now: &str,
    attempts: u32,
) -> Result<()> {
    let sqlite = delivery.sqlite();
    update_video_target(
        delivery,
        target_id,
        vec![
            ("status", text("scheduled")),
            ("external_id", SqlValue::Null),
            ("external_url", SqlValue::Null),
            ("prepared_at", SqlValue::Null),
            ("last_error", text(error)),
        ],
    )?;
    sqlite.execute(
        r#"update "video_jobs" set "status" = 'queued', "run_at" = ?, "attempt_count" = 0, "next_attempt_at" = null, "locked_at" = null, "locked_by" = null, "last_error" = null, "updated_at" = ? where ("video_jobs"."video_draft_id" = ? and "video_jobs"."video_target_id" = ? and "video_jobs"."kind" = 'prepare')"#,
        params![now, now, job.video_draft_id, target_id],
    )?;
    sqlite.execute(
        r#"update "video_jobs" set "status" = 'queued', "attempt_count" = ?, "next_attempt_at" = ?, "locked_at" = null, "locked_by" = null, "last_error" = ?, "updated_at" = ? where "video_jobs"."id" = ?"#,
        params![attempts, iso_at(delivery.now_ms() + 60_000), error, now, job.id],
    )?;
    Ok(())
}

/// `composeYouTubeDescription`: the signature belongs to the Studio's
/// channel, not to whoever authored the draft.
fn compose_youtube_description(sqlite: &Connection, metadata: &Map<String, Value>) -> Result<String> {
    let signature: Option<String> = sqlite
        .query_row(
            r#"select "signature" from "studio_youtube_settings" where "studio_youtube_settings"."id" = 1"#,
            [],
            |row| row.get(0),
        )
        .optional()?;
    let description = metadata.get("description").and_then(Value::as_str).unwrap_or_default();
    let game_line = match metadata.get("gameUrl").and_then(Value::as_str) {
        Some(url) if !url.is_empty() => format!("📀 Steam: {url}"),
        _ => String::new(),
    };
    Ok([
        description.trim_text(),
        &game_line,
        signature.as_deref().map(TrimText::trim_text).unwrap_or_default(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n"))
}

/// A running job whose lease ran out.
struct StaleJob {
    id: i64,
    video_draft_id: i64,
    video_target_id: Option<i64>,
    kind: String,
    attempt_count: u32,
    locked_at: Option<String>,
}

/// `recoverVideoLocks`: a crashed worker's job re-enters the retry budget
/// instead of dead-ending; a step that may have reached the audience is held
/// for verification. Each recovery is fenced on the lock it found.
pub fn recover_video_locks(delivery: &Delivery<'_>) -> Result<usize> {
    let sqlite = delivery.sqlite();
    let cutoff = iso_at(delivery.now_ms() - VIDEO_LOCK_TIMEOUT_SECONDS * 1000);
    let now = delivery.now();
    let stale: Vec<StaleJob> = sqlite
        .prepare(
            r#"select "id", "video_draft_id", "video_target_id", "kind", "attempt_count", "locked_at" from "video_jobs" where ("video_jobs"."status" = 'running' and "video_jobs"."locked_at" <= ?)"#,
        )?
        .query_map([&cutoff], |row| {
            Ok(StaleJob {
                id: row.get(0)?,
                video_draft_id: row.get(1)?,
                video_target_id: row.get(2)?,
                kind: row.get(3)?,
                attempt_count: row.get(4)?,
                locked_at: row.get(5)?,
            })
        })?
        .collect::<db::rusqlite::Result<_>>()?;
    let mut terminal: Vec<(&StaleJob, bool)> = Vec::new();
    let recovered = transaction(sqlite, || {
        let mut recovered = 0;
        for job in &stale {
            let Some(locked_at) = &job.locked_at else {
                continue;
            };
            let target: Option<String> = match job.video_target_id {
                Some(id) => sqlite
                    .query_row(
                        r#"select "target" from "video_targets" where "video_targets"."id" = ?"#,
                        [id],
                        |row| row.get(0),
                    )
                    .optional()?,
                None => None,
            };
            let ambiguous = video_step_may_have_reached_audience(Some(&job.kind), target.as_deref());
            let transition = failed_job_transition(
                &PublishFailure::new(LOST_WORKER_ERROR),
                job.attempt_count,
                publish_retry_policy(),
                delivery.now_ms(),
                delivery.boundaries.jitter,
            );
            let retry = !ambiguous && transition.status == "queued";
            let status = if ambiguous {
                "verification_required"
            } else {
                transition.status
            };
            let updated = sqlite
                .query_row(
                    r#"update "video_jobs" set "status" = ?, "attempt_count" = ?, "next_attempt_at" = ?, "locked_at" = null, "locked_by" = null, "last_error" = ?, "updated_at" = ? where ("video_jobs"."id" = ? and "video_jobs"."status" = 'running' and "video_jobs"."locked_at" = ?) returning "id""#,
                    params![
                        status,
                        transition.attempt,
                        transition.next_attempt_at,
                        LOST_WORKER_ERROR,
                        now,
                        job.id,
                        locked_at
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if updated.is_none() {
                continue;
            }
            recovered += 1;
            if let Some(target_id) = job.video_target_id {
                let target_status = if ambiguous {
                    "verification_required"
                } else if retry {
                    "scheduled"
                } else {
                    "failed"
                };
                update_video_target(
                    delivery,
                    target_id,
                    vec![("status", text(target_status)), ("last_error", text(LOST_WORKER_ERROR))],
                )?;
            }
            if !retry {
                terminal.push((job, ambiguous));
            }
        }
        Ok(recovered)
    })?;
    let hours = retention_hours(sqlite)?;
    for job in &stale {
        delivery
            .publishing()
            .refresh_video_draft_status(job.video_draft_id, hours)?;
    }
    for (job, verification_required) in terminal {
        let job = VideoJob {
            id: job.id,
            video_draft_id: job.video_draft_id,
            video_target_id: job.video_target_id,
            kind: job.kind.clone(),
            run_at: String::new(),
            attempt_count: job.attempt_count,
            lock: String::new(),
        };
        let outcome = if verification_required {
            "verification_required"
        } else {
            "failed"
        };
        record_video_target_outcome(delivery, &job, LOST_WORKER_ERROR, outcome)?;
        delivery
            .boundaries
            .video_completion
            .record_if_final(sqlite, job.video_draft_id)?;
    }
    Ok(recovered)
}

/// `recordVideoTargetOutcome`: a publication the provider already holds is
/// waiting, not failing, and is journalled at `info`.
fn record_video_target_outcome(delivery: &Delivery<'_>, job: &VideoJob, error: &str, outcome: &str) -> Result<()> {
    let target: Option<(String, Option<String>)> = match job.video_target_id {
        Some(id) => delivery
            .sqlite()
            .query_row(
                r#"select "target", "provider_post_id" from "video_targets" where "video_targets"."id" = ?"#,
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?,
        None => None,
    };
    let awaiting_provider = outcome == "verification_required"
        && target
            .as_ref()
            .is_some_and(|(_, provider_post_id)| present(provider_post_id.as_deref()).is_some());
    record_event(
        delivery.sqlite(),
        delivery.clock(),
        &DomainEventInput {
            publication_ref: Some(publication_ref(PublicationRefKind::Video, job.video_draft_id)),
            event_type: format!("video.target.{outcome}"),
            severity: if outcome == "failed" {
                Severity::Error
            } else if awaiting_provider {
                Severity::Info
            } else {
                Severity::Warn
            },
            target: Some(target.map_or_else(|| "video".to_owned(), |(target, _)| target)),
            message: error.into(),
            details: Some(job_details(job)),
            cooldown_seconds: Some(ALERT_COOLDOWN_SECONDS.unsigned_abs()),
        },
    )?;
    Ok(())
}

/// `ownsVideoJob`: asked between provider calls, so a lease taken over
/// mid-publication stops the next call.
fn owns_video_job(delivery: &Delivery<'_>, job: &VideoJob) -> Result<bool> {
    Ok(delivery
        .sqlite()
        .query_row(
            &format!(r#"select "id" from "video_jobs" where {ACTIVE_JOB}"#),
            params![job.id, job.lock],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}
