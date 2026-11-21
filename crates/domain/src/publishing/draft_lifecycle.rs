//! A draft's publication as a whole: the scheduled list, and cancelling it.

use db::rusqlite::{OptionalExtension, params};
use serde::Serialize;

use super::Publishing;
use super::cancellation::declare_cancellation;
use crate::Result;
use crate::application::ports::{DomainEventInput, Severity};
use crate::application::publication_ref::{PublicationRefKind, publication_ref};
use crate::repositories::{record_event, transaction};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledDraft {
    pub id: i64,
    pub scheduled_at: Option<String>,
    pub scheduled_en_at: Option<String>,
}

impl Publishing<'_> {
    pub fn scheduled_drafts(&self) -> Result<Vec<ScheduledDraft>> {
        Ok(self
            .sqlite
            .prepare(
                r#"select "id", "scheduled_at", "scheduled_en_at" from "drafts" where "drafts"."status" = ? order by coalesce("drafts"."scheduled_at", "drafts"."scheduled_en_at") asc, "drafts"."id" asc"#,
            )?
            .query_map(["scheduled"], |row| {
                Ok(ScheduledDraft {
                    id: row.get(0)?,
                    scheduled_at: row.get(1)?,
                    scheduled_en_at: row.get(2)?,
                })
            })?
            .collect::<db::rusqlite::Result<_>>()?)
    }

    /// Cancels a draft's publication. When nothing of it is out yet, the
    /// publication is dissolved; when something is, the jobs stay as the
    /// record of it and the cancellation is declared, so a worker holding one
    /// of them cannot start another delivery under it.
    pub fn cancel_draft(&self, draft_id: i64, actor_id: i64) -> Result<()> {
        let now = self.now();
        let sqlite = self.sqlite;
        transaction(sqlite, || {
            let post_id: Option<i64> = sqlite
                .query_row(
                    r#"select "post_id" from "drafts" where "drafts"."id" = ?"#,
                    [draft_id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            sqlite.execute(
                r#"update "drafts" set "status" = ?, "scheduled_at" = null, "scheduled_en_at" = null, "updated_at" = ? where "drafts"."id" = ?"#,
                params!["cancelled", now, draft_id],
            )?;
            let Some(post_id) = post_id.filter(|id| *id != 0) else {
                return Ok(());
            };
            let key = publication_ref(PublicationRefKind::Post, post_id);
            let final_social: i64 = sqlite.query_row(
                r#"select count(*) from "publish_jobs" where ("publish_jobs"."publication_key" = ? and "publish_jobs"."status" in (?, ?, ?, ?))"#,
                params![key, "publishing", "published", "skipped", "verification_required"],
                |row| row.get(0),
            )?;
            let final_site: i64 = sqlite.query_row(
                r#"select count(*) from "site_jobs" where ("site_jobs"."publication_key" = ? and "site_jobs"."status" in (?, ?))"#,
                params![key, "rendering", "published"],
                |row| row.get(0),
            )?;
            if final_social + final_site > 0 {
                declare_cancellation(sqlite, &key, actor_id, &now)?;
                for table in ["publish_jobs", "site_jobs"] {
                    sqlite.execute(
                        &format!(
                            r#"update "{table}" set "status" = ?, "updated_at" = ? where ("{table}"."publication_key" = ? and "{table}"."status" in (?, ?))"#
                        ),
                        params!["cancelled", now, key, "queued", "failed"],
                    )?;
                }
                return Ok(());
            }
            sqlite.execute(
                r#"delete from "publish_jobs" where "publish_jobs"."publication_key" = ?"#,
                [&key],
            )?;
            sqlite.execute(
                r#"delete from "site_jobs" where "site_jobs"."publication_key" = ?"#,
                [&key],
            )?;
            sqlite.execute(
                r#"update "post_locales" set "slug" = null, "html" = null, "story_media_json" = null, "site_media_json" = null, "site_enabled" = ?, "publish_at" = null, "published_at" = null, "updated_at" = ? where "post_locales"."draft_id" = ?"#,
                params![0, now, draft_id],
            )?;
            sqlite.execute(
                r#"update "drafts" set "post_id" = null, "publish_mode" = null, "scheduled_at" = null, "scheduled_en_at" = null, "updated_at" = ? where "drafts"."id" = ?"#,
                params![now, draft_id],
            )?;
            Ok(())
        })?;
        self.boundaries.story_cards.discard(sqlite, draft_id)?;
        record_event(
            sqlite,
            self.clock,
            &DomainEventInput {
                publication_ref: Some(publication_ref(PublicationRefKind::Draft, draft_id)),
                event_type: "publishing.draft.cancelled".into(),
                severity: Severity::Info,
                target: None,
                message: format!("Publication for draft #{draft_id} cancelled"),
                details: None,
                cooldown_seconds: None,
            },
        )?;
        Ok(())
    }
}
