//! One card per locale of a text-only post, queued
//! when its text changes and discarded with its file when nothing needs it.

use std::path::Path;

use content::Locale;
use content::draft_content::{DraftContentSource, draft_locale_content};
use content::message::MediaItem;
use db::rusqlite::{Connection, OptionalExtension, params};
use foundation::logger::{LogLevel, log};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::copy::{TEMPLATE_VERSION, story_card_copy};
use crate::application::ports::{Clock, StoryPublishMode};
use crate::publishing::boundaries::{StoryCardMedia, StoryCardState, StoryCards};
use crate::repositories::{stamp, transaction};
use crate::targets::{TargetMap, story_card_use};
use crate::{Error, Result};

/// The Story-card store on the connection a caller hands it, so the caller's
/// transaction covers its writes.
#[derive(Clone, Copy)]
pub struct StoryCardStore<C> {
    clock: C,
}

impl<C: Clock> StoryCardStore<C> {
    pub fn new(clock: C) -> Self {
        Self { clock }
    }
}

struct LocaleRow {
    locale: String,
    source_text: String,
    approved_text: Option<String>,
    media_json: Option<String>,
}

impl<C: Clock> StoryCards for StoryCardStore<C> {
    /// `queueDraftStoryCards`.
    fn queue(&self, sqlite: &Connection, draft_id: i64) -> Result<()> {
        let (targets_json, status): (String, String) = sqlite
            .query_row(
                r#"select "targets_json", "status" from "drafts" where "drafts"."id" = ?"#,
                [draft_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| Error::message(format!("draft {draft_id} not found")))?;
        let locales: Vec<LocaleRow> = sqlite
            .prepare(
                r#"select "locale", "source_text", "approved_text", "media_json" from "post_locales" where "post_locales"."draft_id" = ?"#,
            )?
            .query_map([draft_id], |row| {
                Ok(LocaleRow {
                    locale: row.get(0)?,
                    source_text: row.get(1)?,
                    approved_text: row.get(2)?,
                    media_json: row.get(3)?,
                })
            })?
            .collect::<db::rusqlite::Result<_>>()?;
        // As `new Map(rows.map(...))`: a later row of the same locale wins.
        let row = |locale: &str| locales.iter().rev().find(|row| row.locale == locale);
        let (ru, en) = (row("ru"), row("en"));
        // A card nothing publishes is a rendering job and a question for
        // nobody: no Story platform to carry it and no site page to
        // illustrate with it.
        let used = story_card_use(&TargetMap::parse(Some(&targets_json)));
        let has_media = |row: Option<&LocaleRow>| media_count(row.and_then(|row| row.media_json.as_deref())) > 0;
        if (!used.stories && !used.site) || has_media(ru) || has_media(en) {
            self.discard(sqlite, draft_id)?;
            reset_story_choice(sqlite, draft_id, &stamp(&self.clock))?;
            return Ok(());
        }
        let now = stamp(&self.clock);
        // The same resolution delivery uses, so the English card never
        // borrows the Russian text.
        let source = DraftContentSource {
            text_ru: ru.map(|row| row.source_text.as_str()),
            text_en_approved: en.and_then(|row| row.approved_text.as_deref()),
            text_en_machine: en.map(|row| row.source_text.as_str()),
            ..DraftContentSource::default()
        };
        let mut stale = Vec::new();
        transaction(sqlite, || {
            let mut requeued = false;
            for locale in [Locale::Ru, Locale::En] {
                let text = draft_locale_content(&source, locale).text;
                // A locale with no text has no card to render: preflight
                // refuses to publish that locale anyway.
                if foundation::js::trim(&text).is_empty() {
                    continue;
                }
                let copy = story_card_copy(&text);
                let source_hash = format!(
                    "{:x}",
                    Sha256::digest(crate::json::stringify(
                        &json!({"locale": locale.as_str(), "text": text, "template": TEMPLATE_VERSION})
                    ))
                );
                let current: Option<(String, String, Option<String>)> = sqlite
                    .query_row(
                        r#"select "source_hash", "status", "local_path" from "draft_story_cards" where ("draft_story_cards"."draft_id" = ? and "draft_story_cards"."locale" = ?)"#,
                        params![draft_id, locale.as_str()],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                if let Some((hash, status, Some(path))) = &current
                    && *hash == source_hash
                    && status == "ready"
                    && !path.is_empty()
                    && Path::new(path).exists()
                {
                    continue;
                }
                if let Some((_, _, Some(path))) = &current
                    && !path.is_empty()
                {
                    stale.push(path.clone());
                }
                requeued = true;
                sqlite.execute(
                    r#"insert into "draft_story_cards" ("draft_id", "locale", "source_hash", "headline", "emoji", "status", "local_path", "attempt_count", "next_attempt_at", "locked_by", "locked_at", "last_error", "template_version", "created_at", "updated_at") values (?1, ?2, ?3, ?4, ?5, 'queued', null, 0, ?6, null, null, null, ?7, ?6, ?6) on conflict ("draft_story_cards"."draft_id", "draft_story_cards"."locale") do update set "source_hash" = ?3, "headline" = ?4, "emoji" = ?5, "status" = 'queued', "local_path" = null, "attempt_count" = 0, "next_attempt_at" = ?6, "locked_by" = null, "locked_at" = null, "last_error" = null, "template_version" = ?7, "updated_at" = ?6"#,
                    params![draft_id, locale.as_str(), source_hash, copy.headline, copy.emoji, now, TEMPLATE_VERSION],
                )?;
            }
            // Only a card that actually changed invalidates the editor's Story
            // choice: this runs on every draft save.
            if requeued && status != "scheduled" {
                reset_story_choice(sqlite, draft_id, &now)?;
            }
            Ok(())
        })?;
        remove_files(&stale);
        Ok(())
    }

    /// `storyCardsForDraft`.
    fn for_draft(&self, sqlite: &Connection, draft_id: i64) -> Result<Vec<StoryCardState>> {
        cards(sqlite, draft_id)
    }

    /// `readyStoryCardMedia`: both cards, only when both are rendered.
    fn ready_media(&self, sqlite: &Connection, draft_id: i64) -> Result<Option<StoryCardMedia>> {
        let rows = cards(sqlite, draft_id)?;
        let ready = |locale: &str| {
            rows.iter()
                .rev()
                .find(|card| card.locale == locale)
                .filter(|card| card.status == "ready")
                .and_then(|card| card.local_path.clone())
                .filter(|path| !path.is_empty() && Path::new(path).exists())
        };
        let (Some(ru), Some(en)) = (ready("ru"), ready("en")) else {
            return Ok(None);
        };
        Ok(Some(StoryCardMedia {
            ru: media_item(&ru),
            en: media_item(&en),
        }))
    }

    /// `setStoryPublishMode`.
    fn set_publish_mode(&self, sqlite: &Connection, draft_id: i64, mode: StoryPublishMode) -> Result<()> {
        sqlite.execute(
            r#"update "drafts" set "story_publish_mode" = ?, "updated_at" = ? where "drafts"."id" = ?"#,
            params![mode.as_str(), stamp(&self.clock), draft_id],
        )?;
        Ok(())
    }

    /// `discardDraftStoryCards`: the rows and their files.
    fn discard(&self, sqlite: &Connection, draft_id: i64) -> Result<()> {
        let paths: Vec<String> = cards(sqlite, draft_id)?
            .into_iter()
            .filter_map(|card| card.local_path.filter(|path| !path.is_empty()))
            .collect();
        sqlite.execute(
            r#"delete from "draft_story_cards" where "draft_story_cards"."draft_id" = ?"#,
            [draft_id],
        )?;
        remove_files(&paths);
        Ok(())
    }
}

fn cards(sqlite: &Connection, draft_id: i64) -> Result<Vec<StoryCardState>> {
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
    Ok(rows.collect::<db::rusqlite::Result<_>>()?)
}

fn reset_story_choice(sqlite: &Connection, draft_id: i64, now: &str) -> Result<()> {
    sqlite.execute(
        r#"update "drafts" set "story_publish_mode" = null, "updated_at" = ? where "drafts"."id" = ?"#,
        params![now, draft_id],
    )?;
    Ok(())
}

/// `Array.isArray(mediaJson) ? mediaJson.length : 0` over the JSON column.
fn media_count(value: Option<&str>) -> usize {
    match value.map(serde_json::from_str::<Value>) {
        Some(Ok(Value::Array(items))) => items.len(),
        _ => 0,
    }
}

fn media_item(path: &str) -> MediaItem {
    let Value::Object(item) = json!({
        "type": "IMAGE",
        "local_path": path,
        "localPath": path,
        "story_local_path": path,
        "storyLocalPath": path,
        "role": "text_story_card",
    }) else {
        unreachable!("built as an object")
    };
    item
}

/// A file already gone is what removing it wanted; any other failure is
/// logged, as the rows are already settled.
fn remove_files(paths: &[String]) {
    for file in paths {
        if let Err(error) = std::fs::remove_file(file)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            log(
                LogLevel::Warn,
                "failed to remove stale Story card",
                Some(json!({"file": file, "error": error.to_string()})),
            );
        }
    }
}
