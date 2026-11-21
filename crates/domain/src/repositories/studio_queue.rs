use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, params_from_iter};

use super::{in_list, integers};
use crate::Result;
use crate::application::conversation_flow::PublicationKind;
use crate::application::ports::{StudioQueuePost, StudioQueuePublished, StudioQueueVideo, StudioQueueVideoTarget};

/// The transport-neutral Studio queue projection.
pub struct StudioQueueStore<'a> {
    sqlite: &'a Connection,
}

impl<'a> StudioQueueStore<'a> {
    pub fn new(sqlite: &'a Connection) -> Self {
        Self { sqlite }
    }

    /// The cap applies after recency ordering, so archive history cannot hide
    /// new work.
    pub fn posts(&self, actor_ids: &[i64], limit: i64) -> Result<Vec<StudioQueuePost>> {
        let sql = format!(
            r#"select "drafts"."id", "drafts"."actor_id", "drafts"."status", "post_locales"."source_text", "drafts"."targets_json", "drafts"."updated_at", "drafts"."scheduled_at", "drafts"."scheduled_en_at", "drafts"."post_id" from "drafts" inner join "post_locales" on ("post_locales"."draft_id" = "drafts"."id" and "post_locales"."locale" = ?) where {} order by "drafts"."updated_at" desc, "drafts"."id" desc limit ?"#,
            in_list(r#""drafts"."actor_id""#, actor_ids.len())
        );
        let values = [SqlValue::Text("ru".into())]
            .into_iter()
            .chain(integers(actor_ids))
            .chain([SqlValue::Integer(limit)]);
        Ok(self
            .sqlite
            .prepare(&sql)?
            .query_map(params_from_iter(values), |row| {
                Ok(StudioQueuePost {
                    id: row.get(0)?,
                    actor_id: row.get(1)?,
                    status: row.get(2)?,
                    text_ru: row.get(3)?,
                    targets_json: row.get(4)?,
                    updated_at: row.get(5)?,
                    scheduled_at: row.get(6)?,
                    scheduled_en_at: row.get(7)?,
                    post_id: row.get(8)?,
                })
            })?
            .collect::<db::rusqlite::Result<Vec<_>>>()?)
    }

    /// The cap applies after recency ordering, so archive history cannot hide
    /// new work.
    pub fn videos(&self, actor_ids: &[i64], limit: i64) -> Result<Vec<StudioQueueVideo>> {
        let sql = format!(
            r#"select "id", "actor_id", "status", "label", "updated_at" from "video_drafts" where {} order by "video_drafts"."updated_at" desc, "video_drafts"."id" desc limit ?"#,
            in_list(r#""video_drafts"."actor_id""#, actor_ids.len())
        );
        let values = integers(actor_ids).chain([SqlValue::Integer(limit)]);
        Ok(self
            .sqlite
            .prepare(&sql)?
            .query_map(params_from_iter(values), |row| {
                Ok(StudioQueueVideo {
                    id: row.get(0)?,
                    actor_id: row.get(1)?,
                    status: row.get(2)?,
                    label: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?
            .collect::<db::rusqlite::Result<Vec<_>>>()?)
    }

    /// The most recently published post or video; a post wins a tie.
    pub fn latest_published(&self, actor_ids: &[i64]) -> Result<Option<StudioQueuePublished>> {
        let actors = |column: &str| in_list(column, actor_ids.len());
        let post_sql = format!(
            r#"select "drafts"."id", "post_locales"."source_text", "publication_targets"."published_at" from "drafts" inner join "post_locales" on ("post_locales"."draft_id" = "drafts"."id" and "post_locales"."locale" = ?) inner join "publication_targets" on "publication_targets"."publication_key" = 'post:' || "drafts"."post_id" where ({} and "publication_targets"."status" = ? and "publication_targets"."published_at" is not null) order by "publication_targets"."published_at" desc limit ?"#,
            actors(r#""drafts"."actor_id""#)
        );
        let post_values = [SqlValue::Text("ru".into())]
            .into_iter()
            .chain(integers(actor_ids))
            .chain([SqlValue::Text("published".into()), SqlValue::Integer(1)]);
        let row = |row: &db::rusqlite::Row<'_>| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        };
        let post = self
            .sqlite
            .query_row(&post_sql, params_from_iter(post_values), row)
            .optional()?;
        let video_sql = format!(
            r#"select "video_drafts"."id", "video_drafts"."label", "video_targets"."published_at" from "video_drafts" inner join "video_targets" on "video_targets"."video_draft_id" = "video_drafts"."id" where ({} and "video_targets"."status" = ? and "video_targets"."published_at" is not null) order by "video_targets"."published_at" desc limit ?"#,
            actors(r#""video_drafts"."actor_id""#)
        );
        let video_values = integers(actor_ids).chain([SqlValue::Text("published".into()), SqlValue::Integer(1)]);
        let video = self
            .sqlite
            .query_row(&video_sql, params_from_iter(video_values), row)
            .optional()?;
        // JavaScript truthiness: an empty `published_at` counts as none.
        let published = |found: Option<(i64, String, Option<String>)>| {
            found.and_then(|(id, label, at)| at.filter(|at| !at.is_empty()).map(|at| (id, label, at)))
        };
        Ok(match (published(post), published(video)) {
            (Some((id, label, at)), video) if video.as_ref().is_none_or(|video| at >= video.2) => {
                Some(StudioQueuePublished {
                    id,
                    label,
                    kind: PublicationKind::Post,
                    published_at: at,
                })
            }
            (_, Some((id, label, at))) => Some(StudioQueuePublished {
                id,
                label,
                kind: PublicationKind::Video,
                published_at: at,
            }),
            _ => None,
        })
    }

    pub fn video_targets(&self, publication_ids: &[i64]) -> Result<Vec<StudioQueueVideoTarget>> {
        if publication_ids.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            r#"select "video_draft_id", "status", "scheduled_at" from "video_targets" where {}"#,
            in_list(r#""video_targets"."video_draft_id""#, publication_ids.len())
        );
        Ok(self
            .sqlite
            .prepare(&sql)?
            .query_map(params_from_iter(integers(publication_ids)), |row| {
                Ok(StudioQueueVideoTarget {
                    publication_id: row.get(0)?,
                    status: row.get(1)?,
                    scheduled_at: row.get(2)?,
                })
            })?
            .collect::<db::rusqlite::Result<Vec<_>>>()?)
    }
}
