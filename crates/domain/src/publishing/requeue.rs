//! The one way a publication target goes back into the queue. Studio's retry
//! button and `ops retry` both come here, and the question that matters —
//! whether a target whose provider call may have landed can be published
//! again — is answered once: it cannot, unless the caller says it is
//! republishing.

use content::text_locale::text_locale;
use db::rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::Publishing;
use super::cancellation::clear_delivery_cancellation;
use super::delivery_payload::{
    DeliveryPayload, RestartReason, continued_delivery_payload, has_resume_state, new_delivery_payload,
    restarted_delivery_payload,
};
use super::job_policy::{requeued_post_target, requeued_publish_job_columns};
use super::payload::localize_target_payload;
use super::publication_source::PublicationSource;
use super::queue_state::{assignments, insert_event, int, parse_payload, text};
use crate::Result;
use crate::repositories::transaction;
use crate::targets::{is_site_target, target_locale};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RequeueOutcome {
    Requeued,
    AlreadyQueued,
    NotRetryable,
}

impl RequeueOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Requeued => "requeued",
            Self::AlreadyQueued => "already_queued",
            Self::NotRetryable => "not_retryable",
        }
    }
}

/// Why a target was left alone when the state alone does not say it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RequeueRefusal {
    Empty,
    Language,
    AlreadyDelivered,
}

impl RequeueRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Language => "language",
            Self::AlreadyDelivered => "already_delivered",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RequeueResult {
    pub target: String,
    pub outcome: RequeueOutcome,
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<RequeueRefusal>,
}

impl RequeueResult {
    fn new(target: &str, outcome: RequeueOutcome, status: Option<&str>) -> Self {
        Self {
            target: target.to_owned(),
            outcome,
            status: status.map(str::to_owned),
            reason: None,
        }
    }
}

/// An operator restores a target whatever state it reached. The two states
/// missing here belong to someone else: `publishing` to a live worker,
/// `verification_required` to reconciliation.
pub const RETRY_UNLESS_HELD: [&str; 5] = ["queued", "failed", "cancelled", "skipped", "published"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequeueScope {
    pub post_id: Option<i64>,
    pub publication_key: String,
}

/// What may happen to a target that already put something in front of the
/// audience. `Resume` continues from the ids the job carries and refuses
/// when there are none — the only safe answer for a button, which cannot
/// ask. `Republish` sends the whole publication again, which only an
/// operator restoring a removed post may decide.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudienceReached {
    Resume,
    Republish,
}

pub struct RequeueOptions<'a> {
    /// Job states this caller may pull back.
    pub from: &'a [&'a str],
    /// Create a publish job for a target that never had one.
    pub create_missing: bool,
    pub audience_reached: AudienceReached,
    /// The durable publication source, read at most once and only when a job
    /// is actually requeued.
    pub source: &'a dyn Fn() -> Result<PublicationSource>,
}

/// The queue is the last place a wrong-language publication can be stopped,
/// and the only one on this path: a requeue builds no draft, so preflight
/// never sees it.
fn unpublishable(payload: &Map<String, Value>, target: &str) -> Option<RequeueRefusal> {
    let text = match payload.get("text") {
        None | Some(Value::Null) => String::new(),
        Some(value) => foundation::js::string_of(value),
    };
    let text = foundation::js::trim(&text);
    let has_media = payload
        .get("media")
        .and_then(Value::as_array)
        .is_some_and(|media| !media.is_empty());
    if text.is_empty() && !has_media {
        return Some(RequeueRefusal::Empty);
    }
    let locale = target_locale(target)?;
    if text.is_empty() {
        return None;
    }
    text_locale(text)
        .filter(|written| *written != locale)
        .map(|_| RequeueRefusal::Language)
}

impl Publishing<'_> {
    pub fn requeue_publication_targets(
        &self,
        scope: &RequeueScope,
        targets: &[&str],
        options: &RequeueOptions<'_>,
    ) -> Result<Vec<RequeueResult>> {
        transaction(self.sqlite, || {
            self.requeue_publication_targets_tx(scope, targets, options)
        })
    }

    /// The same transition for callers already committing a larger operation.
    pub fn requeue_publication_targets_tx(
        &self,
        scope: &RequeueScope,
        targets: &[&str],
        options: &RequeueOptions<'_>,
    ) -> Result<Vec<RequeueResult>> {
        let now = self.now();
        let mut cached: Option<PublicationSource> = None;
        let mut source = || -> Result<PublicationSource> {
            if cached.is_none() {
                cached = Some((options.source)()?);
            }
            Ok(cached.clone().expect("cached above"))
        };
        let mut results = Vec::new();
        let mut seen: Vec<&str> = Vec::new();
        for target in targets.iter().copied() {
            if seen.contains(&target) {
                continue;
            }
            seen.push(target);
            results.push(if is_site_target(target) {
                requeue_site_target(self.sqlite, scope, target, options, &now)?
            } else {
                self.requeue_social_target(scope, target, options, &mut source, &now)?
            });
        }
        // Only when something is actually going out again: moving the
        // publication back to `scheduled` otherwise says a delivery is under way.
        if let Some(post_id) = scope.post_id
            && results.iter().any(|result| result.outcome == RequeueOutcome::Requeued)
        {
            self.sqlite.execute(
                r#"update "drafts" set "status" = ?, "updated_at" = ? where "drafts"."post_id" = ?"#,
                params!["scheduled", now, post_id],
            )?;
            // Asking for a target to go out again withdraws the standing
            // "cancel the rest": otherwise the claim would refuse this job.
            clear_delivery_cancellation(self.sqlite, &scope.publication_key)?;
        }
        Ok(results)
    }

    fn requeue_social_target(
        &self,
        scope: &RequeueScope,
        target: &str,
        options: &RequeueOptions<'_>,
        source: &mut dyn FnMut() -> Result<PublicationSource>,
        now: &str,
    ) -> Result<RequeueResult> {
        let sqlite = self.sqlite;
        let row: Option<(i64, String, String, Option<String>)> = sqlite
            .query_row(
                r#"select "job_id", "publication_key", "status", "payload_json" from "publish_jobs" where ("publish_jobs"."publication_key" = ? and "publish_jobs"."target" = ?) order by "publish_jobs"."job_id" desc"#,
                params![scope.publication_key, target],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((job_id, publication_key, status, payload_json)) = row else {
            if !options.create_missing {
                return Ok(RequeueResult::new(target, RequeueOutcome::NotRetryable, None));
            }
            return create_publish_job(self, scope, target, &source()?, now);
        };
        if status == "queued" {
            return Ok(RequeueResult::new(target, RequeueOutcome::AlreadyQueued, Some(&status)));
        }
        if !options.from.contains(&status.as_str()) {
            return Ok(RequeueResult::new(target, RequeueOutcome::NotRetryable, Some(&status)));
        }
        // The payload is rebuilt from the durable source, which knows the post
        // and not the delivery: the ids of what already went out live on the
        // job alone. A caller that is republishing carries none of it forward.
        let fields = localize_target_payload(&source()?, target);
        let payload = match options.audience_reached {
            AudienceReached::Resume => {
                continued_delivery_payload(Some(&parse_payload(payload_json.as_deref())), fields)
            }
            AudienceReached::Republish => restarted_delivery_payload(fields, RestartReason::OperatorRepublish),
        };
        if let Some(reason) = unpublishable(payload.fields(), target) {
            return Ok(RequeueResult {
                reason: Some(reason),
                ..RequeueResult::new(target, RequeueOutcome::NotRetryable, Some(&status))
            });
        }
        // Asked in the same breath as the write it guards, off the row about
        // to be overwritten.
        if options.audience_reached == AudienceReached::Resume
            && reached_audience(sqlite, &publication_key, target)?
            && !has_resume_state(payload.fields())
        {
            return Ok(RequeueResult {
                reason: Some(RequeueRefusal::AlreadyDelivered),
                ..RequeueResult::new(target, RequeueOutcome::NotRetryable, Some(&status))
            });
        }
        // Fenced on the status this decision was made from: a worker claiming
        // the job in between keeps it.
        let columns = requeued_publish_job_columns(&payload, now);
        let requeued = sqlite
            .query_row(
                &format!(
                    r#"update "publish_jobs" set {} where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ?) returning "job_id""#,
                    assignments(&columns)
                ),
                db::rusqlite::params_from_iter(
                    columns
                        .iter()
                        .map(|(_, value)| value.clone())
                        .chain([int(job_id), text(status.as_str())]),
                ),
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if requeued.is_none() {
            return Ok(RequeueResult::new(target, RequeueOutcome::NotRetryable, Some(&status)));
        }
        mirror_requeued_target(
            sqlite,
            &publication_key,
            target,
            now,
            has_resume_state(payload.fields()),
        )?;
        Ok(RequeueResult::new(target, RequeueOutcome::Requeued, Some(&status)))
    }
}

/// The site is rendered from `site_jobs`, keyed by a publish reason; routing
/// it with the rest used to manufacture a publish job no publisher serves.
fn requeue_site_target(
    sqlite: &Connection,
    scope: &RequeueScope,
    target: &str,
    options: &RequeueOptions<'_>,
    now: &str,
) -> Result<RequeueResult> {
    let row: Option<(i64, String)> = sqlite
        .query_row(
            r#"select "job_id", "status" from "site_jobs" where ("site_jobs"."publication_key" = ? and "site_jobs"."reason" = ?) order by "site_jobs"."job_id" desc"#,
            params![scope.publication_key, target],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    // Fabricating a site job is a different operation (`ops repair-content`).
    let Some((job_id, status)) = row else {
        return Ok(RequeueResult::new(target, RequeueOutcome::NotRetryable, None));
    };
    if status == "queued" {
        return Ok(RequeueResult::new(target, RequeueOutcome::AlreadyQueued, Some(&status)));
    }
    // The one target where `verification_required` is retryable: rendering
    // the page again produces the same page.
    if !options.from.contains(&status.as_str()) && status != "verification_required" {
        return Ok(RequeueResult::new(target, RequeueOutcome::NotRetryable, Some(&status)));
    }
    let requeued = sqlite
        .query_row(
            r#"update "site_jobs" set "status" = ?, "attempt_count" = ?, "next_attempt_at" = null, "locked_by" = null, "locked_at" = null, "last_error" = null, "updated_at" = ? where ("site_jobs"."job_id" = ? and "site_jobs"."status" = ?) returning "job_id""#,
            params!["queued", 0, now, job_id, status],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if requeued.is_none() {
        return Ok(RequeueResult::new(target, RequeueOutcome::NotRetryable, Some(&status)));
    }
    mirror_requeued_target(sqlite, &scope.publication_key, target, now, false)?;
    Ok(RequeueResult::new(target, RequeueOutcome::Requeued, Some(&status)))
}

fn create_publish_job(
    publishing: &Publishing<'_>,
    scope: &RequeueScope,
    target: &str,
    source: &PublicationSource,
    now: &str,
) -> Result<RequeueResult> {
    // A target that never had a job has published nothing by definition.
    let payload: DeliveryPayload = new_delivery_payload(localize_target_payload(source, target));
    if let Some(reason) = unpublishable(payload.fields(), target) {
        return Ok(RequeueResult {
            reason: Some(reason),
            ..RequeueResult::new(target, RequeueOutcome::NotRetryable, None)
        });
    }
    publishing.sqlite.execute(
        r#"insert into "publish_jobs" ("publication_key", "target", "status", "attempt_count", "publish_at", "next_attempt_at", "locked_by", "locked_at", "payload_json", "last_error", "created_at", "updated_at") values (?, ?, ?, ?, ?, null, null, null, ?, null, ?, ?)"#,
        params![
            scope.publication_key,
            target,
            "queued",
            0,
            now,
            crate::json::stringify_object(payload.fields()),
            now,
            now
        ],
    )?;
    mirror_requeued_target(publishing.sqlite, &scope.publication_key, target, now, false)?;
    Ok(RequeueResult::new(target, RequeueOutcome::Requeued, None))
}

/// Whether this target already has a remote object to its name. Status alone
/// does not answer it: a partially published chain settles as `failed` while
/// its first message is live.
fn reached_audience(sqlite: &Connection, publication_key: &str, target: &str) -> Result<bool> {
    Ok(sqlite
        .query_row(
            r#"select "external_id" from "publication_targets" where ("publication_targets"."publication_key" = ? and "publication_targets"."target" = ?)"#,
            params![publication_key, target],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .is_some_and(|id| !id.is_empty()))
}

/// The mirrored target row. When the row named a live object and is about to
/// stop naming it, the journal keeps the id, in the same transaction as the
/// requeue that forgot it.
fn mirror_requeued_target(
    sqlite: &Connection,
    publication_key: &str,
    target: &str,
    now: &str,
    resuming: bool,
) -> Result<()> {
    let previous: Option<(Option<String>, Option<String>)> = sqlite
        .query_row(
            r#"select "status", "external_id", "url" from "publication_targets" where ("publication_targets"."publication_key" = ? and "publication_targets"."target" = ?)"#,
            params![publication_key, target],
            |row| Ok((row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    super::queue_state::upsert_post_target(sqlite, publication_key, target, &requeued_post_target(now, resuming))?;
    let Some((Some(external_id), url)) = previous.filter(|_| !resuming) else {
        return Ok(());
    };
    if external_id.is_empty() {
        return Ok(());
    }
    insert_event(
        sqlite,
        Some(publication_key),
        Some(target),
        "publish.target.identity_dropped",
        "warn",
        &format!("{target} was requeued while it still named a live post; that post is no longer referenced"),
        &json!({ "external_id": external_id, "url": url }),
        now,
    )
}
