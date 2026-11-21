//! The golden host's Story-card store (`story-cards/store.ts`): the rows of
//! `draft_story_cards` the bot reads, queued and discarded the way the
//! TypeScript store does. Rendering is the Story worker's; a case that needs a
//! rendered card says so with a trigger ([`render_story_cards`]).
//!
//! Only what a golden can observe is reproduced: which cards exist, their
//! status and file, their order, and when the draft's Story choice is reset.
//! The card copy (headline, emoji) is a placeholder; the source hash is the
//! text it was queued for, which keeps "re-queue only what changed" exact.

use std::path::Path;

use content::Locale;
use content::draft_content::{DraftContentSource, draft_locale_content};
use db::rusqlite::{Connection, OptionalExtension, params};
use domain::application::ports::{Clock, StoryPublishMode};
use domain::publishing::boundaries::{StoryCardMedia, StoryCardState, StoryCards};
use domain::targets::{TargetMap, story_card_use};
use foundation::time::to_iso_string;
use serde_json::{Map, Value, json};

use super::host::GoldenHost;

/// What `buildStoryCardCopy` stamps on every card (`TEMPLATE_VERSION`).
const TEMPLATE_VERSION: &str = "strata-v3";

fn media_count(value: Option<&str>) -> usize {
    match value.map(serde_json::from_str::<Value>) {
        Some(Ok(Value::Array(items))) => items.len(),
        _ => 0,
    }
}

fn remove_files(paths: &[String]) {
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
}

fn cards(sqlite: &Connection, draft_id: i64) -> domain::Result<Vec<StoryCardState>> {
    let mut statement = sqlite.prepare(
        r#"select "locale", "status", "local_path" from "draft_story_cards" where "draft_story_cards"."draft_id" = ?"#,
    )?;
    let rows = statement.query_map([draft_id], |row| {
        Ok(StoryCardState {
            locale: row.get(0)?,
            status: row.get(1)?,
            local_path: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

impl GoldenHost {
    fn now(&self) -> String {
        to_iso_string(self.clock.now())
    }

    fn reset_story_choice(&self, sqlite: &Connection, draft_id: i64, now: &str) -> domain::Result<()> {
        sqlite.execute(
            r#"update "drafts" set "story_publish_mode" = null, "updated_at" = ? where "drafts"."id" = ?"#,
            params![now, draft_id],
        )?;
        Ok(())
    }
}

impl StoryCards for GoldenHost {
    /// `queueDraftStoryCards`.
    fn queue(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<()> {
        let (targets, status): (String, String) = sqlite
            .query_row(
                r#"select "targets_json", "status" from "drafts" where "drafts"."id" = ?"#,
                [draft_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| domain::Error::message(format!("draft {draft_id} not found")))?;
        let mut locales: Vec<(String, String, Option<String>, Option<String>)> = Vec::new();
        {
            let mut statement = sqlite.prepare(
                r#"select "locale", "source_text", "approved_text", "media_json" from "post_locales" where "post_locales"."draft_id" = ?"#,
            )?;
            let rows = statement.query_map([draft_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?;
            for row in rows {
                locales.push(row?);
            }
        }
        let locale = |name: &str| locales.iter().find(|(locale, ..)| locale == name);
        let (ru, en) = (locale("ru"), locale("en"));
        // A card nothing publishes is a rendering job and a question for nobody.
        let used = story_card_use(&TargetMap::parse(Some(&targets)));
        let has_media = |row: Option<&(String, String, Option<String>, Option<String>)>| {
            media_count(row.and_then(|(_, _, _, media)| media.as_deref())) > 0
        };
        let now = self.now();
        if (!used.stories && !used.site) || has_media(ru) || has_media(en) {
            self.discard(sqlite, draft_id)?;
            return self.reset_story_choice(sqlite, draft_id, &now);
        }
        let source = DraftContentSource {
            text_ru: ru.map(|(_, text, _, _)| text.as_str()),
            text_en_approved: en.and_then(|(_, _, approved, _)| approved.as_deref()),
            text_en_machine: en.map(|(_, text, _, _)| text.as_str()),
            ..DraftContentSource::default()
        };
        let mut stale = Vec::new();
        let mut requeued = false;
        let transaction = sqlite.unchecked_transaction()?;
        for locale in [Locale::Ru, Locale::En] {
            let text = draft_locale_content(&source, locale).text;
            if foundation::js::trim(&text).is_empty() {
                continue;
            }
            let source_hash =
                json!({"locale": locale.as_str(), "text": text, "template": TEMPLATE_VERSION}).to_string();
            let current: Option<(String, String, Option<String>)> = transaction
                .query_row(
                    r#"select "source_hash", "status", "local_path" from "draft_story_cards" where ("draft_story_cards"."draft_id" = ? and "draft_story_cards"."locale" = ?)"#,
                    params![draft_id, locale.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            if let Some((hash, status, Some(path))) = &current
                && *hash == source_hash
                && status == "ready"
                && Path::new(path).exists()
            {
                continue;
            }
            if let Some((_, _, Some(path))) = &current {
                stale.push(path.clone());
            }
            requeued = true;
            let headline = foundation::js::trim(text.split('\n').next().unwrap_or_default()).to_owned();
            transaction.execute(
                r#"insert into "draft_story_cards" ("draft_id", "locale", "source_hash", "headline", "emoji", "status", "local_path", "attempt_count", "next_attempt_at", "locked_by", "locked_at", "last_error", "template_version", "created_at", "updated_at") values (?1, ?2, ?3, ?4, null, 'queued', null, 0, ?5, null, null, null, ?6, ?5, ?5) on conflict ("draft_story_cards"."draft_id", "draft_story_cards"."locale") do update set "source_hash" = ?3, "headline" = ?4, "emoji" = null, "status" = 'queued', "local_path" = null, "attempt_count" = 0, "next_attempt_at" = ?5, "locked_by" = null, "locked_at" = null, "last_error" = null, "template_version" = ?6, "updated_at" = ?5"#,
                params![draft_id, locale.as_str(), source_hash, headline, now, TEMPLATE_VERSION],
            )?;
        }
        // Only a card that actually changed invalidates the editor's choice.
        if requeued && status != "scheduled" {
            self.reset_story_choice(&transaction, draft_id, &now)?;
        }
        transaction.commit()?;
        remove_files(&stale);
        Ok(())
    }

    /// `storyCardsForDraft`.
    fn for_draft(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<Vec<StoryCardState>> {
        cards(sqlite, draft_id)
    }

    /// `setStoryPublishMode`.
    fn set_publish_mode(&self, sqlite: &Connection, draft_id: i64, mode: StoryPublishMode) -> domain::Result<()> {
        let mode = match mode {
            StoryPublishMode::All => "all",
            StoryPublishMode::SiteOnly => "site_only",
        };
        sqlite.execute(
            r#"update "drafts" set "story_publish_mode" = ?, "updated_at" = ? where "drafts"."id" = ?"#,
            params![mode, self.now(), draft_id],
        )?;
        Ok(())
    }

    /// `readyStoryCardMedia`: both cards, only when both are rendered.
    fn ready_media(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<Option<StoryCardMedia>> {
        let rows = cards(sqlite, draft_id)?;
        let ready = |locale: &str| {
            rows.iter()
                .find(|card| card.locale == locale)
                .filter(|card| card.status == "ready")
                .and_then(|card| card.local_path.clone())
                .filter(|path| !path.is_empty() && Path::new(path).exists())
        };
        let (Some(ru), Some(en)) = (ready("ru"), ready("en")) else {
            return Ok(None);
        };
        let item = |path: String| -> Map<String, Value> {
            let value = json!({
                "type": "IMAGE",
                "local_path": path,
                "localPath": path,
                "story_local_path": path,
                "storyLocalPath": path,
                "role": "text_story_card",
            });
            match value {
                Value::Object(object) => object,
                _ => unreachable!("built as an object"),
            }
        };
        Ok(Some(StoryCardMedia {
            ru: item(ru),
            en: item(en),
        }))
    }

    /// `discardDraftStoryCards`: the rows and their files.
    fn discard(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<()> {
        let paths: Vec<String> = cards(sqlite, draft_id)?
            .into_iter()
            .filter_map(|card| card.local_path)
            .collect();
        sqlite.execute(
            r#"delete from "draft_story_cards" where "draft_story_cards"."draft_id" = ?"#,
            [draft_id],
        )?;
        remove_files(&paths);
        Ok(())
    }
}

/// The recorder's `renderStoryCards(h, draftId)`: every card of the draft
/// rendered, its file the 1x1 JPEG fixture.
pub fn render_story_cards(sqlite: &Connection, fixture: &Path, draft_id: i64, now: &str) {
    sqlite
        .execute(
            r#"update "draft_story_cards" set "status" = 'ready', "local_path" = ?, "updated_at" = ? where "draft_story_cards"."draft_id" = ?"#,
            params![fixture.display().to_string(), now, draft_id],
        )
        .unwrap();
}
