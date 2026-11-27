//! The album collector: Telegram delivers an
//! album as separate messages; each one is appended to a `pending_albums` row,
//! and once the group has been quiet for the settle window the
//! `telegram-albums` worker turns the row into one draft (or one edit, or one
//! thread part) and sends its card.
//!
//! `pending_albums.notified` lifecycle: an album is SETTLED once its caption
//! and media are collected, then CLAIMED by exactly one worker pass before
//! finalization.

use content::Locale;
use content::message::{DraftMessage, Entity, MediaItem};
use db::rusqlite::{Connection, OptionalExtension, params};
use domain::application::conversation_flow::PublicationKind;
use domain::application::ports::{ConversationSessionKind, JsonObject, NewThreadPart};
use domain::studio::services::posts::EditInput;
use foundation::i18n::{Key, t};
use foundation::logger::{LogLevel, log};
use foundation::time::to_iso_string;
use jiff::{SignedDuration, Timestamp};
use serde_json::{Value, json};

use crate::api::payload::{InlineKeyboard, Payload};
use crate::bot::Bot;
use crate::callback::publication_callback;
use crate::cards::set_post_card;
use crate::context::Ctx;
use crate::media_ingress::import_telegram_media;
use crate::publication::{CardRequest, render_card};

/// How long an album is left to arrive in full before it is treated as complete.
const SETTLE: SignedDuration = SignedDuration::from_secs(4);
const ALBUM_SETTLED: i64 = 1;
const ALBUM_CLAIMED: i64 = 2;
/// A claim is durable so a crash cannot lose the album, but it has a lease so
/// a claim abandoned mid-import is picked up by a later pass.
const CLAIM_LEASE: SignedDuration = SignedDuration::from_mins(10);
/// A failed finalization goes back to SETTLED and is retried once per settle
/// window; deterministic failures (an expired file_id, a draft deleted
/// mid-flight) give up after this many tries and tell the sender.
const MAX_ATTEMPTS: i64 = 5;
/// One pass imports media per album, so a backlog is worked off over several
/// passes instead of holding claims past their lease.
const FINALIZE_BATCH: i64 = 20;

/// One album message, and the open post step it arrived into, if any.
pub struct PendingAlbumInput<'a> {
    pub actor_id: i64,
    pub chat_id: i64,
    pub media_group_id: &'a str,
    pub text: &'a str,
    pub entities: &'a [Entity],
    pub media: &'a MediaItem,
    /// The open post step's name (`edit_text`, `thread_part`, …).
    pub step: Option<&'a str>,
    /// That step's `postStepData`.
    pub step_data: &'a JsonObject,
    pub draft_id: Option<i64>,
    pub state_revision: Option<i64>,
}

fn record_array(json: Option<&str>) -> Vec<Value> {
    match json.and_then(|json| serde_json::from_str::<Value>(json).ok()) {
        Some(Value::Array(items)) => items.into_iter().filter(Value::is_object).collect(),
        _ => Vec::new(),
    }
}

fn objects(items: Vec<Value>) -> Vec<JsonObject> {
    items
        .into_iter()
        .filter_map(|item| match item {
            Value::Object(object) => Some(object),
            _ => None,
        })
        .collect()
}

/// `appendPendingAlbum`: adds one album item; true when it started the album.
/// Album items arrive as separate updates, so the read-modify-write of the
/// media list is one transaction.
pub fn append_pending_album(sqlite: &Connection, now: Timestamp, input: &PendingAlbumInput<'_>) -> crate::Result<bool> {
    let id = format!(
        "{}:{}:{}:{}:{}",
        input.actor_id,
        input.chat_id,
        input.media_group_id,
        input.step.unwrap_or("draft"),
        input.draft_id.map(|id| id.to_string()).unwrap_or_default()
    );
    let transaction = sqlite.unchecked_transaction()?;
    let row: Option<(String, String, Option<String>)> = transaction
        .query_row(
            r#"select "media_json", "text_ru", "text_entities_json" from "pending_albums" where "pending_albums"."id" = ?"#,
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let mut media = record_array(row.as_ref().map(|(media, _, _)| media.as_str()));
    media.push(Value::Object(input.media.clone()));
    let text_ru = match (input.text, &row) {
        ("", Some((_, stored, _))) => stored.clone(),
        (text, _) => text.to_owned(),
    };
    let entities = if input.entities.is_empty() {
        record_array(row.as_ref().and_then(|(_, _, entities)| entities.as_deref()))
    } else {
        input.entities.iter().cloned().map(Value::Object).collect()
    };
    let now = to_iso_string(now);
    transaction.execute(
        r#"insert into "pending_albums" ("id", "actor_id", "chat_id", "media_group_id", "step", "step_data_json", "draft_id", "state_revision", "text_ru", "text_entities_json", "media_json", "notified", "updated_at") values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) on conflict ("pending_albums"."id") do update set "step" = ?5, "step_data_json" = ?6, "text_ru" = ?9, "text_entities_json" = ?10, "media_json" = ?11, "notified" = ?12, "updated_at" = ?13"#,
        params![
            id,
            input.actor_id,
            input.chat_id,
            input.media_group_id,
            input.step,
            domain::json::stringify_object(input.step_data),
            input.draft_id,
            input.state_revision,
            text_ru,
            domain::json::stringify(&Value::Array(entities)),
            domain::json::stringify(&Value::Array(media)),
            ALBUM_SETTLED,
            now,
        ],
    )?;
    transaction.commit()?;
    Ok(row.is_none())
}

struct PendingAlbum {
    id: String,
    actor_id: i64,
    chat_id: i64,
    step: Option<String>,
    step_data: JsonObject,
    draft_id: Option<i64>,
    state_revision: Option<i64>,
    attempt_count: i64,
    text_ru: String,
    text_entities: Vec<Entity>,
    media: Vec<MediaItem>,
}

/// What a finished album leaves to show: the draft whose card to send, and
/// whether it was a thread step.
struct Finalized {
    draft_id: i64,
    thread_step: Option<String>,
}

/// `finalizePendingAlbums`: one worker pass; how many albums it completed.
pub async fn finalize_pending_albums(bot: &Bot) -> crate::Result<usize> {
    let ctx = Ctx::worker(bot);
    let sqlite = ctx.db();
    let now = ctx.now();
    let now_iso = to_iso_string(now);
    // Recover claims left behind by a crashed worker. `updated_at` stays, so
    // the row can be selected in this same pass if its window has elapsed.
    sqlite.execute(
        r#"update "pending_albums" set "notified" = ?1 where ("pending_albums"."notified" = ?2 and "pending_albums"."updated_at" <= ?3)"#,
        params![ALBUM_SETTLED, ALBUM_CLAIMED, to_iso_string(now - CLAIM_LEASE)],
    )?;
    let cutoff = to_iso_string(now - SETTLE);
    let rows = {
        let mut statement = sqlite.prepare(
            r#"select "id", "actor_id", "chat_id", "step", "step_data_json", "draft_id", "state_revision", "attempt_count", "text_ru", "text_entities_json", "media_json" from "pending_albums" where ("pending_albums"."notified" = ?1 and "pending_albums"."updated_at" <= ?2) order by "pending_albums"."updated_at" asc limit ?3"#,
        )?;
        statement
            .query_map(params![ALBUM_SETTLED, cutoff, FINALIZE_BATCH], |row| {
                let step_data: String = row.get(4)?;
                let entities: Option<String> = row.get(9)?;
                let media: String = row.get(10)?;
                Ok(PendingAlbum {
                    id: row.get(0)?,
                    actor_id: row.get(1)?,
                    chat_id: row.get(2)?,
                    step: row.get(3)?,
                    step_data: serde_json::from_str(&step_data).unwrap_or_default(),
                    draft_id: row.get(5)?,
                    state_revision: row.get(6)?,
                    attempt_count: row.get(7)?,
                    text_ru: row.get(8)?,
                    text_entities: objects(record_array(entities.as_deref())),
                    media: objects(record_array(Some(&media))),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut completed = 0;
    for row in rows {
        // The attempt is counted when the claim is taken, not when it fails:
        // a crash mid-import would otherwise return the row unchanged forever.
        let attempts = row.attempt_count + 1;
        let claimed = sqlite.execute(
            r#"update "pending_albums" set "notified" = ?1, "attempt_count" = ?2, "updated_at" = ?3 where ("pending_albums"."id" = ?4 and "pending_albums"."notified" = ?5 and "pending_albums"."updated_at" <= ?6)"#,
            params![ALBUM_CLAIMED, attempts, now_iso, row.id, ALBUM_SETTLED, cutoff],
        )?;
        if claimed == 0 {
            continue;
        }
        if attempts > MAX_ATTEMPTS {
            give_up(&ctx, &row).await?;
            log(
                LogLevel::Error,
                "album finalization failed",
                Some(
                    json!({"album": row.id, "attempts": attempts, "exhausted": true, "error": "claim attempts exhausted"}),
                ),
            );
            continue;
        }
        let finalized = match finalize(&ctx, &row).await {
            Ok(Some(finalized)) => {
                completed += delete_claimed(sqlite, &row.id)?;
                Some(finalized)
            }
            Ok(None) => continue,
            Err(error) => {
                let exhausted = attempts >= MAX_ATTEMPTS;
                if exhausted {
                    give_up(&ctx, &row).await?;
                } else {
                    sqlite.execute(
                        r#"update "pending_albums" set "notified" = ?1, "updated_at" = ?2 where ("pending_albums"."id" = ?3 and "pending_albums"."notified" = ?4)"#,
                        params![ALBUM_SETTLED, to_iso_string(ctx.now()), row.id, ALBUM_CLAIMED],
                    )?;
                }
                log(
                    if exhausted { LogLevel::Error } else { LogLevel::Warn },
                    "album finalization failed",
                    Some(json!({
                        "album": row.id,
                        "attempts": attempts,
                        "exhausted": exhausted,
                        "error": crate::effects::error_js_string(&*error),
                    })),
                );
                None
            }
        };
        // The draft exists and the row is gone: the card is presentation, and
        // a Telegram failure here must never replay finalization into a second draft.
        if let Some(finalized) = finalized
            && let Err(error) = send_card(&ctx, &row, &finalized).await
        {
            log(
                LogLevel::Warn,
                "album control card failed",
                Some(json!({"album": row.id, "draftId": finalized.draft_id, "error": error.to_string()})),
            );
        }
    }
    Ok(completed)
}

fn delete_claimed(sqlite: &Connection, id: &str) -> crate::Result<usize> {
    Ok(sqlite.execute(
        r#"delete from "pending_albums" where ("pending_albums"."id" = ?1 and "pending_albums"."notified" = ?2)"#,
        params![id, ALBUM_CLAIMED],
    )?)
}

fn locale_of(value: Option<&Value>) -> Option<Locale> {
    match value.and_then(Value::as_str) {
        Some("ru") => Some(Locale::Ru),
        Some("en") => Some(Locale::En),
        _ => None,
    }
}

/// Turns one claimed album into what it was sent for; `None` when the post
/// step it was sent into has moved on (the album is discarded).
async fn finalize(ctx: &Ctx, row: &PendingAlbum) -> crate::Result<Option<Finalized>> {
    let sessions = ctx.sessions();
    let state = sessions.get(row.actor_id, ConversationSessionKind::Post)?;
    if row.state_revision.is_some() && state.as_ref().map(|state| state.revision) != row.state_revision {
        delete_claimed(ctx.db(), &row.id)?;
        log(
            LogLevel::Warn,
            "stale album discarded",
            Some(json!({"album": row.id, "actorId": row.actor_id, "stateRevision": row.state_revision})),
        );
        return Ok(None);
    }
    let services = ctx.services();
    let media = import_telegram_media(ctx.bot.api(), services.media, &ctx.config, row.actor_id, &row.media).await?;
    let step = row.step.as_deref();
    let locale = locale_of(row.step_data.get("locale"))
        .or_else(|| locale_of(state.as_ref().and_then(|state| state.data.get("locale"))));
    let clear = |step: &str, draft_id: Option<i64>| {
        sessions.clear_if_current(
            row.actor_id,
            ConversationSessionKind::Post,
            step,
            draft_id,
            row.state_revision,
        )
    };
    // An album sent into an open edit is that language's new media, and its
    // caption -- if it has one -- that language's new text. An album with no
    // caption leaves the text alone, because empty copy is not an edit.
    if let (Some("edit_text"), Some(locale), Some(draft_id)) = (step, locale, row.draft_id) {
        services.posts.edit(
            row.actor_id,
            draft_id,
            &EditInput {
                locale,
                text: row.text_ru.clone(),
                entities: row.text_entities.clone(),
                media,
                replace_media_only: false,
                clear_media: false,
            },
        )?;
        clear("edit_text", Some(draft_id))?;
        return Ok(Some(Finalized {
            draft_id,
            thread_step: None,
        }));
    }
    if let (Some(thread_step @ ("thread_part" | "thread_edit")), Some(draft_id)) = (step, row.draft_id) {
        // An album is one post of the thread: its caption the text, its
        // photos that post's media.
        let part = NewThreadPart {
            text_ru: row.text_ru.clone(),
            entities_ru: row.text_entities.clone(),
            media,
            text_en: None,
            text_en_approved: None,
        };
        let position = row
            .step_data
            .get("position")
            .and_then(|value| value.as_i64().or_else(|| value.as_str()?.trim().parse().ok()))
            .unwrap_or(0);
        if thread_step == "thread_edit" && locale == Some(Locale::En) {
            services
                .posts
                .edit_thread_part_english(row.actor_id, draft_id, position, &row.text_ru)?;
        } else if thread_step == "thread_edit" {
            services
                .posts
                .edit_thread_part(row.actor_id, draft_id, position, &part)?;
        } else {
            services.posts.append_thread_part(row.actor_id, draft_id, &part)?;
        }
        clear(thread_step, Some(draft_id))?;
        return Ok(Some(Finalized {
            draft_id,
            thread_step: Some(thread_step.to_owned()),
        }));
    }
    let draft_id = services.posts.create(
        row.actor_id,
        &DraftMessage {
            text: row.text_ru.clone(),
            media,
            entities: row.text_entities.clone(),
            ..DraftMessage::default()
        },
        None,
    )?;
    if let Some(step) = step {
        clear(step, row.draft_id)?;
    }
    Ok(Some(Finalized {
        draft_id,
        thread_step: None,
    }))
}

/// Last word on an album that will never become a draft. Best-effort: a
/// failed notice must not resurrect the row just dropped.
async fn give_up(ctx: &Ctx, row: &PendingAlbum) -> crate::Result<()> {
    ctx.db().execute(
        r#"delete from "pending_albums" where "pending_albums"."id" = ?"#,
        [&row.id],
    )?;
    if let Err(error) = ctx
        .bot
        .api()
        .send_message(row.chat_id, &t(Key::PostAlbumFailed, &[]), Payload::new())
        .await
    {
        log(
            LogLevel::Warn,
            "album give-up notice failed",
            Some(json!({"chat": row.chat_id, "error": error.js_string()})),
        );
    }
    Ok(())
}

/// What a finished thread step shows (`threadPartScreen`): after a rewrite
/// the thread review card; after an added part, the add-or-finish question.
pub struct ThreadPartScreen {
    pub text: String,
    pub keyboard: InlineKeyboard,
    pub markdown: bool,
    pub view: Option<String>,
}

/// `threadPartScreen`.
pub fn thread_part_screen(ctx: &Ctx, actor_id: i64, draft_id: i64, step: &str) -> crate::Result<ThreadPartScreen> {
    if step == "thread_edit" {
        let view = "thread".to_owned();
        let card = render_card(
            ctx,
            PublicationKind::Post,
            &CardRequest {
                actor_id,
                publication_id: draft_id,
                view: Some(view.clone()),
                ..CardRequest::default()
            },
        )?;
        return Ok(ThreadPartScreen {
            text: card.text,
            keyboard: card.keyboard,
            markdown: true,
            view: Some(view),
        });
    }
    let parts = ctx.services().posts.get(actor_id, draft_id)?.thread.len() + 1;
    Ok(ThreadPartScreen {
        text: t(Key::ActionThreadPartAdded, &[("parts", &parts)]),
        keyboard: InlineKeyboard::new()
            .text(
                t(Key::ActionThreadMore, &[]),
                publication_callback(PublicationKind::Post, "thread_add", &[&draft_id], None)?,
            )
            .text(
                t(Key::ActionThreadDone, &[]),
                publication_callback(PublicationKind::Post, "thread_done", &[&draft_id], None)?,
            ),
        markdown: false,
        view: None,
    })
}

/// `refreshDraftControlCard`: a completed chat edit gets a fresh card at the
/// bottom; previous cards are history, never a moving prompt above the reply.
async fn send_card(ctx: &Ctx, row: &PendingAlbum, finalized: &Finalized) -> crate::Result<()> {
    let screen = match finalized.thread_step.as_deref() {
        Some(step) => thread_part_screen(ctx, row.actor_id, finalized.draft_id, step)?,
        None => {
            let card = render_card(
                ctx,
                PublicationKind::Post,
                &CardRequest {
                    actor_id: row.actor_id,
                    publication_id: finalized.draft_id,
                    ..CardRequest::default()
                },
            )?;
            ThreadPartScreen {
                text: card.text,
                keyboard: card.keyboard,
                markdown: true,
                view: card.view,
            }
        }
    };
    let mut options = Payload::new();
    if screen.markdown {
        options = options.markdown();
    }
    let control = ctx
        .bot
        .api()
        .send_message(row.chat_id, &screen.text, options.reply_markup(screen.keyboard))
        .await?;
    // The add-or-finish question is not the card (see `threadPartSaved`).
    if finalized.thread_step.as_deref() != Some("thread_part") {
        set_post_card(
            ctx.db(),
            &to_iso_string(ctx.now()),
            finalized.draft_id,
            row.chat_id,
            control.message_id,
            screen.view.as_deref(),
        )?;
    }
    Ok(())
}
