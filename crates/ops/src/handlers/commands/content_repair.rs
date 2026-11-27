//! Durable content repaired before
//! Delivery rebuilds the site or retries a target.

use content::message::{Entity, MediaItem};
use db::rusqlite::{Connection, OptionalExtension, params};
use domain::json::stringify;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::super::publication_ref::ResolvedPublicationRef;
use super::{object, refusal};

/// `editLocaleContentTx`: the write carries the text it was reviewed against.
pub(crate) fn edit_locale_content_tx(
    sqlite: &Connection,
    now: &str,
    reference: &ResolvedPublicationRef,
    locale: &str,
    text: &str,
    entities: &[Entity],
    expected_text_hash: Option<&str>,
) -> domain::Result<Map<String, Value>> {
    let value = text.trim();
    if value.is_empty() {
        return Err(refusal(format!("text_{locale} is required")));
    }
    let post_id = reference.post_id;
    let draft_id: i64 = sqlite
        .query_row(
            r#"select "id" from "drafts" where "drafts"."post_id" = ?"#,
            [post_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| refusal(format!("publication {post_id} has no aggregate")))?;
    let current: (String, Option<String>) = sqlite
        .query_row(
            r#"select "source_text", "approved_text" from "post_locales" where ("post_locales"."draft_id" = ? and "post_locales"."locale" = ?)"#,
            params![draft_id, locale],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| refusal(format!("publication {post_id} has no {locale} content")))?;
    let (source_text, approved_text) = current;
    let previous_text = approved_text.clone().unwrap_or(source_text);
    assert_reviewed_text(&previous_text, expected_text_hash)?;
    let html = content::text::entities_to_html(value, entities);
    let entities_json = stringify(&Value::Array(entities.iter().cloned().map(Value::Object).collect()));
    let guard = r#"where ("post_locales"."draft_id" = ? and "post_locales"."locale" = ? and coalesce("post_locales"."approved_text", "post_locales"."source_text") = ?) returning "draft_id""#;
    let updated: Vec<i64> = if locale == "en" {
        sqlite
            .prepare(&format!(
                r#"update "post_locales" set "approved_text" = ?, "html" = ?, "entities_json" = ?, "updated_at" = ? {guard}"#
            ))?
            .query_map(
                params![value, html, entities_json, now, draft_id, locale, previous_text],
                |row| row.get(0),
            )?
            .collect::<db::rusqlite::Result<_>>()?
    } else {
        let approved = approved_text.as_ref().map(|_| value);
        sqlite
            .prepare(&format!(
                r#"update "post_locales" set "source_text" = ?, "approved_text" = ?, "html" = ?, "entities_json" = ?, "updated_at" = ? {guard}"#
            ))?
            .query_map(
                params![value, approved, html, entities_json, now, draft_id, locale, previous_text],
                |row| row.get(0),
            )?
            .collect::<db::rusqlite::Result<_>>()?
    };
    if updated.len() != 1 {
        return Err(refusal(format!("publication {post_id} text changed during the edit")));
    }
    touch_draft(sqlite, draft_id, now)?;
    enqueue_repair_site_job(sqlite, reference, &format!("edit_{locale}"), now)?;
    Ok(object(json!({
        "ok": true,
        "post_id": post_id,
        "publication_key": reference.publication_key,
        "locale": locale,
        "text": true,
    })))
}

pub(crate) fn assert_reviewed_text(text: &str, expected_hash: Option<&str>) -> domain::Result<()> {
    match expected_hash {
        Some(expected) if format!("{:x}", Sha256::digest(text.as_bytes())) != expected => {
            Err(refusal("Published text changed; review the latest copy before editing"))
        }
        _ => Ok(()),
    }
}

/// `parseLocaleEntities`: reviewed formatting that must fit the replacement
/// text, measured in UTF-16 code units as Telegram counts them.
pub(crate) fn parse_locale_entities(raw: Option<&str>, text: &str) -> Result<Vec<Entity>, String> {
    let Some(raw) = raw else { return Ok(Vec::new()) };
    let parsed: Value = serde_json::from_str(raw).map_err(|error| format!("JSON Parse error: {error}"))?;
    let entities = match parsed {
        Value::Array(entities) if entities.len() <= 1_000 => entities,
        _ => return Err("entities_json must be an array of at most 1000 entities".into()),
    };
    let length = text.encode_utf16().count() as u64;
    entities
        .into_iter()
        .map(|entity| {
            let Value::Object(entity) = entity else {
                return Err("Each formatting entity must fit the replacement text".to_owned());
            };
            let units = |key: &str| entity.get(key).and_then(Value::as_u64);
            match (units("offset"), units("length")) {
                (Some(offset), Some(span)) if span >= 1 && offset + span <= length => Ok(entity),
                _ => Err("Each formatting entity must fit the replacement text".to_owned()),
            }
        })
        .collect()
}

/// `replaceLocaleMediaTx`: `None` falls back to the other locale's media.
pub(crate) fn replace_locale_media_tx(
    sqlite: &Connection,
    now: &str,
    reference: &ResolvedPublicationRef,
    locale: &str,
    media: Option<&[MediaItem]>,
) -> domain::Result<Map<String, Value>> {
    let post_id = reference.post_id;
    let draft_id: i64 = sqlite
        .query_row(
            r#"select "id" from "drafts" where "drafts"."post_id" = ?"#,
            [post_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| refusal(format!("publication {post_id} has no aggregate")))?;
    let next_media = match media {
        Some(media) => Value::Array(media.iter().cloned().map(Value::Object).collect()),
        None => {
            let other = if locale == "en" { "ru" } else { "en" };
            let stored: Option<String> = sqlite
                .query_row(
                    r#"select "media_json" from "post_locales" where ("post_locales"."draft_id" = ? and "post_locales"."locale" = ?)"#,
                    params![draft_id, other],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            // A JSON column reads back parsed; `null` stored is no media.
            match stored.as_deref().map(serde_json::from_str::<Value>).transpose()? {
                None | Some(Value::Null) => json!([]),
                Some(value) => value,
            }
        }
    };
    let next_media = stringify(&next_media);
    sqlite.execute(
        r#"update "post_locales" set "media_json" = ?, "site_media_json" = ?, "updated_at" = ? where ("post_locales"."draft_id" = ? and "post_locales"."locale" = ?)"#,
        params![next_media, next_media, now, draft_id, locale],
    )?;
    touch_draft(sqlite, draft_id, now)?;
    let reason = match media {
        None => format!("use_other_media_for_{locale}"),
        Some(_) => format!("replace_{locale}_media"),
    };
    enqueue_repair_site_job(sqlite, reference, &reason, now)?;
    Ok(object(json!({
        "ok": true,
        "post_id": post_id,
        "publication_key": reference.publication_key,
        "locale": locale,
        "media": media.is_some(),
    })))
}

/// `refreshLocaleSiteTx`: one locale's public projection, social targets untouched.
pub(crate) fn refresh_locale_site_tx(
    sqlite: &Connection,
    now: &str,
    reference: &ResolvedPublicationRef,
    locale: &str,
) -> domain::Result<Map<String, Value>> {
    enqueue_repair_site_job(sqlite, reference, &format!("refresh_{locale}_site"), now)?;
    Ok(object(json!({
        "ok": true,
        "post_id": reference.post_id,
        "publication_key": reference.publication_key,
        "locale": locale,
        "site_refresh": true,
    })))
}

/// `parseLocaleMedia`. Media reaches Delivery as a Content asset on disk or
/// as a Telegram file id; `None` means "use the other locale's".
pub(crate) fn parse_locale_media(raw: Option<&str>) -> Result<Option<Vec<MediaItem>>, String> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Ok(None);
    };
    if ["none", "null", "ru", "fallback"].contains(&raw.trim().to_lowercase().as_str()) {
        return Ok(None);
    }
    let parsed: Value = serde_json::from_str(raw).map_err(|error| format!("JSON Parse error: {error}"))?;
    let invalid = || "each media item needs file_id, local_path or asset_id".to_owned();
    let items = match parsed {
        Value::Array(items) => items,
        Value::Object(item) => vec![Value::Object(item)],
        _ => return Err(invalid()),
    };
    items
        .into_iter()
        .map(|item| match item {
            Value::Object(item) if locates_media(&item) => Ok(item),
            _ => Err(invalid()),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn locates_media(item: &MediaItem) -> bool {
    ["file_id", "fileId", "local_path", "localPath", "path", "asset_id"]
        .iter()
        .any(|key| item.get(*key).is_some_and(|value| !value.is_null()))
}

fn touch_draft(sqlite: &Connection, draft_id: i64, now: &str) -> domain::Result<()> {
    sqlite.execute(
        r#"update "drafts" set "updated_at" = ? where "drafts"."id" = ?"#,
        params![now, draft_id],
    )?;
    Ok(())
}

fn enqueue_repair_site_job(
    sqlite: &Connection,
    reference: &ResolvedPublicationRef,
    reason: &str,
    now: &str,
) -> domain::Result<()> {
    let active: Option<i64> = sqlite
        .query_row(
            r#"select "job_id" from "site_jobs" where ("site_jobs"."publication_key" = ? and "site_jobs"."reason" = ? and "site_jobs"."status" in (?, ?))"#,
            params![reference.publication_key, reason, "queued", "rendering"],
            |row| row.get(0),
        )
        .optional()?;
    if active.is_some() {
        return Ok(());
    }
    sqlite.execute(
        r#"insert into "site_jobs" ("job_id", "publication_key", "reason", "status", "attempt_count", "next_attempt_at", "locked_by", "locked_at", "last_error", "created_at", "updated_at") values (null, ?, ?, ?, ?, ?, null, null, null, ?, ?)"#,
        params![reference.publication_key, reason, "queued", 0, now, now, now],
    )?;
    Ok(())
}
