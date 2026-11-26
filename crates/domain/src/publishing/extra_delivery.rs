//! Sends a settled publication to one more platform, with the retry button's
//! safety: `Resume` refuses a target that already put something in front of
//! the audience, so tapping twice cannot post twice.

use serde_json::json;

use super::Publishing;
use super::publication_source::PublicationSource;
use super::queue_state::{JournalEntry, insert_event};
use super::requeue::{AudienceReached, RequeueOptions, RequeueOutcome, RequeueResult, RequeueScope};
use super::state::AUDIENCE_MUTATION_RETRYABLE_STATUSES;
use crate::repositories::transaction;
use crate::targets::TargetMap;
use crate::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtraDeliveryScope {
    pub draft_id: i64,
    pub post_id: i64,
    pub publication_key: String,
}

impl Publishing<'_> {
    /// The draft's target list and the job are written together: a target
    /// delivered but absent from `targets_json` is invisible to progress, the
    /// card and the completion notice.
    pub fn deliver_extra_target(
        &self,
        scope: &ExtraDeliveryScope,
        target: &str,
        source: &dyn Fn() -> Result<PublicationSource>,
    ) -> Result<RequeueResult> {
        let sqlite = self.sqlite;
        transaction(sqlite, || {
            let now = self.now();
            let result = self
                .requeue_publication_targets_tx(
                    &RequeueScope {
                        post_id: Some(scope.post_id),
                        publication_key: scope.publication_key.clone(),
                    },
                    &[target],
                    &RequeueOptions {
                        from: &AUDIENCE_MUTATION_RETRYABLE_STATUSES,
                        create_missing: true,
                        audience_reached: AudienceReached::Resume,
                        source,
                    },
                )?
                .into_iter()
                .next()
                .ok_or_else(|| Error::message(format!("requeue returned no result for {target}")))?;
            if result.outcome != RequeueOutcome::Requeued {
                return Ok(result);
            }
            let targets_json: Option<String> = db::rusqlite::OptionalExtension::optional(sqlite.query_row(
                r#"select "targets_json" from "drafts" where "drafts"."id" = ?"#,
                [scope.draft_id],
                |row| row.get(0),
            ))?;
            let mut targets = TargetMap::parse(Some(targets_json.as_deref().unwrap_or("{}")));
            targets.set(target, true);
            sqlite.execute(
                r#"update "drafts" set "targets_json" = ?, "updated_at" = ? where "drafts"."id" = ?"#,
                db::rusqlite::params![targets.to_json(), now, scope.draft_id],
            )?;
            insert_event(
                sqlite,
                Some(&scope.publication_key),
                Some(target),
                JournalEntry {
                    event_type: "delivery.post.target.added",
                    severity: "info",
                    message: &format!("Post #{} was sent to {target} after publication", scope.post_id),
                    details: json!({ "draft_id": scope.draft_id, "post_id": scope.post_id, "target": target }),
                },
                &now,
            )?;
            Ok(result)
        })
    }
}
