//! Coordinates validated content, durable plan persistence and the initial
//! status of a publication.

use std::time::Instant;

use content::Locale;
use content::entity_enrichment::enrich_published_post_entities;
use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{OptionalExtension, params, params_from_iter};
use jiff::Timestamp;
use serde_json::json;

use super::Publishing;
use super::preflight::assert_publication_preflight;
use super::publication_plan::{PublicationSchedule, PublishMode, create_publication_plan};
use super::publication_status::object;
use crate::application::ports::{DomainEventInput, DraftRecord, Severity};
use crate::application::publication_ref::{PublicationRefKind, publication_ref};
use crate::channels::{channel_upload_limits, effective_post_targets, registered_post_target_ids};
use crate::repositories::{DraftStore, EntityEnrichmentStore, immediate_transaction, record_event};
use crate::targets::{TargetMap, is_story_target};
use crate::{Error, Result};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PublishDraftOptions {
    pub mode: Option<PublishMode>,
    pub ru_at: Option<Timestamp>,
    pub en_at: Option<Timestamp>,
    pub immediate_locale: Option<Locale>,
}

impl Publishing<'_> {
    /// `requireDraft`.
    pub(crate) fn require_draft(&self, draft_id: i64) -> Result<DraftRecord> {
        DraftStore::new(self.sqlite, self.clock)
            .get(draft_id)?
            .ok_or_else(|| Error::message(format!("draft {draft_id} not found")))
    }

    /// A draft with its targets narrowed to the connected ones.
    pub(crate) fn effective_draft(&self, draft: &DraftRecord) -> Result<DraftRecord> {
        let targets = effective_post_targets(self.sqlite, &TargetMap::parse(Some(&draft.targets_json)))?;
        Ok(DraftRecord {
            targets_json: targets.to_json(),
            ..draft.clone()
        })
    }

    pub fn publish_draft_to_queue(&self, draft_id: i64, options: PublishDraftOptions) -> Result<i64> {
        let started = Instant::now();
        let result = self.publish_draft_to_queue_internal(draft_id, options);
        self.boundaries.usage.record(
            self.sqlite,
            "publishing.plan.create",
            result.is_ok(),
            started.elapsed().as_millis() as u64,
        );
        result
    }

    fn publish_draft_to_queue_internal(&self, draft_id: i64, options: PublishDraftOptions) -> Result<i64> {
        let draft = self.require_draft(draft_id)?;
        let effective = self.effective_draft(&draft)?;
        assert_publication_preflight(&effective, &channel_upload_limits(self.sqlite)?)?;
        let now = self.now();
        let mode = options.mode.unwrap_or(PublishMode::Immediate);
        let at = |locale: Locale, requested: Option<Timestamp>| {
            if mode == PublishMode::Immediate || options.immediate_locale == Some(locale) {
                Some(now.clone())
            } else {
                requested.map(foundation::time::to_iso_string)
            }
        };
        let (ru_at, en_at) = (at(Locale::Ru, options.ru_at), at(Locale::En, options.en_at));
        // One immediate transaction for the whole hand-off: id allocation and
        // the jobs it owns become visible together, and concurrent interfaces
        // cannot choose the same next public id from a stale maximum.
        let sqlite = self.sqlite;
        let (post_id, plan) = immediate_transaction(sqlite, || {
            let publication_id = self.ensure_publication(draft_id, &now)?;
            self.copy_accepted_entities(draft_id, &now)?;
            let registered = registered_post_target_ids(sqlite)?;
            let story_cards = self.boundaries.story_cards.ready_media(sqlite, draft_id)?;
            let has_story_target = TargetMap::parse(Some(&effective.targets_json))
                .enabled()
                .any(is_story_target);
            if story_cards.is_some()
                && has_story_target
                && !matches!(draft.story_publish_mode.as_deref(), Some("all" | "site_only"))
            {
                return Err(Error::message(
                    "Story delivery decision is required for a text-only post",
                ));
            }
            let plan = create_publication_plan(
                &effective,
                draft_id,
                publication_id,
                &PublicationSchedule {
                    mode,
                    ru_at: ru_at.clone(),
                    en_at: en_at.clone(),
                },
                &now,
                (!registered.is_empty()).then_some(registered.as_slice()),
                story_cards.as_ref(),
            )?;
            self.persist_publication_plan_tx(&plan)?;
            enrich_published_post_entities(&mut EntityEnrichmentStore::new(sqlite), draft_id, &now)?;
            Ok((publication_id, plan))
        })?;
        self.refresh_publication_status(post_id)?;
        record_event(
            sqlite,
            self.clock,
            &DomainEventInput {
                publication_ref: Some(publication_ref(PublicationRefKind::Post, post_id)),
                event_type: "publishing.plan.created".into(),
                severity: Severity::Info,
                target: None,
                message: format!("Publication plan created for draft #{draft_id}"),
                details: Some(object(json!({
                    "draft_id": draft_id,
                    "mode": mode.as_str(),
                    "ru_at": ru_at,
                    "en_at": en_at,
                    "targets": plan.targets.enabled().collect::<Vec<_>>(),
                }))),
                cooldown_seconds: None,
            },
        )?;
        Ok(post_id)
    }

    fn copy_accepted_entities(&self, draft_id: i64, now: &str) -> Result<()> {
        let sqlite = self.sqlite;
        let candidates: Vec<(String, String, String, Option<String>)> = sqlite
            .prepare(
                r#"select "kind", "slug", "title_ru", "title_en" from "draft_entity_candidates" where ("draft_entity_candidates"."draft_id" = ? and "draft_entity_candidates"."status" = ?)"#,
            )?
            .query_map(params![draft_id, "accepted"], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<db::rusqlite::Result<_>>()?;
        if candidates.is_empty() {
            return Ok(());
        }
        let rows = vec!["(null, ?, null, ?, ?, ?, ?, ?)"; candidates.len()].join(", ");
        sqlite.execute(
            &format!(
                r#"insert into "knowledge_entities" ("id", "kind", "parent_entity_id", "slug", "title_ru", "title_en", "created_at", "updated_at") values {rows} on conflict do nothing"#
            ),
            params_from_iter(candidates.iter().flat_map(|(kind, slug, title_ru, title_en)| {
                [
                    SqlValue::Text(kind.clone()),
                    SqlValue::Text(slug.clone()),
                    SqlValue::Text(title_ru.clone()),
                    title_en.clone().map_or(SqlValue::Null, SqlValue::Text),
                    SqlValue::Text(now.into()),
                    SqlValue::Text(now.into()),
                ]
            })),
        )?;
        let mut kinds: Vec<&str> = Vec::new();
        for (kind, ..) in &candidates {
            if !kinds.contains(&kind.as_str()) {
                kinds.push(kind);
            }
        }
        let entities: Vec<i64> = sqlite
            .prepare(&format!(
                r#"select "id", "kind", "slug" from "knowledge_entities" where "knowledge_entities"."kind" in ({})"#,
                vec!["?"; kinds.len()].join(", ")
            ))?
            .query_map(params_from_iter(kinds.iter()), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<db::rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|(_, kind, slug)| candidates.iter().any(|(k, s, ..)| k == kind && s == slug))
            .map(|(id, ..)| id)
            .collect();
        if !entities.is_empty() {
            let rows = vec!["(?, ?, ?)"; entities.len()].join(", ");
            sqlite.execute(
                &format!(
                    r#"insert into "draft_entity_links" ("draft_id", "entity_id", "created_at") values {rows} on conflict do nothing"#
                ),
                params_from_iter(entities.iter().flat_map(|id| {
                    [
                        SqlValue::Integer(draft_id),
                        SqlValue::Integer(*id),
                        SqlValue::Text(now.into()),
                    ]
                })),
            )?;
        }
        Ok(())
    }

    /// The stable public id a draft gets when it first enters delivery: its
    /// own id when free, else the next after the largest.
    fn ensure_publication(&self, draft_id: i64, now: &str) -> Result<i64> {
        let sqlite = self.sqlite;
        let existing: Option<Option<i64>> = sqlite
            .query_row(
                r#"select "post_id" from "drafts" where "drafts"."id" = ?"#,
                [draft_id],
                |row| row.get(0),
            )
            .optional()?;
        match existing {
            None => return Err(Error::message(format!("draft {draft_id} not found"))),
            Some(Some(post_id)) => return Ok(post_id),
            Some(None) => {}
        }
        let taken = sqlite
            .query_row(
                r#"select "id" from "drafts" where "drafts"."post_id" = ?"#,
                [draft_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        let next = if taken {
            sqlite.query_row(
                r#"select coalesce(max("drafts"."post_id"), 0) + 1 from "drafts""#,
                [],
                |row| row.get::<_, i64>(0),
            )?
        } else {
            draft_id
        };
        sqlite
            .query_row(
                r#"update "drafts" set "post_id" = ?, "status" = ?, "updated_at" = ? where ("drafts"."id" = ? and "drafts"."post_id" is null) returning "post_id""#,
                params![next, "scheduled", now, draft_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten()
            .ok_or_else(|| Error::message("draft publication id allocation did not return an id"))
    }
}
