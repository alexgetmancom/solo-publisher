use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};

use super::SITE_TARGETS;
use crate::Result;
use crate::application::ports::{
    DraftEntityCandidate, FailedPublicationTarget, IssueStatus, PostEventRecord, ProgressDraft, ProgressPublishJob,
    ProgressSiteJob, StudioPostProgress,
};
use crate::application::publication_ref::{PublicationRefKind, publication_ref};

pub(crate) const SELECT_EVENTS: &str = r#"select "id", "publication_key", "event_type", "severity", "target", "message", "details_json", "created_at", "acked_at" from "publication_events""#;

pub(crate) fn event(row: &Row<'_>) -> db::rusqlite::Result<PostEventRecord> {
    Ok(PostEventRecord {
        id: row.get(0)?,
        publication_key: row.get(1)?,
        event_type: row.get(2)?,
        severity: row.get(3)?,
        target: row.get(4)?,
        message: row.get(5)?,
        details_json: row.get(6)?,
        created_at: row.get(7)?,
        acked_at: row.get(8)?,
    })
}

/// Post-specific persistence behind Studio's post commands and queries.
pub struct StudioPostStore<'a> {
    sqlite: &'a Connection,
}

impl<'a> StudioPostStore<'a> {
    pub fn new(sqlite: &'a Connection) -> Self {
        Self { sqlite }
    }

    /// The model's suggestions for a draft, replacing the previous ones. Two
    /// statements and no transaction, as in TypeScript; the insert is one
    /// statement, so a refused row leaves none of the new ones.
    pub fn replace_entity_candidates(
        &self,
        draft_id: i64,
        candidates: &[DraftEntityCandidate],
        now: &str,
    ) -> Result<()> {
        self.sqlite.execute(
            r#"delete from "draft_entity_candidates" where "draft_entity_candidates"."draft_id" = ?"#,
            [draft_id],
        )?;
        if candidates.is_empty() {
            return Ok(());
        }
        let rows = vec!["(null, ?, ?, ?, ?, ?, ?, ?, ?)"; candidates.len()].join(", ");
        let values = candidates.iter().flat_map(|candidate| {
            [
                SqlValue::Integer(draft_id),
                SqlValue::Text(candidate.kind.clone()),
                SqlValue::Text(candidate.slug.clone()),
                SqlValue::Text(candidate.title_ru.clone()),
                candidate.title_en.clone().map_or(SqlValue::Null, SqlValue::Text),
                SqlValue::Text("suggested".into()),
                SqlValue::Text(now.into()),
                SqlValue::Text(now.into()),
            ]
        });
        self.sqlite.execute(
            &format!(
                r#"insert into "draft_entity_candidates" ("id", "draft_id", "kind", "slug", "title_ru", "title_en", "status", "created_at", "updated_at") values {rows}"#
            ),
            params_from_iter(values),
        )?;
        Ok(())
    }

    pub fn accept_entity_candidates(&self, draft_id: i64, now: &str) -> Result<()> {
        self.sqlite.execute(
            r#"update "draft_entity_candidates" set "status" = ?, "updated_at" = ? where "draft_entity_candidates"."draft_id" = ?"#,
            params!["accepted", now, draft_id],
        )?;
        Ok(())
    }

    /// The draft's journal, and its post's once it has one: newest first.
    pub fn history(&self, draft_id: i64, post_id: Option<i64>, limit: i64) -> Result<Vec<PostEventRecord>> {
        let draft_key = publication_ref(PublicationRefKind::Draft, draft_id);
        let rows = match post_id {
            None => self
                .sqlite
                .prepare(&format!(
                    r#"{SELECT_EVENTS} where "publication_events"."publication_key" = ? order by "publication_events"."created_at" desc, "publication_events"."id" desc limit ?"#
                ))?
                .query_map(params![draft_key, limit], event)?
                .collect::<db::rusqlite::Result<Vec<_>>>()?,
            Some(post_id) => self
                .sqlite
                .prepare(&format!(
                    r#"{SELECT_EVENTS} where ("publication_events"."publication_key" = ? or "publication_events"."publication_key" = ?) order by "publication_events"."created_at" desc, "publication_events"."id" desc limit ?"#
                ))?
                .query_map(
                    params![draft_key, publication_ref(PublicationRefKind::Post, post_id), limit],
                    event,
                )?
                .collect::<db::rusqlite::Result<Vec<_>>>()?,
        };
        Ok(rows)
    }

    pub fn progress(&self, draft_id: i64) -> Result<Option<StudioPostProgress>> {
        let draft = self
            .sqlite
            .query_row(
                r#"select "id", "actor_id", "post_id", "targets_json" from "drafts" where "drafts"."id" = ?"#,
                [draft_id],
                |row| {
                    Ok(ProgressDraft {
                        id: row.get(0)?,
                        actor_id: row.get(1)?,
                        post_id: row.get(2)?,
                        targets_json: row.get(3)?,
                    })
                },
            )
            .optional()?;
        let Some(draft) = draft else { return Ok(None) };
        let (publish_jobs, site_jobs) = match draft.post_id {
            None => (Vec::new(), Vec::new()),
            Some(post_id) => {
                let key = publication_ref(PublicationRefKind::Post, post_id);
                let publish_jobs = self
                    .sqlite
                    .prepare(
                        r#"select "target", "status", "last_error" from "publish_jobs" where "publish_jobs"."publication_key" = ?"#,
                    )?
                    .query_map([&key], |row| {
                        Ok(ProgressPublishJob {
                            target: row.get(0)?,
                            status: row.get(1)?,
                            last_error: row.get(2)?,
                        })
                    })?
                    .collect::<db::rusqlite::Result<Vec<_>>>()?;
                let site_jobs = self
                    .sqlite
                    .prepare(
                        r#"select "reason", "status", "last_error" from "site_jobs" where "site_jobs"."publication_key" = ?"#,
                    )?
                    .query_map([&key], |row| {
                        Ok(ProgressSiteJob {
                            reason: row.get(0)?,
                            status: row.get(1)?,
                            last_error: row.get(2)?,
                        })
                    })?
                    .collect::<db::rusqlite::Result<Vec<_>>>()?;
                (publish_jobs, site_jobs)
            }
        };
        Ok(Some(StudioPostProgress {
            draft,
            publish_jobs,
            site_jobs,
        }))
    }

    /// The latest job of each social target, then of each site target, that
    /// failed or awaits verification.
    pub fn failed_publication_targets(&self, post_id: i64) -> Result<Vec<FailedPublicationTarget>> {
        let key = publication_ref(PublicationRefKind::Post, post_id);
        let latest = |sql: &str, site_only: bool| -> Result<Vec<(String, String, Option<String>)>> {
            let rows = self
                .sqlite
                .prepare(sql)?
                .query_map([&key], |row| Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<db::rusqlite::Result<Vec<_>>>()?;
            let mut latest: Vec<(String, String, Option<String>)> = Vec::new();
            for row in rows {
                let wanted = !site_only || SITE_TARGETS.contains(&row.0.as_str());
                if wanted && !latest.iter().any(|seen| seen.0 == row.0) {
                    latest.push(row);
                }
            }
            Ok(latest)
        };
        let social = latest(
            r#"select "target", "status", "last_error", "job_id" from "publish_jobs" where "publish_jobs"."publication_key" = ? order by "publish_jobs"."job_id" desc"#,
            false,
        )?;
        let site = latest(
            r#"select "reason", "status", "last_error", "job_id" from "site_jobs" where "site_jobs"."publication_key" = ? order by "site_jobs"."job_id" desc"#,
            true,
        )?;
        Ok(social
            .into_iter()
            .chain(site)
            .filter_map(|(target, status, error)| {
                let status = match status.as_str() {
                    "failed" => IssueStatus::Failed,
                    "verification_required" => IssueStatus::VerificationRequired,
                    _ => return None,
                };
                Some(FailedPublicationTarget { target, status, error })
            })
            .collect())
    }
}
