//! Video drafts, their targets and jobs, as the video services read and
//! write them.

use db::rusqlite::{Connection, OptionalExtension, Row, params};
use foundation::errors::StudioError;
use serde_json::{Map, Value};

use super::state::{is_video_target_final, video_draft_status};
use super::{Publishing, iso_at};
use crate::repositories::immediate_transaction;
use crate::{Error, Result};

#[derive(Clone, Debug, PartialEq)]
pub struct VideoDraftRow {
    pub id: i64,
    pub actor_id: i64,
    pub locale: String,
    pub label: String,
    pub studio_media_asset_id: Option<i64>,
    pub status: String,
    pub scheduled_at: Option<String>,
    pub retention_until: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VideoTargetRow {
    pub id: i64,
    pub video_draft_id: i64,
    pub target: String,
    pub metadata: Map<String, Value>,
    pub scheduled_at: Option<String>,
    pub status: String,
    pub delivery_provider: String,
    pub provider_account_id: Option<String>,
    pub provider_post_id: Option<String>,
    pub external_id: Option<String>,
    pub external_url: Option<String>,
    pub published_at: Option<String>,
}

pub(crate) const SELECT_VIDEO_DRAFT: &str = r#"select "id", "actor_id", "locale", "label", "studio_media_asset_id", "status", "scheduled_at", "retention_until" from "video_drafts""#;
pub(crate) const SELECT_VIDEO_TARGET: &str = r#"select "id", "video_draft_id", "target", "metadata_json", "scheduled_at", "status", "delivery_provider", "provider_account_id", "provider_post_id", "external_id", "external_url", "published_at" from "video_targets""#;

pub(crate) fn video_draft_row(row: &Row<'_>) -> db::rusqlite::Result<VideoDraftRow> {
    Ok(VideoDraftRow {
        id: row.get(0)?,
        actor_id: row.get(1)?,
        locale: row.get(2)?,
        label: row.get(3)?,
        studio_media_asset_id: row.get(4)?,
        status: row.get(5)?,
        scheduled_at: row.get(6)?,
        retention_until: row.get(7)?,
    })
}

pub(crate) fn video_target_row(row: &Row<'_>) -> db::rusqlite::Result<VideoTargetRow> {
    let metadata: String = row.get(3)?;
    Ok(VideoTargetRow {
        id: row.get(0)?,
        video_draft_id: row.get(1)?,
        target: row.get(2)?,
        // A JSON column Drizzle parses on read; anything but an object is
        // metadata with no fields.
        metadata: match serde_json::from_str(&metadata) {
            Ok(Value::Object(object)) => object,
            _ => Map::new(),
        },
        scheduled_at: row.get(4)?,
        status: row.get(5)?,
        delivery_provider: row.get(6)?,
        provider_account_id: row.get(7)?,
        provider_post_id: row.get(8)?,
        external_id: row.get(9)?,
        external_url: row.get(10)?,
        published_at: row.get(11)?,
    })
}

pub(crate) fn video_target(sqlite: &Connection, video_draft_id: i64, target: &str) -> Result<Option<VideoTargetRow>> {
    Ok(sqlite
        .query_row(
            &format!(
                r#"{SELECT_VIDEO_TARGET} where ("video_targets"."video_draft_id" = ? and "video_targets"."target" = ?)"#
            ),
            params![video_draft_id, target],
            video_target_row,
        )
        .optional()?)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoJobKind {
    Prepare,
    Publish,
}

impl VideoJobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepare => "prepare",
            Self::Publish => "publish",
        }
    }
}

impl Publishing<'_> {
    pub fn get_video_draft(&self, id: i64) -> Result<VideoDraftRow> {
        self.sqlite
            .query_row(
                &format!(r#"{SELECT_VIDEO_DRAFT} where "video_drafts"."id" = ?"#),
                [id],
                video_draft_row,
            )
            .optional()?
            .ok_or_else(|| Error::message("Video publication was not found."))
    }

    pub fn list_video_targets(&self, video_draft_id: i64) -> Result<Vec<VideoTargetRow>> {
        Ok(self
            .sqlite
            .prepare(&format!(
                r#"{SELECT_VIDEO_TARGET} where "video_targets"."video_draft_id" = ? order by "video_targets"."id" asc"#
            ))?
            .query_map([video_draft_id], video_target_row)?
            .collect::<db::rusqlite::Result<_>>()?)
    }

    /// Arms a job, or re-arms the existing one. A job a worker holds is never
    /// taken from it: the worker fences every completion on its lock, and
    /// stealing it would turn that completion into a no-op while the target
    /// was already marked published — and the requeued job would publish twice.
    pub fn insert_video_job(
        &self,
        video_draft_id: i64,
        video_target_id: Option<i64>,
        kind: VideoJobKind,
        run_at: &str,
    ) -> Result<()> {
        let sqlite = self.sqlite;
        let target_condition = if video_target_id.is_some() {
            r#""video_jobs"."video_target_id" = ?"#
        } else {
            r#""video_jobs"."video_target_id" is null"#
        };
        let mut values: Vec<db::rusqlite::types::Value> = vec![video_draft_id.into()];
        values.extend(video_target_id.map(Into::into));
        values.push(kind.as_str().to_owned().into());
        let exists: Option<i64> = sqlite
            .query_row(
                &format!(
                    r#"select "id" from "video_jobs" where ("video_jobs"."video_draft_id" = ? and {target_condition} and "video_jobs"."kind" = ?)"#
                ),
                db::rusqlite::params_from_iter(values),
                |row| row.get(0),
            )
            .optional()?;
        let now = self.now();
        match exists {
            Some(id) => {
                let requeued = sqlite
                    .query_row(
                        r#"update "video_jobs" set "run_at" = ?, "status" = ?, "attempt_count" = ?, "next_attempt_at" = null, "locked_at" = null, "locked_by" = null, "last_error" = null, "updated_at" = ? where ("video_jobs"."id" = ? and "video_jobs"."status" <> ?) returning "id""#,
                        params![run_at, "queued", 0, now, id, "running"],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                if requeued.is_none() {
                    return Err(StudioError::new("err.video-job-running").into());
                }
            }
            None => {
                sqlite.execute(
                    r#"insert into "video_jobs" ("video_draft_id", "video_target_id", "kind", "run_at", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?)"#,
                    params![video_draft_id, video_target_id, kind.as_str(), run_at, now, now],
                )?;
            }
        }
        Ok(())
    }

    /// Recomputes the draft's status from every target row. There is no
    /// snapshot of the draft to carry in a `WHERE`, so the fence is the
    /// immediate transaction: two targets finishing together cannot both read
    /// "all final" on a snapshot and write a status their read no longer
    /// supports — a retention deadline the sweep is entitled to act on.
    pub fn refresh_video_draft_status(&self, video_draft_id: i64, retention_hours: i64) -> Result<()> {
        let sqlite = self.sqlite;
        immediate_transaction(sqlite, || {
            let statuses: Vec<String> = sqlite
                .prepare(r#"select "status" from "video_targets" where "video_targets"."video_draft_id" = ?"#)?
                .query_map([video_draft_id], |row| row.get(0))?
                .collect::<db::rusqlite::Result<_>>()?;
            if statuses.is_empty() {
                return Ok(());
            }
            let all_final = statuses.iter().all(|status| is_video_target_final(status));
            let retention_until = all_final.then(|| iso_at(self.now_ms() + retention_hours * 60 * 60_000));
            sqlite.execute(
                r#"update "video_drafts" set "status" = ?, "retention_until" = ?, "updated_at" = ? where "video_drafts"."id" = ?"#,
                params![video_draft_status(&statuses), retention_until, self.now(), video_draft_id],
            )?;
            Ok(())
        })
    }
}
