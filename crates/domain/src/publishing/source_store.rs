//! The durable publication source and plan, read back from the draft, its
//! locales and its thread.

use content::Locale;
use content::message::MediaItem;
use content::thread::{LocalizedThreadPart, localized_thread};
use db::rusqlite::{OptionalExtension, Row, params};
use foundation::json::json_record_array;
use serde_json::{Map, Value, json};

use super::Publishing;
use super::publication_plan::effective_publication_targets;
use super::publication_source::{PublicationLocaleSource, PublicationSource};
use super::state::PlanRecord;
use crate::repositories::ThreadPartStore;
use crate::targets::TargetMap;
use crate::{Error, Result};

/// `publish_mode`, `scheduled_at`, `scheduled_en_at`, `story_publish_mode`.
type PlanColumns = (Option<String>, Option<String>, Option<String>, Option<String>);

struct LocaleRow {
    locale: String,
    source_text: Option<String>,
    approved_text: Option<String>,
    entities_json: Option<String>,
    media_json: Option<String>,
    story_media_json: Option<String>,
    site_media_json: Option<String>,
    slug: Option<String>,
    site_enabled: i64,
    publish_at: Option<String>,
}

fn locale_row(row: &Row<'_>) -> db::rusqlite::Result<LocaleRow> {
    Ok(LocaleRow {
        locale: row.get(0)?,
        source_text: row.get(1)?,
        approved_text: row.get(2)?,
        entities_json: row.get(3)?,
        media_json: row.get(4)?,
        story_media_json: row.get(5)?,
        site_media_json: row.get(6)?,
        slug: row.get(7)?,
        site_enabled: row.get(8)?,
        publish_at: row.get(9)?,
    })
}

fn locale_source(
    row: Option<&LocaleRow>,
    fallback_media: &[MediaItem],
    thread: Vec<LocalizedThreadPart>,
) -> PublicationLocaleSource {
    let own_media = json_record_array(row.and_then(|row| row.media_json.as_deref()));
    PublicationLocaleSource {
        text: row
            .and_then(|row| row.approved_text.clone().or_else(|| row.source_text.clone()))
            .unwrap_or_default(),
        entities: json_record_array(row.and_then(|row| row.entities_json.as_deref())),
        media: if own_media.is_empty() {
            fallback_media.to_vec()
        } else {
            own_media
        },
        story_media: json_record_array(row.and_then(|row| row.story_media_json.as_deref())),
        site_media: json_record_array(row.and_then(|row| row.site_media_json.as_deref())),
        slug: row.and_then(|row| row.slug.clone()).unwrap_or_default(),
        publish_at: row.and_then(|row| row.publish_at.clone()),
        site_enabled: row.is_some_and(|row| row.site_enabled == 1),
        thread,
    }
}

impl Publishing<'_> {
    pub fn publication_source_from_db(&self, post_id: i64) -> Result<PublicationSource> {
        let root: Option<(i64, Option<i64>, String)> = self
            .sqlite
            .query_row(
                r#"select "id", "post_id", "targets_json" from "drafts" where "drafts"."post_id" = ?"#,
                [post_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((draft_id, Some(post_id), targets_json)) = root else {
            return Err(Error::message(format!("publication source not found: post:{post_id}")));
        };
        let rows: Vec<LocaleRow> = self
            .sqlite
            .prepare(
                r#"select "locale", "source_text", "approved_text", "entities_json", "media_json", "story_media_json", "site_media_json", "slug", "site_enabled", "publish_at" from "post_locales" where "post_locales"."draft_id" = ?"#,
            )?
            .query_map([draft_id], locale_row)?
            .collect::<db::rusqlite::Result<_>>()?;
        // `new Map(rows)`: a later row of the same locale wins.
        let by_locale = |locale: &str| rows.iter().rev().find(|row| row.locale == locale);
        let thread = ThreadPartStore::new(self.sqlite, self.clock).list(draft_id)?;
        let ru = locale_source(by_locale("ru"), &[], localized_thread(&thread, Locale::Ru));
        let en = locale_source(by_locale("en"), &ru.media, localized_thread(&thread, Locale::En));
        Ok(PublicationSource {
            draft_id,
            post_id,
            targets: TargetMap::parse(Some(&targets_json)),
            ru,
            en,
        })
    }

    /// The plan a publication is delivered by: its mode, its effective
    /// targets and its per-locale dates.
    pub fn publication_plan_from_db(&self, post_id: i64, registered_targets: &[String]) -> Result<Option<PlanRecord>> {
        let row: Option<PlanColumns> = self
            .sqlite
            .query_row(
                r#"select "publish_mode", "scheduled_at", "scheduled_en_at", "story_publish_mode" from "drafts" where "drafts"."post_id" = ?"#,
                params![post_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((mode, ru_at, en_at, story_mode)) = row else {
            return Ok(None);
        };
        let source = self.publication_source_from_db(post_id)?;
        let targets = effective_publication_targets(
            &source.targets,
            (!registered_targets.is_empty()).then_some(registered_targets),
            [source.ru.media.len(), source.en.media.len()],
            !source.ru.story_media.is_empty() || !source.en.story_media.is_empty(),
            story_mode.as_deref(),
        );
        let mut plan = Map::new();
        plan.insert("mode".into(), json!(mode));
        plan.insert("targets".into(), Value::Object(targets.to_json_value()));
        plan.insert("scheduled_at".into(), json!(ru_at));
        plan.insert("scheduled_en_at".into(), json!(en_at));
        Ok(Some(plan))
    }
}
