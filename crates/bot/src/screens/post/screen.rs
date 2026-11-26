//! The conversational text-post screen: the operator's
//! input from the moment the intake decides the material is a post.

use content::media_size_advice::media_size_advice;
use content::message::DraftMessage;
use domain::application::ports::{ConversationSessionKind, JsonObject};
use foundation::i18n::{Key, t};

use crate::Fut;
use crate::albums::{PendingAlbumInput, append_pending_album};
use crate::api::payload::Payload;
use crate::context::Ctx;
use crate::effects::{CardRef, Effect};
use crate::error_text::describe_publication_error;
use crate::message::extract_message;
use crate::registry::MessageResult;
use crate::screens::entry::persistent_keyboard;

use super::flow::{PostWizardStep, post_state_step, post_step_data};
use super::input::apply_admin_state;
use super::preview::post_preview_card;

/// `handlePostMessage`: an album, an answer to the open step, or the advice
/// that the intake is the way in. It always answers.
pub fn handle_post_message(ctx: &Ctx) -> Fut<'_, crate::Result<MessageResult>> {
    Box::pin(async move {
        let actor_id = ctx.actor_id();
        let state = ctx.sessions().get(actor_id, ConversationSessionKind::Post)?;
        let step = post_state_step(state.as_ref());
        let message = extract_message(ctx);
        let media_group_id = ctx
            .update
            .message
            .as_ref()
            .and_then(|message| message.media_group_id.as_deref());
        if let Some(media_group_id) = media_group_id
            && let Some(media) = message.media.first()
        {
            // An album is several messages: the collector settles them into
            // one draft a few seconds later. Without an open edit it is new
            // material -- several photos can only be a post.
            let editing = match (step, state.as_ref().and_then(|state| state.draft_id)) {
                (Some(step), Some(draft_id)) => Some((step, draft_id, state.as_ref().map(|state| state.revision))),
                _ => None,
            };
            let step_data = editing.map_or_else(JsonObject::new, |(step, _, _)| post_step_data(step));
            let is_new = append_pending_album(
                ctx.db(),
                ctx.now(),
                &PendingAlbumInput {
                    actor_id,
                    chat_id: ctx.chat_id().unwrap_or_default(),
                    media_group_id,
                    text: &message.text,
                    entities: &message.entities,
                    media,
                    step: editing.map(|(step, _, _)| step.name()),
                    step_data: &step_data,
                    draft_id: editing.map(|(_, draft_id, _)| draft_id),
                    state_revision: editing.and_then(|(_, _, revision)| revision),
                },
            )?;
            let effects = if is_new {
                vec![Effect::screen(t(Key::PostAlbumReceived, &[]), Payload::new())]
            } else {
                Vec::new()
            };
            return Ok(MessageResult::handled(effects));
        }
        if let (Some(step), Some(state)) = (step, state.as_ref())
            && step.takes_input()
            && let Some(draft_id) = state.draft_id
        {
            return Ok(MessageResult::handled(
                match apply_admin_state(ctx, step, draft_id, Some(state.revision)).await {
                    Ok(effects) => effects,
                    Err(error) => vec![value_error(ctx, step, &*error)],
                },
            ));
        }
        // Nothing is open and this is not an album: guessing what an
        // unannounced message is meant to be is the intake's job.
        Ok(MessageResult::handled(vec![Effect::screen(
            t(Key::PostNeedNewPost, &[]),
            Payload::new().reply_markup(persistent_keyboard()),
        )]))
    })
}

fn value_error(ctx: &Ctx, step: PostWizardStep, error: &(dyn std::error::Error + 'static)) -> Effect {
    let timezone_label = ctx
        .services()
        .settings
        .time_config(ctx.actor_id())
        .map(|config| config.timezone_label)
        .unwrap_or_default();
    let text = describe_publication_error(error, &timezone_label);
    let text = if matches!(step, PostWizardStep::ScheduleManual { .. }) {
        text
    } else {
        t(Key::PostValueError, &[("error", &text)])
    };
    Effect::screen(text, Payload::new())
}

/// `createPostFromMessage`: captured material as a post draft and its card.
/// The intake calls this from a button press and from the message itself, so
/// a post made either way is the same post. The English is queued with the
/// draft and lands in this same card a moment later.
pub fn create_post_from_message(ctx: &Ctx, actor_id: i64, message: &DraftMessage) -> crate::Result<Vec<Effect>> {
    let draft_id = ctx.services().posts.create(actor_id, message, None)?;
    ctx.sessions().clear(actor_id, ConversationSessionKind::Post)?;
    let preview = post_preview_card(ctx, actor_id, draft_id, None)?;
    let mut effects = Vec::new();
    // Advice ahead of the card, never after it: the card carries the buttons
    // the advice points at, and it stays the last thing in the chat.
    if let Some(advice) = media_size_advice(&message.media) {
        effects.push(Effect::screen(
            t(
                Key::PostMediaLarge,
                &[
                    ("megabytes", &advice.megabytes),
                    ("recommended", &advice.recommended_megabytes),
                ],
            ),
            Payload::new(),
        ));
    }
    effects.push(Effect::Screen {
        text: preview.text,
        options: Payload::new().markdown().reply_markup(preview.keyboard),
        card: Some(CardRef::Post { draft_id, view: None }),
    });
    Ok(effects)
}
