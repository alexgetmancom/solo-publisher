//! Publications whose outcome was
//! lost at publish time, asked of the provider by their durable id. Only a
//! case backed by such an id is resolved; one without stays for an operator —
//! guessing by title or timestamp is not safe enough.

use content::Locale;
use db::rusqlite::{OptionalExtension as _, Row, params};
use domain::application::ports::{DomainEventInput, Severity};
use domain::application::publication_ref::{PublicationRefKind, publication_ref};
use domain::delivery::PROVIDER_CONFIRMATION_GRACE_MS;
use domain::observability::alerts::ALERT_COOLDOWN_SECONDS;
use domain::observability::auth_circuit::is_target_auth_blocked;
use domain::publishing::errors::{PublishErrorClass, classify_message, next_retry_at};
use domain::publishing::publication_owner::refresh_publication_owner;
use domain::publishing::queue::{PUBLISH_CLAIM_LIMIT, worker_id};
use domain::publishing::video_types::VideoTarget;
use domain::repositories::{StudioSettingsStore, random_uuid, record_event, transaction};
use domain::targets::{INSTAGRAM_STORY_TARGETS, THREADS_TARGETS};
use foundation::config::{PUBLISH_BACKOFF_BASE_SECONDS, PUBLISH_BACKOFF_MAX_SECONDS, PUBLISH_LOCK_TIMEOUT_SECONDS};
use foundation::time::iso_at;
use serde::Serialize;
use serde_json::{Map, Value, json};

use providers::adapters::platform_adapters::verify_platform_publication;
use providers::adapters::video_publishers::verify_youtube_video;
use providers::adapters::zernio::{ZernioPlatform, verify_zernio_post, zernio_post_outcome};

use crate::routing::{target_routing, video_channel_identity};
use crate::{Delivery, Error, Result};

/// How many times a provider is asked about one ambiguous publication before
/// the question goes to an operator. Higher than the publish budget: these
/// are reads, and a platform can take a while to expose a new object.
pub const RECONCILE_MAX_ATTEMPTS: i64 = 8;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationResult {
    pub checked: usize,
    pub resolved: usize,
    pub unresolved: usize,
    pub oldest_at: Option<String>,
}

/// A `verification_required` publish job and its target.
struct OrdinaryRow {
    job_id: i64,
    target: String,
    reconcile_attempt_count: i64,
    publication_key: String,
    external_id: Option<String>,
    url: Option<String>,
    published_at: Option<String>,
    raw_json: Option<String>,
}

/// A `verification_required` video job, its target and its draft's locale.
struct VideoRow {
    job_id: i64,
    kind: String,
    reconcile_attempt_count: i64,
    target_id: i64,
    video_draft_id: i64,
    target: String,
    delivery_provider: String,
    provider_post_id: Option<String>,
    external_id: Option<String>,
    external_url: Option<String>,
    published_at: Option<String>,
    verified_at: Option<String>,
    locale: String,
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object,
        _ => unreachable!("built as an object"),
    }
}

fn truthy(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
}

/// `runPublicationReconciliation`: the publication-reconciliation loop body.
pub async fn run_publication_reconciliation(delivery: &Delivery<'_>) -> Result<ReconciliationResult> {
    let sqlite = delivery.sqlite();
    let now_iso = delivery.now();
    let worker = format!("{}:{}", worker_id("reconciliation"), random_uuid());
    // It claims publish and video jobs, so it ages out on the publish lock.
    let stale_before = iso_at(delivery.now_ms() - PUBLISH_LOCK_TIMEOUT_SECONDS as i64 * 1000);
    let unanswered_before = iso_at(delivery.now_ms() - PROVIDER_CONFIRMATION_GRACE_MS);
    let (mut checked, mut resolved) = (0, 0);

    let ordinary: Vec<OrdinaryRow> = sqlite
        .prepare(
            r#"select "publish_jobs"."job_id", "publish_jobs"."target", "publish_jobs"."reconcile_attempt_count", "publication_targets"."publication_key", "publication_targets"."external_id", "publication_targets"."url", "publication_targets"."published_at", "publication_targets"."raw_json" from "publish_jobs" inner join "publication_targets" on ("publication_targets"."publication_key" = "publish_jobs"."publication_key" and "publication_targets"."target" = "publish_jobs"."target") where ("publish_jobs"."status" = ? and "publish_jobs"."reconcile_attempt_count" < ? and ("publish_jobs"."next_attempt_at" is null or "publish_jobs"."next_attempt_at" <= ?) and ("publish_jobs"."locked_by" is null or "publish_jobs"."locked_at" is null or "publish_jobs"."locked_at" < ?)) limit ?"#,
        )?
        .query_map(
            params!["verification_required", RECONCILE_MAX_ATTEMPTS, now_iso, stale_before, PUBLISH_CLAIM_LIMIT],
            |row: &Row<'_>| {
                Ok(OrdinaryRow {
                    job_id: row.get(0)?,
                    target: row.get(1)?,
                    reconcile_attempt_count: row.get(2)?,
                    publication_key: row.get(3)?,
                    external_id: row.get(4)?,
                    url: row.get(5)?,
                    published_at: row.get(6)?,
                    raw_json: row.get(7)?,
                })
            },
        )?
        .collect::<db::rusqlite::Result<_>>()?;
    let routing = target_routing(sqlite)?;
    for row in ordinary {
        let claimed = sqlite
            .query_row(
                r#"update "publish_jobs" set "locked_by" = ?, "locked_at" = ?, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ? and ("publish_jobs"."locked_by" is null or "publish_jobs"."locked_at" is null or "publish_jobs"."locked_at" < ?)) returning "job_id""#,
                params![worker, now_iso, now_iso, row.job_id, "verification_required", stale_before],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if claimed.is_none() {
            continue;
        }
        checked += 1;
        let Some(external_id) = truthy(&row.external_id).map(str::to_owned) else {
            defer_ordinary(delivery, row.job_id, row.reconcile_attempt_count, &worker)?;
            continue;
        };
        if is_target_auth_blocked(sqlite, delivery.clock(), &row.target)? {
            defer_ordinary(delivery, row.job_id, row.reconcile_attempt_count, &worker)?;
            continue;
        }
        let result = match verify_ordinary(delivery, &row, &external_id, &routing).await {
            Ok(result) => result,
            Err(error) => {
                if error.class() == PublishErrorClass::Auth {
                    delivery.boundaries.auth_circuit.record_failure(sqlite, &row.target)?;
                }
                defer_ordinary(delivery, row.job_id, row.reconcile_attempt_count, &worker)?;
                continue;
            }
        };
        let verification = result.get("verification").and_then(Value::as_object);
        let status = verification
            .and_then(|verification| verification.get("status"))
            .and_then(Value::as_str);
        let verification_error = verification
            .and_then(|verification| verification.get("error"))
            .and_then(Value::as_str);
        if status == Some("unavailable") && classify_message(verification_error) == PublishErrorClass::Auth {
            delivery.boundaries.auth_circuit.record_failure(sqlite, &row.target)?;
        }
        if status != Some("verified") {
            defer_ordinary(delivery, row.job_id, row.reconcile_attempt_count, &worker)?;
            continue;
        }
        delivery.boundaries.auth_circuit.record_success(sqlite, &row.target)?;
        let now = delivery.now();
        // The job's fence first; the target only if it held. A reconciliation
        // whose lock had been taken over used to publish the target anyway.
        let confirmed = confirm(sqlite, || {
            let won = sqlite
                .query_row(
                    r#"update "publish_jobs" set "status" = ?, "current_phase" = null, "locked_by" = null, "locked_at" = null, "last_error" = null, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ? and "publish_jobs"."locked_by" = ?) returning "job_id""#,
                    params!["published", now, row.job_id, "verification_required", worker],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if won.is_none() {
                return Ok(false);
            }
            let id = match result.get("id") {
                None | Some(Value::Null) => row.external_id.clone(),
                Some(id) => Some(foundation::js::string_of(id)),
            };
            let url = match result.get("url") {
                Some(Value::String(url)) => Some(url.clone()),
                _ => row.url.clone(),
            };
            // Deliberate deviation: the target is confirmed only while it is
            // still the unanswered publication this was decided on.
            let written = sqlite.execute(
                r#"update "publication_targets" set "status" = ?, "external_id" = ?, "error" = null, "url" = ?, "published_at" = ?, "confirmation_source" = ?, "verified_at" = ?, "updated_at" = ? where ("publication_targets"."publication_key" = ? and "publication_targets"."target" = ? and "publication_targets"."status" = ? and "publication_targets"."external_id" = ?)"#,
                params![
                    "published",
                    id,
                    url,
                    row.published_at.clone().unwrap_or_else(|| now.clone()),
                    "provider_verify",
                    now,
                    now,
                    row.publication_key,
                    row.target,
                    "verification_required",
                    external_id
                ],
            )?;
            if written != 1 {
                return Err(target_moved());
            }
            Ok(true)
        })?;
        if !confirmed {
            // Lost the job: its new owner settles it, and this write is
            // fenced out. Lost the target: let go of the job, so the next
            // poll is a fresh read rather than a lock left to age out.
            defer_ordinary(delivery, row.job_id, row.reconcile_attempt_count, &worker)?;
            continue;
        }
        refresh_publication_owner(&delivery.publishing(), &row.publication_key)?;
        record_event(
            sqlite,
            delivery.clock(),
            &DomainEventInput {
                publication_ref: Some(row.publication_key.clone()),
                event_type: "publish.job.reconciled".into(),
                severity: Severity::Info,
                target: Some(row.target.clone()),
                message: format!("{} publication was confirmed", row.target),
                details: Some(object(json!({
                    "job_id": row.job_id,
                    "external_id": external_id,
                    "confirmation_source": status.unwrap_or("stored_response"),
                }))),
                cooldown_seconds: None,
            },
        )?;
        resolved += 1;
    }

    // A publication whose provider never answered stops being "in flight",
    // and the operator has to hear about it: silence was the third ending.
    let stranded: Vec<i64> = sqlite
        .prepare(
            r#"select distinct "video_draft_id" from "video_targets" where ("video_targets"."status" = ? and "video_targets"."updated_at" < ?)"#,
        )?
        .query_map(params!["verification_required", unanswered_before], |row| row.get(0))?
        .collect::<db::rusqlite::Result<_>>()?;
    for video_draft_id in stranded {
        delivery
            .boundaries
            .video_completion
            .record_if_final(sqlite, video_draft_id)?;
    }

    let videos: Vec<VideoRow> = sqlite
        .prepare(
            r#"select "video_jobs"."id", "video_jobs"."kind", "video_jobs"."reconcile_attempt_count", "video_targets"."id", "video_targets"."video_draft_id", "video_targets"."target", "video_targets"."delivery_provider", "video_targets"."provider_post_id", "video_targets"."external_id", "video_targets"."external_url", "video_targets"."published_at", "video_targets"."verified_at", "video_drafts"."locale" from "video_targets" inner join "video_drafts" on "video_drafts"."id" = "video_targets"."video_draft_id" inner join "video_jobs" on "video_jobs"."video_target_id" = "video_targets"."id" where ("video_targets"."status" = ? and "video_jobs"."status" = ? and "video_jobs"."reconcile_attempt_count" < ? and ("video_jobs"."next_attempt_at" is null or "video_jobs"."next_attempt_at" <= ?) and ("video_jobs"."locked_by" is null or "video_jobs"."locked_at" is null or "video_jobs"."locked_at" < ?)) limit ?"#,
        )?
        .query_map(
            params![
                "verification_required",
                "verification_required",
                RECONCILE_MAX_ATTEMPTS,
                now_iso,
                stale_before,
                PUBLISH_CLAIM_LIMIT
            ],
            |row| {
                Ok(VideoRow {
                    job_id: row.get(0)?,
                    kind: row.get(1)?,
                    reconcile_attempt_count: row.get(2)?,
                    target_id: row.get(3)?,
                    video_draft_id: row.get(4)?,
                    target: row.get(5)?,
                    delivery_provider: row.get(6)?,
                    provider_post_id: row.get(7)?,
                    external_id: row.get(8)?,
                    external_url: row.get(9)?,
                    published_at: row.get(10)?,
                    verified_at: row.get(11)?,
                    locale: row.get(12)?,
                })
            },
        )?
        .collect::<db::rusqlite::Result<_>>()?;
    for row in videos {
        let claimed = sqlite
            .query_row(
                r#"update "video_jobs" set "locked_by" = ?, "locked_at" = ?, "updated_at" = ? where ("video_jobs"."id" = ? and "video_jobs"."status" = ? and ("video_jobs"."locked_by" is null or "video_jobs"."locked_at" is null or "video_jobs"."locked_at" < ?)) returning "id""#,
                params![worker, now_iso, now_iso, row.job_id, "verification_required", stale_before],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if claimed.is_none() {
            continue;
        }
        checked += 1;
        let locale = if row.locale == "en" { Locale::En } else { Locale::Ru };
        let locale_code = if locale == Locale::En { "en" } else { "ru" };
        let credential_target = match VideoTarget::parse(&row.target) {
            Some(target) => video_channel_identity(sqlite, target, locale_code)?,
            None => format!("undefined_{locale_code}"),
        };
        if is_target_auth_blocked(sqlite, delivery.clock(), &credential_target)? {
            defer_video(delivery, row.job_id, row.reconcile_attempt_count, &worker)?;
            continue;
        }
        // Native Reels are absent on purpose: before media_publish returns the
        // only handle is a container id, and Graph cannot say what media a
        // container became. Those close through an operator.
        let mut confirmation: Option<(Option<String>, Option<String>)> = None;
        let mut provider_failure: Option<String> = None;
        let asked = async {
            if row.delivery_provider == "zernio"
                && let Some(provider_post_id) = truthy(&row.provider_post_id)
            {
                let outcome =
                    zernio_post_outcome(&delivery.adapters, provider_post_id, ZernioPlatform::Instagram).await?;
                provider_failure = outcome.failure;
                let publication = outcome.publication;
                if truthy(&publication.external_id).is_some() || truthy(&publication.url).is_some() {
                    confirmation = Some((publication.external_id, publication.url));
                }
            } else if row.target == "youtube_shorts"
                && let Some(external_id) = truthy(&row.external_id)
            {
                let verified = verify_youtube_video(&delivery.adapters, external_id, locale).await?;
                if row.kind == "prepare" || verified.privacy_status.as_deref() == Some("public") {
                    confirmation = Some((Some(verified.id), Some(verified.url)));
                }
            }
            Ok::<_, providers::adapters::AdapterError>(())
        }
        .await;
        if let Err(error) = asked {
            if error.class() == PublishErrorClass::Auth {
                delivery
                    .boundaries
                    .auth_circuit
                    .record_failure(sqlite, &credential_target)?;
            }
            defer_video(delivery, row.job_id, row.reconcile_attempt_count, &worker)?;
            continue;
        }
        // A provider-reported failure is not the platform's answer: Zernio has
        // reported a live Reel as failed. While it holds a post id there is
        // something to keep asking, and past the budget an operator decides.
        // Nothing here turns a provider verdict into permission to send again.
        let Some((external_id, url)) = confirmation else {
            match provider_failure.filter(|failure| !failure.is_empty()) {
                Some(failure) => escalate_unanswered_video(delivery, &row, &failure, &worker)?,
                None => defer_video(delivery, row.job_id, row.reconcile_attempt_count, &worker)?,
            }
            continue;
        };
        delivery
            .boundaries
            .auth_circuit
            .record_success(sqlite, &credential_target)?;
        let now = delivery.now();
        let prepared = row.kind == "prepare";
        let confirmed = confirm(sqlite, || {
            let won = sqlite
                .query_row(
                    r#"update "video_jobs" set "status" = ?, "last_error" = null, "locked_at" = null, "locked_by" = null, "updated_at" = ? where ("video_jobs"."video_target_id" = ? and "video_jobs"."status" = ? and "video_jobs"."locked_by" = ?) returning "id""#,
                    params!["completed", now, row.target_id, "verification_required", worker],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if won.is_none() {
                return Ok(false);
            }
            let written = sqlite.execute(
                r#"update "video_targets" set "status" = ?, "external_id" = ?, "external_url" = ?, "last_error" = null, "published_at" = ?, "confirmation_source" = ?, "verified_at" = ?, "updated_at" = ? where ("video_targets"."id" = ? and "video_targets"."status" = ?)"#,
                params![
                    if prepared { "prepared" } else { "published" },
                    external_id.clone().or_else(|| row.external_id.clone()),
                    url.clone().or_else(|| row.external_url.clone()),
                    if prepared {
                        row.published_at.clone()
                    } else {
                        Some(row.published_at.clone().unwrap_or_else(|| now.clone()))
                    },
                    "provider_verify",
                    if prepared { row.verified_at.clone() } else { Some(now.clone()) },
                    now,
                    row.target_id,
                    "verification_required"
                ],
            )?;
            // Deliberate deviation: the job completes only with the target it
            // established.
            if written != 1 {
                return Err(target_moved());
            }
            Ok(true)
        })?;
        if !confirmed {
            defer_video(delivery, row.job_id, row.reconcile_attempt_count, &worker)?;
            continue;
        }
        let retention_hours = StudioSettingsStore::new(sqlite).profile()?.video_retention_hours;
        delivery
            .publishing()
            .refresh_video_draft_status(row.video_draft_id, retention_hours)?;
        // The publication held its outcome until this answer: the operator
        // hears it now — once, and true.
        delivery
            .boundaries
            .video_completion
            .record_if_final(sqlite, row.video_draft_id)?;
        record_event(
            sqlite,
            delivery.clock(),
            &DomainEventInput {
                publication_ref: Some(publication_ref(PublicationRefKind::Video, row.video_draft_id)),
                event_type: "video.target.reconciled".into(),
                severity: Severity::Info,
                target: Some(row.target.clone()),
                message: format!("{} video publication was confirmed", row.target),
                details: Some(object(
                    json!({"videoTargetId": row.target_id, "confirmation_source": "provider_verify"}),
                )),
                cooldown_seconds: None,
            },
        )?;
        resolved += 1;
    }

    // Age is read from the targets, never the jobs: deferring a poll touches
    // the job row, and an inbox that never ages is one nobody escalates.
    let publications: Vec<Option<String>> = sqlite
        .prepare(r#"select "updated_at" from "publication_targets" where "publication_targets"."status" = ?"#)?
        .query_map(["verification_required"], |row| row.get(0))?
        .collect::<db::rusqlite::Result<_>>()?;
    let videos: Vec<(Option<String>, Option<String>)> = sqlite
        .prepare(r#"select "updated_at", "provider_post_id" from "video_targets" where "video_targets"."status" = ?"#)?
        .query_map(["verification_required"], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<db::rusqlite::Result<_>>()?;
    let present = |times: Vec<Option<String>>| -> Vec<String> {
        let mut times: Vec<String> = times.into_iter().flatten().filter(|at| !at.is_empty()).collect();
        times.sort();
        times
    };
    let unresolved = present(
        publications
            .iter()
            .cloned()
            .chain(videos.iter().map(|(at, _)| at.clone()))
            .collect(),
    );
    let alertable = present(
        publications
            .iter()
            .cloned()
            .chain(
                videos
                    .iter()
                    .filter(|(at, provider_post_id)| {
                        truthy(provider_post_id).is_none()
                            || at.as_deref().unwrap_or_default() < unanswered_before.as_str()
                    })
                    .map(|(at, _)| at.clone()),
            )
            .collect(),
    );
    if let Some(oldest) = alertable.first() {
        record_event(
            sqlite,
            delivery.clock(),
            &DomainEventInput {
                publication_ref: None,
                event_type: "studio.notification.publication_verification_required".into(),
                severity: Severity::Warn,
                target: None,
                message: format!(
                    "{} publication(s) still require verification; oldest since {oldest}",
                    alertable.len()
                ),
                details: Some(object(json!({"count": alertable.len(), "oldest_at": oldest}))),
                cooldown_seconds: Some(ALERT_COOLDOWN_SECONDS as u64),
            },
        )?;
    }
    Ok(ReconciliationResult {
        checked,
        resolved,
        oldest_at: unresolved.first().cloned(),
        unresolved: unresolved.len(),
    })
}

const TARGET_MOVED: &str = "reconciliation_target_moved";

/// Both writes of a confirmation in one transaction: `work` answers whether
/// the job's fence held, and a target fence that did not hold rolls the job's
/// write back with it.
fn confirm(sqlite: &db::rusqlite::Connection, work: impl FnOnce() -> Result<bool>) -> Result<bool> {
    match transaction(sqlite, work) {
        Err(Error::Message(message)) if message == TARGET_MOVED => Ok(false),
        outcome => outcome,
    }
}

fn target_moved() -> Error {
    Error::message(TARGET_MOVED)
}

/// What the provider says about an ordinary publication: through Zernio
/// when it was routed there and holds the provider's id, else the platform.
async fn verify_ordinary(
    delivery: &Delivery<'_>,
    row: &OrdinaryRow,
    external_id: &str,
    routing: &providers::adapters::TargetRouting,
) -> providers::adapters::Result<Map<String, Value>> {
    let provider_result = match row.raw_json.as_deref().map(serde_json::from_str::<Value>) {
        Some(Ok(Value::Object(result))) => result,
        _ => Map::new(),
    };
    let provider_post_id = provider_result
        .get("providerPostId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let platform = if THREADS_TARGETS.contains(&row.target.as_str()) {
        Some(ZernioPlatform::Threads)
    } else if INSTAGRAM_STORY_TARGETS.contains(&row.target.as_str()) {
        Some(ZernioPlatform::Instagram)
    } else {
        None
    };
    let routed = routing
        .0
        .iter()
        .find(|(target, _)| *target == row.target)
        .is_some_and(|(_, route)| route.provider == "zernio");
    let url = row.url.clone().map_or(Value::Null, Value::from);
    if let (true, Some(provider_post_id), Some(platform)) = (routed, truthy(&provider_post_id), platform) {
        let verified = verify_zernio_post(&delivery.adapters, provider_post_id, platform).await?;
        return Ok(object(match verified.external_id {
            Some(id) if !id.is_empty() => json!({
                "ok": true,
                "id": id,
                "url": verified.url.map_or(url, Value::from),
                "providerPostId": provider_post_id,
                "verification": {"status": "verified", "providerId": id},
            }),
            _ => json!({
                "ok": true,
                "id": external_id,
                "url": url,
                "providerPostId": provider_post_id,
                "verification": {"status": "unavailable", "error": format!("{} publication is still pending at Zernio", platform.as_str())},
            }),
        }));
    }
    let stored = object(json!({"ok": true, "id": external_id, "url": url}));
    Ok(verify_platform_publication(&delivery.adapters, &row.target, stored).await)
}

/// The next poll, past the budget none: an operator decides.
fn reconciliation_next_attempt(delivery: &Delivery<'_>, attempt: i64) -> Option<String> {
    (attempt < RECONCILE_MAX_ATTEMPTS).then(|| {
        next_retry_at(
            attempt as u32,
            PUBLISH_BACKOFF_BASE_SECONDS,
            PUBLISH_BACKOFF_MAX_SECONDS,
            delivery.now_ms(),
            None,
            delivery.boundaries.jitter,
        )
    })
}

fn defer_ordinary(delivery: &Delivery<'_>, job_id: i64, attempts: i64, owner: &str) -> Result<()> {
    let attempt = attempts + 1;
    delivery.sqlite().execute(
        r#"update "publish_jobs" set "reconcile_attempt_count" = ?, "next_attempt_at" = ?, "locked_by" = null, "locked_at" = null, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ? and "publish_jobs"."locked_by" = ?)"#,
        params![
            attempt,
            reconciliation_next_attempt(delivery, attempt),
            delivery.now(),
            job_id,
            "verification_required",
            owner
        ],
    )?;
    Ok(())
}

fn defer_video(delivery: &Delivery<'_>, job_id: i64, attempts: i64, owner: &str) -> Result<()> {
    let attempt = attempts + 1;
    delivery.sqlite().execute(
        r#"update "video_jobs" set "reconcile_attempt_count" = ?, "next_attempt_at" = ?, "locked_by" = null, "locked_at" = null, "updated_at" = ? where ("video_jobs"."id" = ? and "video_jobs"."status" = ? and "video_jobs"."locked_by" = ?)"#,
        params![
            attempt,
            reconciliation_next_attempt(delivery, attempt),
            delivery.now(),
            job_id,
            "verification_required",
            owner
        ],
    )?;
    Ok(())
}

/// `escalateUnansweredVideo`: the provider's own refusal is an answer about
/// the publication and still not proof nothing reached the audience. At the
/// end of the budget the target says so, once; never on an ordinary deferral,
/// because the incident's age is read from it.
fn escalate_unanswered_video(delivery: &Delivery<'_>, row: &VideoRow, failure: &str, owner: &str) -> Result<()> {
    let exhausted = row.reconcile_attempt_count + 1 >= RECONCILE_MAX_ATTEMPTS;
    defer_video(delivery, row.job_id, row.reconcile_attempt_count, owner)?;
    if !exhausted {
        return Ok(());
    }
    let sqlite = delivery.sqlite();
    // Fenced on the state this was decided from: the operator may have
    // answered the target while the provider was being asked.
    let marked = sqlite
        .query_row(
            r#"update "video_targets" set "last_error" = ?, "updated_at" = ? where ("video_targets"."id" = ? and "video_targets"."status" = ?) returning "id""#,
            params![failure, delivery.now(), row.target_id, "verification_required"],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if marked.is_none() {
        return Ok(());
    }
    record_event(
        sqlite,
        delivery.clock(),
        &DomainEventInput {
            publication_ref: Some(publication_ref(PublicationRefKind::Video, row.video_draft_id)),
            event_type: "video.target.unresolved".into(),
            severity: Severity::Warn,
            target: Some(row.target.clone()),
            message: failure.to_owned(),
            details: Some(object(json!({
                "videoDraftId": row.video_draft_id,
                "videoTargetId": row.target_id,
                "jobId": row.job_id,
                "provider_post_id": row.provider_post_id,
                "attempts": row.reconcile_attempt_count + 1,
            }))),
            cooldown_seconds: None,
        },
    )?;
    Ok(())
}
