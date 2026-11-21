use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, Row, params};

use super::{json_column, stamp, transaction};
use crate::Result;
use content::thread::ThreadPart;

use crate::application::ports::{Clock, NewThreadPart, ThreadEnglish};
use crate::json;

/// The first post of a thread is the draft; stored parts start after it.
const FIRST_STORED_POSITION: i64 = 2;

/// The posts after the first. Positions start at 2 and have no gaps.
pub struct ThreadPartStore<'a> {
    sqlite: &'a Connection,
    clock: &'a dyn Clock,
}

/// A part's JSON arrays as stored: an empty list is NULL.
fn json_list(items: &[serde_json::Map<String, serde_json::Value>]) -> SqlValue {
    if items.is_empty() {
        SqlValue::Null
    } else {
        SqlValue::Text(json::stringify(&serde_json::Value::Array(
            items.iter().cloned().map(serde_json::Value::Object).collect(),
        )))
    }
}

/// A stored part with its JSON columns still text.
struct StoredPart {
    position: i64,
    text_ru: String,
    entities: Option<String>,
    text_en: Option<String>,
    text_en_approved: Option<String>,
    media: Option<String>,
}

fn part(row: &Row<'_>) -> db::rusqlite::Result<StoredPart> {
    Ok(StoredPart {
        position: row.get(1)?,
        text_ru: row.get(2)?,
        entities: row.get(3)?,
        text_en: row.get(4)?,
        text_en_approved: row.get(5)?,
        media: row.get(6)?,
    })
}

impl<'a> ThreadPartStore<'a> {
    pub fn new(sqlite: &'a Connection, clock: &'a dyn Clock) -> Self {
        Self { sqlite, clock }
    }

    pub fn list(&self, draft_id: i64) -> Result<Vec<ThreadPart>> {
        let mut statement = self.sqlite.prepare_cached(
            r#"select "draft_id", "position", "text_ru", "entities_ru_json", "text_en", "text_en_approved", "media_json", "created_at", "updated_at" from "draft_thread_parts" where "draft_thread_parts"."draft_id" = ? order by "draft_thread_parts"."position" asc"#,
        )?;
        let rows = statement
            .query_map([draft_id], part)?
            .collect::<db::rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|part| {
                Ok(ThreadPart {
                    position: part.position,
                    text_ru: part.text_ru,
                    entities_ru: json_column(part.entities)?.unwrap_or_default(),
                    text_en: part.text_en,
                    text_en_approved: part.text_en_approved,
                    media: json_column(part.media)?.unwrap_or_default(),
                })
            })
            .collect()
    }

    fn insert(&self, draft_id: i64, position: i64, part: &NewThreadPart, now: &str) -> Result<()> {
        self.sqlite
            .prepare_cached(
                r#"insert into "draft_thread_parts" ("draft_id", "position", "text_ru", "entities_ru_json", "text_en", "text_en_approved", "media_json", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            )?
            .execute(params![
                draft_id,
                position,
                part.text_ru,
                json_list(&part.entities_ru),
                part.text_en,
                part.text_en_approved,
                json_list(&part.media),
                now,
                now
            ])?;
        Ok(())
    }

    pub fn append(&self, draft_id: i64, part: &NewThreadPart) -> Result<i64> {
        transaction(self.sqlite, || {
            let last: Option<i64> = self.sqlite.query_row(
                r#"select max("position") from "draft_thread_parts" where "draft_thread_parts"."draft_id" = ?"#,
                [draft_id],
                |row| row.get(0),
            )?;
            let position = last.unwrap_or(FIRST_STORED_POSITION - 1) + 1;
            self.insert(draft_id, position, part, &stamp(self.clock))?;
            Ok(position)
        })
    }

    /// Replaces every later post at once: how a long post becomes a thread.
    pub fn replace(&self, draft_id: i64, parts: &[NewThreadPart]) -> Result<()> {
        let now = stamp(self.clock);
        transaction(self.sqlite, || {
            self.sqlite.execute(
                r#"delete from "draft_thread_parts" where "draft_thread_parts"."draft_id" = ?"#,
                [draft_id],
            )?;
            for (index, part) in parts.iter().enumerate() {
                self.insert(draft_id, FIRST_STORED_POSITION + index as i64, part, &now)?;
            }
            Ok(())
        })
    }

    pub fn update(&self, draft_id: i64, position: i64, part: &NewThreadPart) -> Result<bool> {
        let updated = self
            .sqlite
            .query_row(
                r#"update "draft_thread_parts" set "text_ru" = ?, "entities_ru_json" = ?, "text_en" = ?, "text_en_approved" = ?, "media_json" = ?, "updated_at" = ? where ("draft_thread_parts"."draft_id" = ? and "draft_thread_parts"."position" = ?) returning "position""#,
                params![
                    part.text_ru,
                    json_list(&part.entities_ru),
                    part.text_en,
                    part.text_en_approved,
                    json_list(&part.media),
                    stamp(self.clock),
                    draft_id,
                    position
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(updated.is_some())
    }

    pub fn remove(&self, draft_id: i64, position: i64) -> Result<bool> {
        let now = stamp(self.clock);
        transaction(self.sqlite, || {
            let removed = self
                .sqlite
                .query_row(
                    r#"delete from "draft_thread_parts" where ("draft_thread_parts"."draft_id" = ? and "draft_thread_parts"."position" = ?) returning "position""#,
                    [draft_id, position],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if removed.is_none() {
                return Ok(false);
            }
            // Ascending, one at a time: shifting every row at once would
            // collide on the primary key while the statement runs.
            let later = self
                .sqlite
                .prepare(
                    r#"select "position" from "draft_thread_parts" where ("draft_thread_parts"."draft_id" = ? and "draft_thread_parts"."position" > ?) order by "draft_thread_parts"."position" asc"#,
                )?
                .query_map([draft_id, position], |row| row.get::<_, i64>(0))?
                .collect::<db::rusqlite::Result<Vec<_>>>()?;
            for later in later {
                self.sqlite.execute(
                    r#"update "draft_thread_parts" set "position" = ?, "updated_at" = ? where ("draft_thread_parts"."draft_id" = ? and "draft_thread_parts"."position" = ?)"#,
                    params![later - 1, now, draft_id, later],
                )?;
            }
            Ok(true)
        })
    }

    /// English written by the author for one post, which no translation replaces.
    pub fn approve_english(&self, draft_id: i64, position: i64, text_en: &str) -> Result<bool> {
        let updated = self
            .sqlite
            .query_row(
                r#"update "draft_thread_parts" set "text_en_approved" = ?, "updated_at" = ? where ("draft_thread_parts"."draft_id" = ? and "draft_thread_parts"."position" = ?) returning "position""#,
                params![text_en, stamp(self.clock), draft_id, position],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(updated.is_some())
    }

    pub fn set_english(&self, draft_id: i64, texts: &[ThreadEnglish]) -> Result<()> {
        let now = stamp(self.clock);
        transaction(self.sqlite, || {
            for text in texts {
                self.sqlite.execute(
                    r#"update "draft_thread_parts" set "text_en" = ?, "updated_at" = ? where ("draft_thread_parts"."draft_id" = ? and "draft_thread_parts"."position" = ?)"#,
                    params![text.text_en, now, draft_id, text.position],
                )?;
            }
            Ok(())
        })
    }
}
