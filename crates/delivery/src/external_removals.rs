//! Published remote objects removed before a
//! controlled replacement. The remote calls happen first; their outcomes are
//! settled afterwards inside the caller's transaction — beside the requeue and
//! the journal entry — and only onto a target that still names the object
//! that was acted on.

use std::rc::Rc;

use content::Locale;
use db::rusqlite::{Connection, OptionalExtension as _, params};
use domain::json::stringify;
use domain::targets::target_locale;
use foundation::json::id_text;
use providers::adapters::telegram_stories::{StoryError, StoryRequest};
use providers::adapters::{StoriesClient, TargetRouting, Unprepared, create_platform_adapters};
use runtime::http::Fut;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Delivery, Result};

/// Edits and removals never publish a Story.
pub(crate) struct NoStories;

impl StoriesClient for NoStories {
    fn send_story<'a>(&'a self, _: &'a StoryRequest) -> Fut<'a, std::result::Result<i64, StoryError>> {
        Box::pin(async { Err(StoryError::Refused("stories are not published from here".into())) })
    }
}

/// Which published targets to remove (`RemovalOptions`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalOptions {
    pub publication_key: String,
    pub target: Option<String>,
    /// `ru` or `en`.
    pub locale: Option<String>,
}

/// The target row a removal acted on, as it was read.
#[derive(Clone, Debug, PartialEq)]
pub struct PublishedTarget {
    pub publication_key: String,
    pub target: String,
    pub external_id: Option<String>,
    pub external_ids: Option<Vec<String>>,
}

/// What a removal came to remotely (`TargetRemovalAttempt.outcome`).
#[derive(Clone, Debug, PartialEq)]
pub enum RemovalOutcome {
    Removed {
        deleted: Vec<String>,
        remaining: Vec<String>,
        error: Option<String>,
    },
    Skipped(String),
    Failed(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct TargetRemovalAttempt {
    pub row: PublishedTarget,
    pub outcome: RemovalOutcome,
}

/// `TargetRemovalResult`, for Operations and hence the audit log.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TargetRemovalResult {
    pub target: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TargetRemovalResult {
    fn new(target: &str, ok: bool) -> Self {
        Self {
            target: target.to_owned(),
            ok,
            skipped: None,
            stale: None,
            deleted: None,
            remaining: None,
            error: None,
        }
    }
}

/// `attemptPublishedTargetRemovals`: every published target asked for,
/// removed remotely; a target with no remove port is an explicit failure,
/// never a silent success.
pub async fn attempt_published_target_removals(
    delivery: &Delivery<'_>,
    options: &RemovalOptions,
) -> Result<Vec<TargetRemovalAttempt>> {
    let rows: Vec<PublishedTarget> = delivery
        .sqlite()
        .prepare(
            r#"select "publication_key", "target", "external_id", "external_ids_json" from "publication_targets" where ("publication_targets"."publication_key" = ? and "publication_targets"."status" = ?)"#,
        )?
        .query_map(params![options.publication_key, "published"], |row| {
            let ids: Option<String> = row.get(3)?;
            Ok(PublishedTarget {
                publication_key: row.get(0)?,
                target: row.get(1)?,
                external_id: row.get(2)?,
                external_ids: match ids.as_deref().map(serde_json::from_str::<Value>) {
                    Some(Ok(Value::Array(ids))) => Some(ids.iter().filter_map(id_text).collect()),
                    _ => None,
                },
            })
        })?
        .collect::<db::rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|row| options.target.as_ref().is_none_or(|target| *target == row.target))
        .filter(|row| {
            options
                .locale
                .as_deref()
                .is_none_or(|locale| target_locale(&row.target).map(Locale::as_str) == Some(locale))
        })
        .collect();
    let adapters = create_platform_adapters(
        delivery.adapters.clone(),
        Rc::new(Unprepared),
        Rc::new(NoStories),
        &TargetRouting::default(),
    );
    let mut attempts = Vec::new();
    for row in rows {
        let ids = match (&row.external_ids, &row.external_id) {
            (Some(ids), _) if !ids.is_empty() => ids.clone(),
            (_, Some(id)) if !id.is_empty() => vec![id.clone()],
            _ => Vec::new(),
        };
        let outcome = if ids.is_empty() {
            RemovalOutcome::Skipped("missing external id".into())
        } else {
            match adapters.get(&row.target) {
                Some(adapter) if adapter.remove("").is_some() => {
                    // Every id it was given, not stopping at the first failure:
                    // the ones behind it are the tail of a split post.
                    let (mut deleted, mut remaining, mut error) = (Vec::new(), Vec::new(), None);
                    for id in ids {
                        let removed = adapter.remove(&id).expect("the target has a remove port").await;
                        match removed {
                            Ok(_) => deleted.push(id),
                            Err(failure) => {
                                remaining.push(id);
                                error.get_or_insert_with(|| failure.message().to_owned());
                            }
                        }
                    }
                    RemovalOutcome::Removed {
                        deleted,
                        remaining,
                        error,
                    }
                }
                _ => RemovalOutcome::Failed(format!("remote deletion is not supported for {}", row.target)),
            }
        };
        attempts.push(TargetRemovalAttempt { row, outcome });
    }
    Ok(attempts)
}

/// `settlePublishedTargetRemovals`: run by the caller in the transaction
/// that requeues and journals, so taking the publication down and recording
/// it are one write.
pub fn settle_published_target_removals(
    sqlite: &Connection,
    attempts: &[TargetRemovalAttempt],
    now: &str,
) -> Result<Vec<TargetRemovalResult>> {
    let mut results = Vec::new();
    for TargetRemovalAttempt { row, outcome } in attempts {
        let (deleted, remaining, error) = match outcome {
            RemovalOutcome::Skipped(error) => {
                let mut result = TargetRemovalResult::new(&row.target, false);
                result.skipped = Some(true);
                result.error = Some(error.clone());
                results.push(result);
                continue;
            }
            RemovalOutcome::Failed(error) => {
                let mut result = TargetRemovalResult::new(&row.target, false);
                result.error = Some(error.clone());
                results.push(result);
                continue;
            }
            RemovalOutcome::Removed {
                deleted,
                remaining,
                error,
            } => (deleted, remaining, error),
        };
        // The same remote object: this target, still published, still naming
        // the id that was removed.
        let same_object = r#""publication_targets"."publication_key" = ? and "publication_targets"."target" = ? and "publication_targets"."status" = ? and "publication_targets"."external_id" is ?"#;
        let updated = if remaining.is_empty() {
            sqlite
                .query_row(
                    &format!(
                        r#"update "publication_targets" set "status" = ?, "external_id" = null, "external_ids_json" = null, "url" = null, "error" = null, "published_at" = null, "verified_at" = null, "updated_at" = ?, "raw_json" = ? where ({same_object}) returning "target""#
                    ),
                    params![
                        "deleted",
                        now,
                        stringify(&json!({"deleted": true, "ids": deleted})),
                        row.publication_key,
                        row.target,
                        "published",
                        row.external_id
                    ],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        } else {
            sqlite
                .query_row(
                    &format!(
                        r#"update "publication_targets" set "external_id" = ?, "external_ids_json" = ?, "error" = ?, "updated_at" = ?, "raw_json" = ? where ({same_object}) returning "target""#
                    ),
                    params![
                        remaining.first(),
                        stringify(&json!(remaining)),
                        error.clone().unwrap_or_else(|| "partial remote deletion".into()),
                        now,
                        stringify(&json!({"deleted": deleted, "remaining": remaining})),
                        row.publication_key,
                        row.target,
                        "published",
                        row.external_id
                    ],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        };
        let mut result = TargetRemovalResult::new(&row.target, false);
        result.deleted = Some(deleted.len());
        if updated.is_none() {
            result.stale = Some(true);
            result.remaining = Some(remaining.len());
            result.error = Some("target changed while remote deletion was in flight".into());
        } else if remaining.is_empty() {
            cancel_deleted_publish_job(sqlite, row, now)?;
            result.ok = true;
        } else {
            result.remaining = Some(remaining.len());
            result.error = error.clone();
        }
        results.push(result);
    }
    Ok(results)
}

/// The published job of a target that is gone has nothing left to deliver.
fn cancel_deleted_publish_job(sqlite: &Connection, target: &PublishedTarget, now: &str) -> Result<()> {
    let job: Option<(i64, String)> = sqlite
        .query_row(
            r#"select "job_id", "status" from "publish_jobs" where ("publish_jobs"."publication_key" = ? and "publish_jobs"."target" = ?) order by "publish_jobs"."job_id" desc limit ?"#,
            params![target.publication_key, target.target, 1],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((job_id, status)) = job else {
        return Ok(());
    };
    if status != "published" {
        return Ok(());
    }
    sqlite.execute(
        r#"update "publish_jobs" set "status" = ?, "current_phase" = null, "locked_by" = null, "locked_at" = null, "next_attempt_at" = null, "last_error" = null, "updated_at" = ? where ("publish_jobs"."job_id" = ? and "publish_jobs"."status" = ?)"#,
        params!["cancelled", now, job_id, "published"],
    )?;
    Ok(())
}
