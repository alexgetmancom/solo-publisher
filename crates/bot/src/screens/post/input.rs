//! A message answering an open post step: the step
//! takes it, the dialog advances one revision, and the operator sees what came of it.

use content::Locale;
use content::message::DraftMessage;
use domain::application::conversation_flow::PublicationKind;
use domain::application::ports::{ConversationSessionKind, JsonObject, NewThreadPart};
use domain::studio::services::posts::{EditInput, PostScheduleScope};
use foundation::errors::StudioError;
use foundation::i18n::{Key, t};
use foundation::time::{Zone, format_zoned_date_time, to_iso_string};
use serde_json::Value;

use crate::api::payload::Payload;
use crate::callback::publication_callback;
use crate::context::Ctx;
use crate::dialog_ui::{DialogButton, confirmation_keyboard};
use crate::effects::{CardRef, Effect};
use crate::media_ingress::import_telegram_media;
use crate::message::extract_message;
use crate::publication::scheduling::{ScheduleConfirmation, ScheduleEngine, schedule_confirmation_effects};
use crate::publication::{advance_flow, card_effect, delivery_previews};
use crate::session::ConversationState;

use super::flow::{PostWizardStep, post_state_step};
use super::preview::post_preview_card;

pub fn scope(locale: Locale) -> PostScheduleScope {
    match locale {
        Locale::Ru => PostScheduleScope::Ru,
        Locale::En => PostScheduleScope::En,
    }
}

fn session_stale() -> crate::Error {
    StudioError::new("action.session-stale").into()
}

/// `applyAdminState`.
pub async fn apply_admin_state(
    ctx: &Ctx,
    step: PostWizardStep,
    draft_id: i64,
    expected_revision: Option<i64>,
) -> crate::Result<Vec<Effect>> {
    let actor_id = ctx.actor_id();
    let mut message = extract_message(ctx);
    if !message.media.is_empty() {
        let services = ctx.services();
        message.media =
            import_telegram_media(ctx.bot.api(), services.media, &ctx.config, actor_id, &message.media).await?;
    }
    let session = ctx
        .sessions()
        .require(actor_id, ConversationSessionKind::Post, expected_revision)?;
    let data = accept(ctx, actor_id, draft_id, step, &message, session.data.clone())?;
    let saved = advance_flow(ctx, actor_id, &session, Some(step.next()), data, "action.session-stale")?;
    if saved.step == "schedule_confirm" {
        return render_post_schedule_confirmation(ctx, actor_id, draft_id, &saved);
    }
    let clear = Effect::SessionClear {
        kind: ConversationSessionKind::Post,
        actor_id,
    };
    if matches!(step, PostWizardStep::ThreadPart | PostWizardStep::ThreadEdit { .. }) {
        let mut effects = vec![clear];
        effects.extend(thread_part_saved(ctx, actor_id, draft_id, step.name())?);
        return Ok(effects);
    }
    let mut effects = vec![clear];
    effects.extend(card_effect(post_preview_card(ctx, actor_id, draft_id, None)?));
    Ok(effects)
}

/// The step's `accept`: the new session data, or the refusal.
fn accept(
    ctx: &Ctx,
    actor_id: i64,
    draft_id: i64,
    step: PostWizardStep,
    message: &DraftMessage,
    mut data: JsonObject,
) -> crate::Result<JsonObject> {
    let services = ctx.services();
    let posts = &services.posts;
    match step {
        PostWizardStep::EditText { locale } => {
            posts.edit(
                actor_id,
                draft_id,
                &EditInput {
                    locale,
                    text: message.text.clone(),
                    entities: message.entities.clone(),
                    media: message.media.clone(),
                    replace_media_only: false,
                    clear_media: is_clear_media_command(&message.text),
                },
            )?;
            data.insert("input".into(), message_value(message));
            Ok(data)
        }
        PostWizardStep::ScheduleManual { locale } => {
            let schedule = posts.manual_schedule(actor_id, draft_id, scope(locale), &message.text)?;
            let value = match locale {
                Locale::Ru => schedule.ru_at,
                Locale::En => schedule.en_at,
            }
            .ok_or_else(|| crate::Error::from(StudioError::new("err.no-pub-time")))?;
            data.insert("locale".into(), locale.as_str().into());
            data.insert("value".into(), to_iso_string(value).into());
            Ok(data)
        }
        PostWizardStep::ThreadPart | PostWizardStep::ThreadEdit { .. } => {
            let part = NewThreadPart {
                text_ru: message.text.clone(),
                entities_ru: message.entities.clone(),
                media: message.media.clone(),
                text_en: None,
                text_en_approved: None,
            };
            match step {
                PostWizardStep::ThreadPart => {
                    posts.append_thread_part(actor_id, draft_id, &part)?;
                }
                // English is written over the post it belongs to and nothing
                // else: its media is the post's, in whatever language it is read.
                PostWizardStep::ThreadEdit {
                    position,
                    locale: Locale::En,
                } => posts.edit_thread_part_english(actor_id, draft_id, position, &message.text)?,
                PostWizardStep::ThreadEdit { position, .. } => {
                    posts.edit_thread_part(actor_id, draft_id, position, &part)?
                }
                _ => unreachable!("matched above"),
            }
            Ok(data)
        }
        PostWizardStep::ScheduleConfirm { .. } => Err(session_stale()),
    }
}

/// The message as the session keeps it (`{ text, media, entities }`).
fn message_value(message: &DraftMessage) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("text".into(), message.text.clone().into());
    object.insert(
        "media".into(),
        Value::Array(message.media.iter().cloned().map(Value::Object).collect()),
    );
    object.insert(
        "entities".into(),
        Value::Array(message.entities.iter().cloned().map(Value::Object).collect()),
    );
    Value::Object(object)
}

fn is_clear_media_command(text: &str) -> bool {
    let clean = foundation::js::trim(text).to_lowercase();
    matches!(clean.as_str(), "/delmedia" | "очистить" | "без медиа" | "clear media")
}

/// After a new post of the thread: write another, or finish. After a
/// rewrite: straight back to the review it came from.
fn thread_part_saved(ctx: &Ctx, actor_id: i64, draft_id: i64, step: &str) -> crate::Result<Vec<Effect>> {
    let screen = crate::albums::thread_part_screen(ctx, actor_id, draft_id, step)?;
    let mut options = Payload::new();
    if screen.markdown {
        options = options.markdown();
    }
    let options = options.reply_markup(screen.keyboard);
    // The add-or-finish question is not the card: the card is repainted when
    // the English arrives, and that repaint took these buttons away.
    let card = (step != "thread_part").then(|| CardRef::Post {
        draft_id,
        view: screen.view.clone(),
    });
    Ok(vec![Effect::Screen {
        text: screen.text,
        options,
        card,
    }])
}

fn render_post_schedule_confirmation(
    ctx: &Ctx,
    actor_id: i64,
    draft_id: i64,
    state: &ConversationState,
) -> crate::Result<Vec<Effect>> {
    let Some(PostWizardStep::ScheduleConfirm { locale, value }) = post_state_step(Some(&ConversationState {
        step: "schedule_confirm".into(),
        ..state.clone()
    })) else {
        return Err(StudioError::new("action.schedule-expired").into());
    };
    let services = ctx.services();
    let time_config = services.settings.time_config(actor_id)?;
    let zone = Zone::parse(&time_config.timezone)
        .ok_or_else(|| crate::error(format!("Invalid time zone specified: {}", time_config.timezone)))?;
    let card = post_preview_card(ctx, actor_id, draft_id, None)?;
    let key = locale.as_str();
    let engine = ScheduleEngine {
        kind: PublicationKind::Post,
        publication_id: draft_id,
        axis_keys: &[key],
        slot_values: &[],
    };
    let back_view = if locale == Locale::Ru { "schedule_ru" } else { "schedule_en" };
    let (confirm_label, back_label) = (t(Key::PostConfirmScheduleBtn, &[]), t(Key::CommonBack, &[]));
    let confirm = engine.confirm_callback()?;
    let back = publication_callback(PublicationKind::Post, "view", &[&draft_id, &back_view], None)?;
    let label = |key: &str| key.to_uppercase();
    let format_value = |value| format_zoned_date_time(Some(value), &zone, &time_config.timezone_label);
    let projections = services.posts.preview(actor_id, draft_id)?.delivery.projections;
    Ok(schedule_confirmation_effects(ScheduleConfirmation {
        kind: PublicationKind::Post,
        publication_id: draft_id,
        intro: Some(card.text),
        title: t(Key::CommonConfirmSchedule, &[]),
        title_prefix: "📅",
        entries: vec![(key.to_owned(), value)],
        label: &label,
        format_value: &format_value,
        keyboard: confirmation_keyboard(
            DialogButton {
                label: &confirm_label,
                callback: &confirm,
            },
            DialogButton {
                label: &back_label,
                callback: &back,
            },
            Some(state.revision),
        ),
        effects: vec![delivery_previews::effect(projections)],
    }))
}
