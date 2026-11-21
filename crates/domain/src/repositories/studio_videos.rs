use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, Row, params_from_iter};

use super::studio_posts::{SELECT_EVENTS, event};
use super::{in_list, integers, json_column};
use crate::Result;
use crate::application::ports::{
    PostEventRecord, StudioVideoDraftRecord, StudioVideoJobRecord, StudioVideoTargetRecord,
};
use crate::application::publication_ref::parse_publication_ref;

const SELECT_VIDEO_DRAFTS: &str = r#"select "id", "actor_id", "locale", "label", "studio_media_asset_id", "status", "scheduled_at", "retention_until", "source_pruned_at", "control_chat_id", "control_message_id", "game", "hook", "script", "script_source", "opening_line", "created_at", "updated_at" from "video_drafts""#;

fn video_draft(row: &Row<'_>) -> db::rusqlite::Result<StudioVideoDraftRecord> {
    Ok(StudioVideoDraftRecord {
        id: row.get(0)?,
        actor_id: row.get(1)?,
        locale: row.get(2)?,
        label: row.get(3)?,
        studio_media_asset_id: row.get(4)?,
        status: row.get(5)?,
        scheduled_at: row.get(6)?,
        retention_until: row.get(7)?,
        source_pruned_at: row.get(8)?,
        control_chat_id: row.get(9)?,
        control_message_id: row.get(10)?,
        game: row.get(11)?,
        hook: row.get(12)?,
        script: row.get(13)?,
        script_source: row.get(14)?,
        opening_line: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

/// Read side of video publications for Studio interfaces and previews.
pub struct StudioVideoStore<'a> {
    sqlite: &'a Connection,
}

impl<'a> StudioVideoStore<'a> {
    pub fn new(sqlite: &'a Connection) -> Self {
        Self { sqlite }
    }

    pub fn get(&self, publication_id: i64) -> Result<Option<StudioVideoDraftRecord>> {
        Ok(self
            .sqlite
            .query_row(
                &format!(r#"{SELECT_VIDEO_DRAFTS} where "video_drafts"."id" = ?"#),
                [publication_id],
                video_draft,
            )
            .optional()?)
    }

    pub fn list(&self, actor_ids: &[i64], limit: i64) -> Result<Vec<StudioVideoDraftRecord>> {
        let sql = format!(
            r#"{SELECT_VIDEO_DRAFTS} where {} order by "video_drafts"."updated_at" desc limit ?"#,
            in_list(r#""video_drafts"."actor_id""#, actor_ids.len())
        );
        Ok(self
            .sqlite
            .prepare(&sql)?
            .query_map(
                params_from_iter(integers(actor_ids).chain([SqlValue::Integer(limit)])),
                video_draft,
            )?
            .collect::<db::rusqlite::Result<Vec<_>>>()?)
    }

    pub fn targets(&self, publication_id: i64) -> Result<Vec<StudioVideoTargetRecord>> {
        let rows = self
            .sqlite
            .prepare(
                r#"select "id", "video_draft_id", "target", "metadata_json", "scheduled_at", "status", "delivery_provider", "provider_account_id", "provider_post_id", "external_id", "external_url", "prepared_at", "published_at", "confirmation_source", "verified_at", "last_error", "created_at", "updated_at" from "video_targets" where "video_targets"."video_draft_id" = ? order by "video_targets"."id" asc"#,
            )?
            .query_map([publication_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(3)?,
                    StudioVideoTargetRecord {
                        id: row.get(0)?,
                        publication_id: row.get(1)?,
                        target: row.get(2)?,
                        metadata_json: Default::default(),
                        scheduled_at: row.get(4)?,
                        status: row.get(5)?,
                        delivery_provider: row.get(6)?,
                        provider_account_id: row.get(7)?,
                        provider_post_id: row.get(8)?,
                        external_id: row.get(9)?,
                        external_url: row.get(10)?,
                        prepared_at: row.get(11)?,
                        published_at: row.get(12)?,
                        confirmation_source: row.get(13)?,
                        verified_at: row.get(14)?,
                        last_error: row.get(15)?,
                        created_at: row.get(16)?,
                        updated_at: row.get(17)?,
                    },
                ))
            })?
            .collect::<db::rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(metadata, mut target)| {
                target.metadata_json = json_column(metadata)?.unwrap_or_default();
                Ok(target)
            })
            .collect()
    }

    /// Newest first.
    pub fn jobs(&self, publication_id: i64) -> Result<Vec<StudioVideoJobRecord>> {
        Ok(self
            .sqlite
            .prepare(
                r#"select "id", "video_draft_id", "video_target_id", "kind", "run_at", "status", "reconcile_attempt_count", "attempt_count", "next_attempt_at", "locked_by", "locked_at", "last_error", "created_at", "updated_at" from "video_jobs" where "video_jobs"."video_draft_id" = ? order by "video_jobs"."id" desc"#,
            )?
            .query_map([publication_id], |row| {
                Ok(StudioVideoJobRecord {
                    id: row.get(0)?,
                    publication_id: row.get(1)?,
                    video_target_id: row.get(2)?,
                    kind: row.get(3)?,
                    run_at: row.get(4)?,
                    status: row.get(5)?,
                    reconcile_attempt_count: row.get(6)?,
                    attempt_count: row.get(7)?,
                    next_attempt_at: row.get(8)?,
                    last_error: row.get(9)?,
                    locked_by: row.get(10)?,
                    locked_at: row.get(11)?,
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            })?
            .collect::<db::rusqlite::Result<Vec<_>>>()?)
    }

    /// The journal of a publication under the key as given and its canonical
    /// form (`video:01` also reads `video:1`), newest first.
    pub fn history(&self, publication_key: &str, limit: i64) -> Result<Vec<PostEventRecord>> {
        let mut refs = vec![publication_key.to_string()];
        if let Some(parsed) = parse_publication_ref(Some(publication_key)) {
            refs.push(parsed.to_string());
        }
        let sql = format!(
            r#"{SELECT_EVENTS} where {} order by "publication_events"."created_at" desc, "publication_events"."id" desc limit ?"#,
            in_list(r#""publication_events"."publication_key""#, refs.len())
        );
        let values = refs.into_iter().map(SqlValue::Text).chain([SqlValue::Integer(limit)]);
        Ok(self
            .sqlite
            .prepare(&sql)?
            .query_map(params_from_iter(values), event)?
            .collect::<db::rusqlite::Result<Vec<_>>>()?)
    }
}
