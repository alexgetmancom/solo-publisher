use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use foundation::errors::StudioError;

use crate::Result;
use crate::application::ports::{
    ClearConversationSession, ConversationSessionKind, ConversationSessionRecord, SaveConversationSession,
};
use crate::json;

/// What a retired or cleared session is reset to; the revision moves on.
const RETIRE: &str = r#"update "conversation_sessions" set "draft_id" = ?, "step" = ?, "data_json" = ?, "control_message_id" = ?, "revision" = "conversation_sessions"."revision" + 1, "active" = ?, "updated_at" = ?, "expires_at" = ? where"#;

/// Durable conversational state shared by every Telegram workflow: one row per
/// actor and workflow kind.
pub struct ConversationSessionStore<'a> {
    sqlite: &'a Connection,
}

impl<'a> ConversationSessionStore<'a> {
    pub fn new(sqlite: &'a Connection) -> Self {
        Self { sqlite }
    }

    pub fn get(&self, actor_id: i64, kind: ConversationSessionKind) -> Result<Option<ConversationSessionRecord>> {
        let row = self
            .sqlite
            .query_row(
                r#"select "actor_id", "kind", "draft_id", "step", "data_json", "control_message_id", "revision", "active", "updated_at", "expires_at" from "conversation_sessions" where ("conversation_sessions"."actor_id" = ? and "conversation_sessions"."kind" = ?)"#,
                params![actor_id, kind.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(4)?,
                        ConversationSessionRecord {
                            actor_id: row.get(0)?,
                            kind,
                            draft_id: row.get(2)?,
                            step: row.get(3)?,
                            data: Default::default(),
                            control_message_id: row.get(5)?,
                            revision: row.get(6)?,
                            active: row.get(7)?,
                            updated_at: row.get(8)?,
                            expires_at: row.get(9)?,
                        },
                    ))
                },
            )
            .optional()?;
        let Some((data, mut record)) = row else { return Ok(None) };
        record.data = serde_json::from_str(&data)?;
        Ok(Some(record))
    }

    /// Writes the session and returns its revision: 1 for a new row, the
    /// stored one plus one — or the stored one with `preserve_revision`. When
    /// `expected_revision` is set and the stored row carries another one, the
    /// write changes nothing and is refused with `action.session-stale`.
    ///
    /// Deliberate deviation from TypeScript (DECISIONS.md): the revision check
    /// is the upsert's own `WHERE` rather than a read before it, so a revision
    /// bumped between the two cannot be overwritten.
    pub fn save(&self, input: &SaveConversationSession) -> Result<i64> {
        let data = json::stringify_object(&input.data);
        let revision = self
            .sqlite
            .query_row(
                r#"insert into "conversation_sessions" ("actor_id", "kind", "draft_id", "step", "data_json", "control_message_id", "revision", "active", "updated_at", "expires_at") values (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9) on conflict ("conversation_sessions"."actor_id", "conversation_sessions"."kind") do update set "draft_id" = ?3, "step" = ?4, "data_json" = ?5, "control_message_id" = ?6, "revision" = case when ?10 then "conversation_sessions"."revision" else "conversation_sessions"."revision" + 1 end, "active" = ?7, "updated_at" = ?8, "expires_at" = ?9 where ?11 is null or "conversation_sessions"."revision" = ?11 returning "revision""#,
                params![
                    input.actor_id,
                    input.kind.as_str(),
                    input.draft_id,
                    input.step,
                    data,
                    input.control_message_id,
                    input.active,
                    input.updated_at,
                    input.expires_at,
                    input.preserve_revision,
                    input.expected_revision
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        revision.ok_or_else(|| StudioError::new("action.session-stale").into())
    }

    /// Clears the session only while it is still at that step, for that draft
    /// and — when given — that revision; `false` when anything moved on (or no
    /// step was named).
    pub fn clear_if_current(&self, input: &ClearConversationSession) -> Result<bool> {
        let Some(step) = input.step.as_deref().filter(|step| !step.is_empty()) else {
            return Ok(false);
        };
        let mut values = retired(&input.updated_at);
        values.extend([
            SqlValue::Integer(input.actor_id),
            SqlValue::Text(input.kind.as_str().into()),
            SqlValue::Text(step.into()),
        ]);
        let mut condition = String::from(
            r#"("conversation_sessions"."actor_id" = ? and "conversation_sessions"."kind" = ? and "conversation_sessions"."step" = ? and "#,
        );
        match input.draft_id {
            None => condition.push_str(r#""conversation_sessions"."draft_id" is null"#),
            Some(draft_id) => {
                condition.push_str(r#""conversation_sessions"."draft_id" = ?"#);
                values.push(SqlValue::Integer(draft_id));
            }
        }
        if let Some(revision) = input.expected_revision {
            condition.push_str(r#" and "conversation_sessions"."revision" = ?"#);
            values.push(SqlValue::Integer(revision));
        }
        condition.push(')');
        let cleared = self
            .sqlite
            .query_row(
                &format!(r#"{RETIRE} {condition} returning "actor_id""#),
                params_from_iter(values),
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(cleared.is_some())
    }

    pub fn retire(&self, actor_id: i64, kind: ConversationSessionKind, updated_at: &str) -> Result<()> {
        let mut values = retired(updated_at);
        values.extend([SqlValue::Integer(actor_id), SqlValue::Text(kind.as_str().into())]);
        self.sqlite.execute(
            &format!(r#"{RETIRE} ("conversation_sessions"."actor_id" = ? and "conversation_sessions"."kind" = ?)"#),
            params_from_iter(values),
        )?;
        Ok(())
    }
}

/// The values of [`RETIRE`]'s assignments.
fn retired(updated_at: &str) -> Vec<SqlValue> {
    vec![
        SqlValue::Null,
        SqlValue::Null,
        SqlValue::Text("{}".into()),
        SqlValue::Null,
        SqlValue::Integer(0),
        SqlValue::Text(updated_at.into()),
        SqlValue::Null,
    ]
}
