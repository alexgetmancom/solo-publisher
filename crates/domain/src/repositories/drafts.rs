use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde_json::Value;

use super::{ThreadPartStore, in_list, integers, stamp, transaction};
use crate::Result;
use crate::application::ports::{Clock, DraftPatch, DraftRecord, NewDraft};
use crate::json;

const SELECT_DRAFTS: &str = r#"select "drafts"."id", "drafts"."actor_id", "drafts"."status", "draft_locale_ru"."source_text", "draft_locale_en"."source_text", "draft_locale_en"."approved_text", "drafts"."targets_json", "draft_locale_ru"."media_json", "draft_locale_en"."media_json", "drafts"."scheduled_at", "drafts"."scheduled_en_at", "drafts"."post_id", "draft_locale_ru"."entities_json", "draft_locale_en"."entities_json", "drafts"."story_publish_mode", "drafts"."updated_at" from "drafts" left join "post_locales" "draft_locale_ru" on ("draft_locale_ru"."draft_id" = "drafts"."id" and "draft_locale_ru"."locale" = ?) left join "post_locales" "draft_locale_en" on ("draft_locale_en"."draft_id" = "drafts"."id" and "draft_locale_en"."locale" = ?)"#;

/// The joined row before its JSON is normalized and its thread attached.
struct DraftProjection {
    id: i64,
    actor_id: i64,
    status: String,
    text_ru: Option<String>,
    text_en_machine: Option<String>,
    text_en_approved: Option<String>,
    targets_json: String,
    media_ru: Option<String>,
    media_en: Option<String>,
    scheduled_at: Option<String>,
    scheduled_en_at: Option<String>,
    post_id: Option<i64>,
    text_ru_entities: Option<String>,
    text_en_entities: Option<String>,
    story_publish_mode: Option<String>,
    updated_at: String,
}

fn projection(row: &Row<'_>) -> db::rusqlite::Result<DraftProjection> {
    Ok(DraftProjection {
        id: row.get(0)?,
        actor_id: row.get(1)?,
        status: row.get(2)?,
        text_ru: row.get(3)?,
        text_en_machine: row.get(4)?,
        text_en_approved: row.get(5)?,
        targets_json: row.get(6)?,
        media_ru: row.get(7)?,
        media_en: row.get(8)?,
        scheduled_at: row.get(9)?,
        scheduled_en_at: row.get(10)?,
        post_id: row.get(11)?,
        text_ru_entities: row.get(12)?,
        text_en_entities: row.get(13)?,
        story_publish_mode: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

/// A JSON column read and written back as text, as `JSON.stringify` of the
/// parsed value: normalized, and `None` for SQL NULL or a JSON `null`.
fn json_text(text: Option<String>) -> Result<Option<String>> {
    let Some(text) = text else { return Ok(None) };
    let value: Value = serde_json::from_str(&text)?;
    Ok((!value.is_null()).then(|| json::stringify(&value)))
}

/// Media JSON text from a caller, stored only when it is an array.
fn media_value(text: Option<&str>) -> Result<SqlValue> {
    let Some(text) = text else { return Ok(SqlValue::Null) };
    let value: Value = serde_json::from_str(text)?;
    Ok(if value.is_array() {
        SqlValue::Text(json::stringify(&value))
    } else {
        SqlValue::Null
    })
}

/// Drafts as application records: the root row with its Russian and English
/// locales and its thread.
pub struct DraftStore<'a> {
    sqlite: &'a Connection,
    clock: &'a dyn Clock,
}

impl<'a> DraftStore<'a> {
    pub fn new(sqlite: &'a Connection, clock: &'a dyn Clock) -> Self {
        Self { sqlite, clock }
    }

    fn record(&self, row: DraftProjection) -> Result<DraftRecord> {
        Ok(DraftRecord {
            thread: ThreadPartStore::new(self.sqlite, self.clock).list(row.id)?,
            id: row.id,
            actor_id: row.actor_id,
            status: row.status,
            text_ru: row.text_ru.unwrap_or_default(),
            text_en_machine: row.text_en_machine.filter(|text| !text.is_empty()),
            text_en_approved: row.text_en_approved,
            targets_json: row.targets_json,
            media_ru_json: json_text(row.media_ru)?,
            media_en_json: json_text(row.media_en)?,
            scheduled_at: row.scheduled_at,
            scheduled_en_at: row.scheduled_en_at,
            post_id: row.post_id,
            text_ru_entities_json: row.text_ru_entities,
            text_en_entities_json: row.text_en_entities,
            story_publish_mode: row.story_publish_mode,
            updated_at: row.updated_at,
        })
    }

    pub fn create(&self, input: &NewDraft) -> Result<i64> {
        let now = stamp(self.clock);
        transaction(self.sqlite, || {
            let id: i64 = self.sqlite.query_row(
                r#"insert into "drafts" ("id", "actor_id", "status", "targets_json", "scheduled_at", "scheduled_en_at", "publish_mode", "post_id", "story_publish_mode", "created_at", "updated_at") values (null, ?, ?, ?, null, null, null, null, ?, ?, ?) returning "id""#,
                params![
                    input.actor_id,
                    "needs_review",
                    input.targets_json,
                    input.story_publish_mode.map(|mode| mode.as_str()),
                    now,
                    now
                ],
                |row| row.get(0),
            )?;
            self.sqlite.execute(
                r#"insert into "post_locales" ("draft_id", "locale", "source_text", "approved_text", "html", "entities_json", "media_json", "story_media_json", "site_media_json", "slug", "seo_title", "site_updated_at", "site_enabled", "publish_at", "published_at", "updated_at") values (?, ?, ?, null, null, ?, ?, null, null, null, null, null, ?, null, null, ?), (?, ?, ?, ?, null, null, ?, null, null, null, null, null, ?, null, null, ?)"#,
                params![
                    id,
                    "ru",
                    input.text_ru,
                    input.text_ru_entities_json,
                    media_value(input.media_ru_json.as_deref())?,
                    0,
                    now,
                    id,
                    "en",
                    input.text_en_machine.as_deref().unwrap_or(""),
                    input.text_en_approved,
                    SqlValue::Null,
                    0,
                    now
                ],
            )?;
            Ok(id)
        })
    }

    pub fn get(&self, id: i64) -> Result<Option<DraftRecord>> {
        let row = self
            .sqlite
            .query_row(
                &format!(r#"{SELECT_DRAFTS} where "drafts"."id" = ?"#),
                params!["ru", "en", id],
                projection,
            )
            .optional()?;
        row.map(|row| self.record(row)).transpose()
    }

    pub fn list(&self, actor_ids: &[i64], limit: i64) -> Result<Vec<DraftRecord>> {
        let sql = format!(
            r#"{SELECT_DRAFTS} where {} order by "drafts"."updated_at" desc limit ?"#,
            in_list(r#""drafts"."actor_id""#, actor_ids.len())
        );
        let values = ["ru", "en"]
            .map(|locale| SqlValue::Text(locale.into()))
            .into_iter()
            .chain(integers(actor_ids))
            .chain([SqlValue::Integer(limit)]);
        let rows = self
            .sqlite
            .prepare(&sql)?
            .query_map(params_from_iter(values), projection)?
            .collect::<db::rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(|row| self.record(row)).collect()
    }

    pub fn update(&self, id: i64, patch: &DraftPatch) -> Result<()> {
        self.update_draft(id, patch, None).map(drop)
    }

    /// The patch lands only while the draft still has the status and
    /// `updated_at` the caller read; `false` when it no longer does.
    pub fn update_if_current(
        &self,
        id: i64,
        expected_status: &str,
        expected_updated_at: &str,
        patch: &DraftPatch,
    ) -> Result<bool> {
        self.update_draft(id, patch, Some((expected_status, expected_updated_at)))
    }

    fn update_draft(&self, id: i64, patch: &DraftPatch, expected: Option<(&str, &str)>) -> Result<bool> {
        let now = patch.updated_at.clone().unwrap_or_else(|| stamp(self.clock));
        transaction(self.sqlite, || {
            let mut root = Vec::new();
            if let Some(targets) = &patch.targets_json {
                root.push(("targets_json", SqlValue::Text(targets.clone())));
            }
            root.push(("updated_at", SqlValue::Text(now.clone())));
            let mut values: Vec<SqlValue> = root.iter().map(|(_, value)| value.clone()).collect();
            values.push(SqlValue::Integer(id));
            let condition = match expected {
                Some((status, updated_at)) => {
                    values.push(SqlValue::Text(status.into()));
                    values.push(SqlValue::Text(updated_at.into()));
                    r#"("drafts"."id" = ? and "drafts"."status" = ? and "drafts"."updated_at" = ?)"#
                }
                None => r#""drafts"."id" = ?"#,
            };
            let changed = self
                .sqlite
                .query_row(
                    &format!(
                        r#"update "drafts" set {} where {condition} returning "id""#,
                        assignments(&root)
                    ),
                    params_from_iter(values),
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if changed.is_none() {
                return Ok(false);
            }
            let mut ru = Vec::new();
            if let Some(text) = &patch.text_ru {
                ru.push(("source_text", SqlValue::Text(text.clone())));
            }
            if let Some(entities) = &patch.text_ru_entities_json {
                ru.push(("entities_json", entities.clone().map_or(SqlValue::Null, SqlValue::Text)));
            }
            if let Some(media) = &patch.media_ru_json {
                ru.push(("media_json", media_value(media.as_deref())?));
            }
            let mut en = Vec::new();
            if let Some(text) = &patch.text_en_machine {
                en.push(("source_text", SqlValue::Text(text.clone())));
            }
            if let Some(approved) = &patch.text_en_approved {
                en.push(("approved_text", approved.clone().map_or(SqlValue::Null, SqlValue::Text)));
            }
            if let Some(entities) = &patch.text_en_entities_json {
                en.push(("entities_json", entities.clone().map_or(SqlValue::Null, SqlValue::Text)));
            }
            if let Some(media) = &patch.media_en_json {
                en.push(("media_json", media_value(media.as_deref())?));
            }
            for (locale, mut columns) in [("ru", ru), ("en", en)] {
                if columns.is_empty() {
                    continue;
                }
                columns.push(("updated_at", SqlValue::Text(now.clone())));
                let mut values: Vec<SqlValue> = columns.iter().map(|(_, value)| value.clone()).collect();
                values.push(SqlValue::Integer(id));
                values.push(SqlValue::Text(locale.into()));
                self.sqlite.execute(
                    &format!(
                        r#"update "post_locales" set {} where ("post_locales"."draft_id" = ? and "post_locales"."locale" = ?)"#,
                        assignments(&columns)
                    ),
                    params_from_iter(values),
                )?;
            }
            Ok(true)
        })
    }
}

fn assignments(columns: &[(&str, SqlValue)]) -> String {
    columns
        .iter()
        .map(|(column, _)| format!(r#""{column}" = ?"#))
        .collect::<Vec<_>>()
        .join(", ")
}
