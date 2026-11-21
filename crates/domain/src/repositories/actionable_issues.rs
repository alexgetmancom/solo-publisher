use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, Row, params_from_iter};

use super::{SITE_TARGETS, in_list, integers};
use crate::Result;
use crate::application::ports::{ActionableIssue, IssueKind, IssueStatus};
use crate::application::publication_ref::{PublicationRefKind, publication_ref};

/// Statuses a target ends up in when nobody else will move it: either the
/// publication failed, or it reached the audience and we cannot prove it.
const ACTIONABLE_TARGET_STATUSES: [&str; 2] = ["failed", "verification_required"];

/// A video still being written is not a publication yet; a failed target
/// under it is the author's draft, not the operator's queue.
const INERT_VIDEO_DRAFT_STATUSES: [&str; 3] = ["draft", "editing", "cancelled"];

/// The single answer to "what needs a human right now".
///
/// Studio filters it by actor and Operations shows all of it, but neither owns
/// the definition: three copies of it disagreed, and the one behind the
/// Command Center's red dot was the narrowest, so a publication could sit
/// unverified with nobody watching.
pub struct ActionableIssueStore<'a> {
    sqlite: &'a Connection,
}

fn texts<const N: usize>(values: [&str; N]) -> impl Iterator<Item = SqlValue> {
    values.into_iter().map(|value| SqlValue::Text(value.into()))
}

fn status(value: &str) -> IssueStatus {
    if value == "verification_required" {
        IssueStatus::VerificationRequired
    } else {
        IssueStatus::Failed
    }
}

impl<'a> ActionableIssueStore<'a> {
    pub fn new(sqlite: &'a Connection) -> Self {
        Self { sqlite }
    }

    fn rows<T>(
        &self,
        sql: &str,
        values: Vec<SqlValue>,
        map: impl FnMut(&Row<'_>) -> db::rusqlite::Result<T>,
    ) -> Result<Vec<T>> {
        Ok(self
            .sqlite
            .prepare(sql)?
            .query_map(params_from_iter(values), map)?
            .collect::<db::rusqlite::Result<Vec<_>>>()?)
    }

    /// Every open issue, newest first; scoped to those actors when any are
    /// given.
    pub fn list(&self, actor_ids: Option<&[i64]>) -> Result<Vec<ActionableIssue>> {
        let by_actor = actor_ids.filter(|ids| !ids.is_empty()).unwrap_or_default();
        let scope = |column: &str| {
            if by_actor.is_empty() {
                String::new()
            } else {
                format!(" and {}", in_list(column, by_actor.len()))
            }
        };
        let actors = || integers(by_actor);
        let post_key = |post_id: i64| publication_ref(PublicationRefKind::Post, post_id);

        let posts = self.rows(
            &format!(
                r#"select "drafts"."id", "drafts"."actor_id", "drafts"."post_id", "publication_targets"."target", "publication_targets"."status", "publication_targets"."updated_at" from "publication_targets" inner join "drafts" on "publication_targets"."publication_key" = 'post:' || "drafts"."post_id" where ("drafts"."post_id" is not null and "publication_targets"."target" not in (?, ?) and "publication_targets"."status" in (?, ?){})"#,
                scope(r#""drafts"."actor_id""#)
            ),
            texts(SITE_TARGETS).chain(texts(ACTIONABLE_TARGET_STATUSES)).chain(actors()).collect(),
            |row| {
                Ok(ActionableIssue {
                    kind: IssueKind::Post,
                    publication_key: Some(post_key(row.get(2)?)),
                    draft_id: row.get(0)?,
                    actor_id: row.get(1)?,
                    target: row.get(3)?,
                    status: status(&row.get::<_, String>(4)?),
                    updated_at: row.get(5)?,
                })
            },
        )?;

        let site = self.rows(
            &format!(
                r#"select "drafts"."id", "drafts"."actor_id", "drafts"."post_id", "site_jobs"."reason", "site_jobs"."updated_at" from "site_jobs" inner join "drafts" on "site_jobs"."publication_key" = 'post:' || "drafts"."post_id" where ("drafts"."post_id" is not null and "site_jobs"."status" = ?{})"#,
                scope(r#""drafts"."actor_id""#)
            ),
            texts(["failed"]).chain(actors()).collect(),
            |row| {
                Ok(ActionableIssue {
                    kind: IssueKind::Site,
                    publication_key: Some(post_key(row.get(2)?)),
                    draft_id: row.get(0)?,
                    actor_id: row.get(1)?,
                    target: row.get(3)?,
                    status: IssueStatus::Failed,
                    updated_at: row.get(4)?,
                })
            },
        )?;

        let story_condition = if by_actor.is_empty() {
            r#""draft_story_cards"."status" = ?"#.to_string()
        } else {
            format!(
                r#"("draft_story_cards"."status" = ?{})"#,
                scope(r#""drafts"."actor_id""#)
            )
        };
        let story = self.rows(
            &format!(
                r#"select "draft_story_cards"."draft_id", "drafts"."actor_id", "drafts"."post_id", "draft_story_cards"."locale", "draft_story_cards"."updated_at" from "draft_story_cards" inner join "drafts" on "draft_story_cards"."draft_id" = "drafts"."id" where {story_condition}"#
            ),
            texts(["failed"]).chain(actors()).collect(),
            |row| {
                Ok(ActionableIssue {
                    kind: IssueKind::Story,
                    publication_key: row.get::<_, Option<i64>>(2)?.map(post_key),
                    draft_id: row.get(0)?,
                    actor_id: row.get(1)?,
                    target: row.get(3)?,
                    status: IssueStatus::Failed,
                    updated_at: row.get(4)?,
                })
            },
        )?;

        let video = self.rows(
            &format!(
                r#"select "video_drafts"."id", "video_drafts"."actor_id", "video_targets"."target", "video_targets"."status", "video_targets"."updated_at" from "video_targets" inner join "video_drafts" on "video_targets"."video_draft_id" = "video_drafts"."id" where ("video_targets"."status" in (?, ?) and "video_drafts"."status" not in (?, ?, ?){})"#,
                scope(r#""video_drafts"."actor_id""#)
            ),
            texts(ACTIONABLE_TARGET_STATUSES)
                .chain(texts(INERT_VIDEO_DRAFT_STATUSES))
                .chain(actors())
                .collect(),
            |row| {
                let draft_id: i64 = row.get(0)?;
                Ok(ActionableIssue {
                    kind: IssueKind::Video,
                    publication_key: Some(publication_ref(PublicationRefKind::Video, draft_id)),
                    draft_id,
                    actor_id: row.get(1)?,
                    target: row.get(2)?,
                    status: status(&row.get::<_, String>(3)?),
                    updated_at: row.get(4)?,
                })
            },
        )?;

        let mut issues: Vec<ActionableIssue> = posts.into_iter().chain(site).chain(story).chain(video).collect();
        // `localeCompare` on ISO instants of one shape orders as their bytes;
        // the sort is stable, so ties keep the kinds in this order.
        issues.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(issues)
    }
}
