//! Card bindings: which chat message
//! currently *is* a publication's live card, in `interface_bindings`, and the
//! freshness question asked of a tap.

use db::rusqlite::{Connection, OptionalExtension, params};
use domain::application::conversation_flow::PublicationKind;
use serde_json::{Map, Value, json};

use crate::context::Ctx;

const TELEGRAM: &str = "telegram";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub chat_id: i64,
    pub message_id: i64,
}

/// The draft card, with the screen it is currently showing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftCardBinding {
    pub chat_id: i64,
    pub message_id: i64,
    pub view: Option<String>,
}

fn set_binding(
    sqlite: &Connection,
    now: &str,
    entity_type: &str,
    entity_id: i64,
    chat_id: i64,
    message_id: i64,
    state: Option<Map<String, Value>>,
) -> domain::Result<()> {
    let state = state.map(|state| domain::json::stringify_object(&state));
    match state {
        Some(state) => sqlite.execute(
            r#"insert into "interface_bindings" ("interface_id", "entity_type", "entity_id", "conversation_id", "message_id", "state_json", "created_at", "updated_at") values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) on conflict ("interface_bindings"."interface_id", "interface_bindings"."entity_type", "interface_bindings"."entity_id") do update set "conversation_id" = ?4, "message_id" = ?5, "state_json" = ?6, "updated_at" = ?7"#,
            params![TELEGRAM, entity_type, entity_id, chat_id.to_string(), message_id.to_string(), state, now],
        )?,
        None => sqlite.execute(
            r#"insert into "interface_bindings" ("interface_id", "entity_type", "entity_id", "conversation_id", "message_id", "state_json", "created_at", "updated_at") values (?1, ?2, ?3, ?4, ?5, '{}', ?6, ?6) on conflict ("interface_bindings"."interface_id", "interface_bindings"."entity_type", "interface_bindings"."entity_id") do update set "conversation_id" = ?4, "message_id" = ?5, "updated_at" = ?6"#,
            params![TELEGRAM, entity_type, entity_id, chat_id.to_string(), message_id.to_string(), now],
        )?,
    };
    Ok(())
}

/// A stored binding: chat, message and presentation state.
type Stored = (i64, i64, Map<String, Value>);

fn get_binding(sqlite: &Connection, entity_type: &str, entity_id: i64) -> domain::Result<Option<Stored>> {
    let row = sqlite
        .query_row(
            r#"select "conversation_id", "message_id", "state_json" from "interface_bindings" where ("interface_bindings"."interface_id" = ? and "interface_bindings"."entity_type" = ? and "interface_bindings"."entity_id" = ?)"#,
            params![TELEGRAM, entity_type, entity_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .optional()?;
    let Some((chat, message, state)) = row else {
        return Ok(None);
    };
    let number = |text: &str| foundation::js::number(text) as i64;
    let state: Map<String, Value> = serde_json::from_str(&state)?;
    Ok(Some((number(&chat), number(&message), state)))
}

pub fn set_post_card(
    sqlite: &Connection,
    now: &str,
    draft_id: i64,
    chat_id: i64,
    message_id: i64,
    view: Option<&str>,
) -> domain::Result<()> {
    let state = json!({"view": view}).as_object().cloned();
    set_binding(sqlite, now, "draft", draft_id, chat_id, message_id, state)
}

pub fn post_card(sqlite: &Connection, draft_id: i64) -> domain::Result<Option<DraftCardBinding>> {
    Ok(
        get_binding(sqlite, "draft", draft_id)?.map(|(chat_id, message_id, state)| DraftCardBinding {
            chat_id,
            message_id,
            view: state.get("view").and_then(Value::as_str).map(str::to_owned),
        }),
    )
}

/// A progress card is transient delivery UI, bound apart from the draft card.
pub fn set_post_progress_card(
    sqlite: &Connection,
    now: &str,
    draft_id: i64,
    chat_id: i64,
    message_id: i64,
    details: bool,
) -> domain::Result<()> {
    let state = json!({"details": details}).as_object().cloned();
    set_binding(sqlite, now, "post_progress", draft_id, chat_id, message_id, state)
}

pub fn post_progress_card(sqlite: &Connection, draft_id: i64) -> domain::Result<Option<(Binding, bool)>> {
    Ok(
        get_binding(sqlite, "post_progress", draft_id)?.map(|(chat_id, message_id, state)| {
            (
                Binding { chat_id, message_id },
                state.get("details") == Some(&Value::Bool(true)),
            )
        }),
    )
}

pub fn set_video_card(
    sqlite: &Connection,
    now: &str,
    draft_id: i64,
    chat_id: i64,
    message_id: i64,
) -> domain::Result<()> {
    set_binding(sqlite, now, "video_draft", draft_id, chat_id, message_id, None)
}

pub fn video_card(sqlite: &Connection, draft_id: i64) -> domain::Result<Option<Binding>> {
    Ok(get_binding(sqlite, "video_draft", draft_id)?.map(|(chat_id, message_id, _)| Binding { chat_id, message_id }))
}

/// `isSupersededCard`: the tap came from a message that is no longer the
/// publication's card (an unbound publication counts as fresh).
pub fn is_superseded_card(ctx: &Ctx, kind: PublicationKind, draft_id: i64) -> domain::Result<bool> {
    let Some(tapped) = ctx.update.callback_message_id() else {
        return Ok(false);
    };
    let current = match kind {
        PublicationKind::Post => post_card(ctx.db(), draft_id)?.map(|card| card.message_id),
        PublicationKind::Video => video_card(ctx.db(), draft_id)?.map(|card| card.message_id),
    };
    Ok(current.is_some_and(|current| current != tapped))
}
