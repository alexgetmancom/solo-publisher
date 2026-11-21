//! Effects and the screen anchor (`bot/effects.ts`, spec §1.7–1.8).
//!
//! Handlers return an ordered list of effects; one executor runs them, so
//! "edit the tapped message or send a new one" is answered in one place: the
//! first screen of an update edits the tapped message, everything after it
//! arrives below.

use std::path::PathBuf;

use domain::application::ports::ConversationSessionKind;
use foundation::logger::{LogLevel, log};
use serde_json::json;

use crate::Fut;
use crate::api::payload::{Field, InlineKeyboard, InputFile, Payload};
use crate::api::{FileSource, is_unchanged_message_edit};
use crate::cards;
use crate::context::Ctx;
use crate::screens::entry::MAIN_MENU;
use crate::session::ConversationStateInput;

/// The card a rendered screen becomes the live message of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CardRef {
    Post { draft_id: i64, view: Option<String> },
    PostProgress { draft_id: i64, details: bool },
    Video { draft_id: i64 },
}

/// Output an area produces itself after the anchor is spent (the delivery
/// previews): it always lands below what the update already showed.
pub type Below = Box<dyn for<'a> FnOnce(&'a Ctx) -> Fut<'a, crate::Result<()>>>;

pub enum Effect {
    /// `answer-callback`: with a text, a chat message; without, nothing.
    AnswerCallback {
        text: Option<String>,
        show_alert: bool,
    },
    /// `toast`: always a chat message.
    Toast {
        text: String,
        show_alert: bool,
    },
    /// The answer to what the operator just did: over the tapped message when
    /// it is still the last thing this update wrote, else a new message.
    Screen {
        text: String,
        options: Payload,
        card: Option<CardRef>,
    },
    /// Always a new message.
    Message {
        text: String,
        options: Payload,
        card: Option<CardRef>,
    },
    EditReplyMarkup {
        keyboard: InlineKeyboard,
    },
    Photo {
        path: PathBuf,
        options: Payload,
        card: Option<CardRef>,
    },
    Below(Below),
    /// The main menu as a screen, with this headline.
    MainMenu {
        text: String,
    },
    SessionClear {
        kind: ConversationSessionKind,
        actor_id: i64,
    },
    SessionSave {
        actor_id: i64,
        state: ConversationStateInput,
    },
}

impl Effect {
    pub fn toast(text: impl Into<String>) -> Self {
        Self::Toast {
            text: text.into(),
            show_alert: false,
        }
    }

    pub fn answer(text: impl Into<String>) -> Self {
        Self::AnswerCallback {
            text: Some(text.into()),
            show_alert: false,
        }
    }

    pub fn screen(text: impl Into<String>, options: Payload) -> Self {
        Self::Screen {
            text: text.into(),
            options,
            card: None,
        }
    }

    pub fn message(text: impl Into<String>, options: Payload) -> Self {
        Self::Message {
            text: text.into(),
            options,
            card: None,
        }
    }

    pub(crate) fn is_answer(&self) -> bool {
        matches!(self, Self::AnswerCallback { .. } | Self::Toast { .. })
    }
}

/// `executePublicationEffects`.
pub async fn execute(ctx: &Ctx, effects: Vec<Effect>) -> crate::Result<()> {
    let mut anchor = ScreenAnchor::new(ctx);
    for effect in effects {
        match effect {
            Effect::AnswerCallback { text, show_alert } => {
                ctx.answer_callback_query(text.as_deref().filter(|text| !text.is_empty()), show_alert)
                    .await?;
            }
            Effect::Toast { text, show_alert } => ctx.answer_callback_query(Some(&text), show_alert).await?,
            Effect::Screen { text, options, card } => {
                if let Some(message_id) = anchor.render(true, &text, options).await? {
                    bind_card(ctx, card.as_ref(), message_id)?;
                }
            }
            Effect::Message { text, options, card } => {
                if let Some(message_id) = anchor.render(false, &text, options).await? {
                    bind_card(ctx, card.as_ref(), message_id)?;
                }
            }
            Effect::EditReplyMarkup { keyboard } => {
                ctx.edit_message_reply_markup(Payload::new().reply_markup(keyboard))
                    .await?;
            }
            Effect::Photo { path, options, card } => {
                anchor.spend();
                let message = ctx
                    .reply_with_file("sendPhoto", "photo", FileSource::Upload(InputFile::Path(path)), options)
                    .await?;
                bind_card(ctx, card.as_ref(), message.message_id)?;
            }
            Effect::Below(run) => {
                anchor.spend();
                run(ctx).await?;
            }
            Effect::MainMenu { text } => {
                anchor
                    .render(true, &text, Payload::new().reply_markup(Field::Menu(MAIN_MENU)))
                    .await?;
            }
            Effect::SessionClear { kind, actor_id } => ctx.sessions().clear(actor_id, kind)?,
            Effect::SessionSave { actor_id, state } => {
                ctx.sessions().save(actor_id, &state)?;
            }
        }
    }
    Ok(())
}

/// `showScreen`: one screen through a fresh anchor.
pub async fn show_screen(ctx: &Ctx, text: &str, options: Payload) -> crate::Result<()> {
    ScreenAnchor::new(ctx).render(true, text, options).await?;
    Ok(())
}

/// `showMessage`: a notice that must not replace the screen it was asked from.
pub async fn show_message(ctx: &Ctx, text: &str, options: Payload) -> crate::Result<()> {
    ScreenAnchor::new(ctx).render(false, text, options).await?;
    Ok(())
}

/// `replySafely`: a callback result that cannot be sent is only logged.
pub(crate) async fn reply_safely(ctx: &Ctx, text: &str) {
    if let Err(error) = show_message(ctx, text, Payload::new()).await {
        log(
            LogLevel::Warn,
            "Failed to send Telegram callback result",
            Some(json!({"error": error.to_string()})),
        );
    }
}

/// Where one update writes: over the tapped message while it is still the
/// last thing in the chat, below it once anything else has been sent.
pub struct ScreenAnchor<'a> {
    ctx: &'a Ctx,
    message_id: Option<i64>,
}

impl<'a> ScreenAnchor<'a> {
    pub fn new(ctx: &'a Ctx) -> Self {
        Self {
            ctx,
            message_id: ctx.update.callback_message_id(),
        }
    }

    /// The tapped message is no longer the last one in the chat.
    pub fn spend(&mut self) {
        self.message_id = None;
    }

    /// Renders one screen and returns the message it now lives on.
    pub async fn render(&mut self, over_anchor: bool, text: &str, options: Payload) -> crate::Result<Option<i64>> {
        if over_anchor && let Some(anchored) = self.message_id {
            match self.ctx.edit_message_text(text, options.clone()).await {
                Ok(_) => {
                    self.spend();
                    return Ok(Some(anchored));
                }
                Err(error) if is_unchanged_message_edit(&*error) => {
                    self.spend();
                    return Ok(Some(anchored));
                }
                Err(error) => log(
                    LogLevel::Warn,
                    "screen could not be edited in place",
                    Some(json!({"messageId": anchored, "error": error_js_string(&*error)})),
                ),
            }
        }
        self.spend();
        let message = self.ctx.reply(text, options).await?;
        Ok(Some(message.message_id))
    }
}

/// `String(error)` for a log line.
pub fn error_js_string(error: &(dyn std::error::Error + 'static)) -> String {
    match error.downcast_ref::<crate::api::ApiError>() {
        Some(api) => api.js_string(),
        None => format!("Error: {error}"),
    }
}

fn bind_card(ctx: &Ctx, card: Option<&CardRef>, message_id: i64) -> crate::Result<()> {
    let (Some(card), Some(chat_id)) = (card, ctx.chat_id()) else {
        return Ok(());
    };
    let now = foundation::time::to_iso_string(ctx.now());
    match card {
        CardRef::Post { draft_id, view } => {
            cards::set_post_card(ctx.db(), &now, *draft_id, chat_id, message_id, view.as_deref())?
        }
        CardRef::PostProgress { draft_id, details } => {
            cards::set_post_progress_card(ctx.db(), &now, *draft_id, chat_id, message_id, *details)?
        }
        CardRef::Video { draft_id } => cards::set_video_card(ctx.db(), &now, *draft_id, chat_id, message_id)?,
    }
    Ok(())
}
