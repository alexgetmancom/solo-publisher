//! The publication controls (`p:post:…`, `p:video:…`): the action contract
//! (`bot/publication-action-contract.ts`), the router that checks a tap before
//! any action runs (`bot/callback-router.ts`, spec §5.2), the actions both
//! kinds share (`view`, `retry`), the card a publication renders as
//! (`bot/publication-renderers.ts`) and `runCallbackAction`
//! (`bot/callback-effects.ts`).
//!
//! The post and video areas register their actions, their card renderer and
//! their message handler; nothing here knows what a post card looks like.
//! What both kinds build their screens from lives beside it: the schedule
//! protocol, the delivery previews and the unlanded-target controls.

pub mod delivery_previews;
pub mod scheduling;
pub mod unlanded;

use std::fmt::Display;

use domain::application::conversation_flow::PublicationKind;
use domain::application::publication_pipeline::PublicationPipeline;
use foundation::i18n::{Key, t};
use foundation::logger::{LogLevel, log};
use serde_json::json;

use crate::Fut;
use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::{
    PublicationCallback, ScreenId, parse_draft_id, parse_session_callback, require_session_revision, screen,
};
use crate::cards::is_superseded_card;
use crate::context::Ctx;
use crate::effects::{CardRef, Effect, execute};
use crate::error_text::{callback_toast, describe_publication_error};
use crate::registry::Registry;
use crate::session::{ConversationState, ConversationStateInput, publication_session_kind};

/// What the first argument of an action names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entity {
    /// A draft id: checked to be one the actor may open before the handler runs.
    Draft,
    Session,
    None,
}

pub type ActionHandler = for<'a> fn(&'a ActionContext<'a>) -> Fut<'a, crate::Result<Vec<Effect>>>;

/// One action's declaration (`action(handler, { entity, args, freshCard, sessionRevision })`).
#[derive(Clone, Copy)]
pub struct ActionDef {
    pub handler: ActionHandler,
    pub entity: Entity,
    /// Named arguments after the draft id.
    pub args: &'static [&'static str],
    /// Refuse a tap on a card the publication has moved past.
    pub fresh_card: bool,
    /// Require the dialog revision prefix (`sv<n>|`).
    pub session_revision: bool,
}

/// What an action handler is handed.
pub struct ActionContext<'a> {
    pub ctx: &'a Ctx,
    pub actor_id: i64,
    pub callback: &'a PublicationCallback,
    pub revision: Option<i64>,
    pub args: Vec<(&'static str, Option<String>)>,
    /// Present for every `Entity::Draft` action.
    pub draft_id: Option<i64>,
}

impl ActionContext<'_> {
    pub fn kind(&self) -> PublicationKind {
        self.callback.kind
    }

    pub fn action(&self) -> &str {
        &self.callback.action
    }

    pub fn arg(&self, name: &str) -> Option<&str> {
        self.args
            .iter()
            .find(|(declared, _)| *declared == name)
            .and_then(|(_, value)| value.as_deref())
    }

    /// The draft of an `Entity::Draft` action.
    pub fn draft_id(&self) -> i64 {
        self.draft_id.expect("draft actions carry a draft id")
    }
}

/// What a card is asked to show.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CardRequest {
    pub actor_id: i64,
    pub publication_id: i64,
    pub view: Option<String>,
    pub target: Option<String>,
    pub revision: Option<i64>,
}

/// A publication rendered as its card.
#[derive(Clone, Debug, PartialEq)]
pub struct PublicationCard {
    pub kind: PublicationKind,
    pub draft_id: i64,
    pub text: String,
    pub keyboard: InlineKeyboard,
    /// The screen the card shows, so a later repaint draws the same one.
    pub view: Option<String>,
}

pub type CardRenderer = for<'a> fn(&'a Ctx, &'a CardRequest) -> crate::Result<PublicationCard>;

pub fn render_card(ctx: &Ctx, kind: PublicationKind, request: &CardRequest) -> crate::Result<PublicationCard> {
    let renderer = ctx
        .bot
        .registry()
        .card_renderer(kind)
        .ok_or_else(|| crate::error(format!("no {} card renderer is registered", kind.as_str())))?;
    renderer(ctx, request)
}

fn card_ref(card: &PublicationCard) -> CardRef {
    match card.kind {
        PublicationKind::Post => CardRef::Post {
            draft_id: card.draft_id,
            view: card.view.clone(),
        },
        PublicationKind::Video => CardRef::Video {
            draft_id: card.draft_id,
        },
    }
}

fn card_options(card: &PublicationCard) -> Payload {
    Payload::new().markdown().reply_markup(card.keyboard.clone())
}

/// `publicationCardEffect`: the card as the answer to the tap.
pub fn card_effect(card: PublicationCard) -> Vec<Effect> {
    let options = card_options(&card);
    vec![Effect::Screen {
        card: Some(card_ref(&card)),
        text: card.text,
        options,
    }]
}

/// `publicationCardMessage`: the card brought back to the bottom of the chat.
pub fn card_message(card: PublicationCard) -> Vec<Effect> {
    let options = card_options(&card);
    vec![Effect::Message {
        card: Some(card_ref(&card)),
        text: card.text,
        options,
    }]
}

/// `advancePublicationFlow`: a step accepted its input and names the next
/// one; the dialog moves there and consumes exactly one session revision.
pub fn advance_flow(
    ctx: &Ctx,
    actor_id: i64,
    session: &ConversationState,
    next: Option<&str>,
    data: domain::application::ports::JsonObject,
    error_code: &str,
) -> crate::Result<ConversationState> {
    let next = next.ok_or_else(|| foundation::errors::StudioError::new(error_code))?;
    Ok(ctx.sessions().save(
        actor_id,
        &ConversationStateInput {
            kind: session.kind,
            draft_id: session.draft_id,
            step: next.to_owned(),
            data,
            control_message_id: session.control_message_id,
            revision: Some(session.revision),
        },
    )?)
}

/// What turns a failure into the operator's text, and what logs it.
pub type Describe<'a> = &'a dyn Fn(&(dyn std::error::Error + 'static)) -> String;
pub type OnError<'a> = &'a dyn Fn(&(dyn std::error::Error + 'static));

/// `runCallbackAction`: one tap at a time per `lock_key`, an answer for every
/// tap, and a failure the operator can read.
pub async fn run_callback_action<'a>(
    ctx: &'a Ctx,
    lock_key: &str,
    describe: Describe<'_>,
    on_error: Option<OnError<'_>>,
    produce: Fut<'a, crate::Result<Vec<Effect>>>,
) -> crate::Result<()> {
    let attempt: crate::Result<()> = async {
        let lock = ctx.bot.action_locks().acquire(lock_key, ctx.now().as_millisecond());
        let mut effects = match lock {
            Some(guard) => {
                // `await action()` yields before the action runs, which is what
                // lets a concurrent tap find the key held.
                crate::sequentialize::yield_now().await;
                let effects = produce.await;
                drop(guard);
                effects?
            }
            None => vec![Effect::toast(t(Key::ActionInFlight, &[]))],
        };
        if !effects.iter().any(Effect::is_answer) {
            effects.insert(
                0,
                Effect::AnswerCallback {
                    text: None,
                    show_alert: false,
                },
            );
        }
        execute(ctx, effects).await
    }
    .await;
    if let Err(error) = attempt {
        if let Some(on_error) = on_error {
            on_error(&*error);
        }
        execute(ctx, vec![Effect::toast(callback_toast(&describe(&*error)))]).await?;
    }
    Ok(())
}

/// The one answer to a control that no longer means anything.
fn stale_effects(include_queue: bool) -> Vec<Effect> {
    let text = t(Key::ActionCardStale, &[]);
    let mut effects = vec![Effect::answer(text.clone())];
    if include_queue {
        let keyboard = InlineKeyboard::new().text(t(Key::MenuWorkQueue, &[]), screen(ScreenId::QueueHome));
        effects.push(Effect::message(text, Payload::new().reply_markup(keyboard)));
    }
    effects
}

fn invalid_entity_text(kind: PublicationKind) -> String {
    match kind {
        PublicationKind::Post => t(Key::ActionInvalidPost, &[]),
        PublicationKind::Video => t(Key::ErrVideoReopenCreate, &[]),
    }
}

/// `pipeline.get(actorId, id)`: refuses a publication the actor cannot open.
fn require_publication(ctx: &Ctx, kind: PublicationKind, actor_id: i64, id: i64) -> crate::Result<()> {
    let services = ctx.services();
    match kind {
        PublicationKind::Post => PublicationPipeline::get(&services.posts, actor_id, id)?,
        PublicationKind::Video => PublicationPipeline::get(&services.videos, actor_id, id)?,
    };
    Ok(())
}

fn timezone_label(ctx: &Ctx) -> String {
    ctx.services()
        .settings
        .time_config(ctx.actor_id())
        .map(|config| config.timezone_label)
        .unwrap_or_default()
}

/// `handlePublicationCallback`: the checks of spec §5.2, in order, then the action.
pub async fn handle_publication_callback(ctx: &Ctx) -> crate::Result<bool> {
    let Some(raw) = ctx.callback_data() else {
        return Ok(false);
    };
    let parsed = parse_session_callback(raw);
    let Some(callback) = parsed.callback.clone() else {
        return Ok(false);
    };
    let actor_id = ctx.actor_id();
    if actor_id <= 0 {
        return Ok(false);
    }
    let lock_key = format!("{actor_id}:{}", parsed.data);
    let describe = |error: &(dyn std::error::Error + 'static)| describe_publication_error(error, &timezone_label(ctx));
    let on_error = |error: &(dyn std::error::Error + 'static)| {
        log(
            LogLevel::Error,
            "Publication action failed",
            Some(json!({
                "actorId": actor_id,
                "kind": callback.kind.as_str(),
                "action": callback.action,
                "error": error.to_string(),
            })),
        );
    };
    let callback_ref = &callback;
    let produce: Fut<'_, crate::Result<Vec<Effect>>> = Box::pin(async move {
        let callback = callback_ref;
        let Some(action) = ctx
            .bot
            .registry()
            .publication_action(callback.kind, &callback.action)
            .copied()
        else {
            return Ok(stale_effects(true));
        };
        let has_draft = action.entity == Entity::Draft;
        let draft_id = if has_draft {
            parse_draft_id(callback.args.first().map(String::as_str))
        } else {
            None
        };
        if has_draft && draft_id.is_none() {
            return Ok(vec![Effect::answer(invalid_entity_text(callback.kind))]);
        }
        let values = if has_draft {
            &callback.args[1..]
        } else {
            &callback.args[..]
        };
        if values.len() != action.args.len() {
            return Ok(stale_effects(false));
        }
        let session = ctx.sessions().get(actor_id, publication_session_kind(callback.kind))?;
        if action.session_revision && parsed.revision.is_none() {
            return Ok(stale_effects(false));
        }
        if parsed.revision.is_some() {
            require_session_revision(session.as_ref().map(|state| state.revision), parsed.revision)?;
        }
        if let Some(draft_id) = draft_id {
            require_publication(ctx, callback.kind, actor_id, draft_id)?;
        }
        if action.fresh_card
            && let Some(draft_id) = draft_id
            && is_superseded_card(ctx, callback.kind, draft_id)?
        {
            let card = render_card(
                ctx,
                callback.kind,
                &CardRequest {
                    actor_id,
                    publication_id: draft_id,
                    ..CardRequest::default()
                },
            )?;
            let mut effects = vec![Effect::answer(t(Key::ActionCardStale, &[]))];
            effects.extend(card_message(card));
            return Ok(effects);
        }
        let context = ActionContext {
            ctx,
            actor_id,
            callback,
            revision: parsed.revision,
            args: action
                .args
                .iter()
                .enumerate()
                .map(|(index, name)| (*name, values.get(index).cloned()))
                .collect(),
            draft_id,
        };
        (action.handler)(&context).await
    });
    run_callback_action(ctx, &lock_key, &describe, Some(&on_error), produce).await?;
    Ok(true)
}

/// `handlePublicationMessage`: the active conversation (video before post)
/// answers; a conversation that declines leaves it to the post screen, which
/// always answers.
pub async fn handle_publication_message(ctx: &Ctx) -> crate::Result<bool> {
    let registry = ctx.bot.registry();
    let handler = |kind: PublicationKind| {
        registry
            .publication_message_handler(kind)
            .ok_or_else(|| crate::error(format!("no {} message handler is registered", kind.as_str())))
    };
    let kind = ctx
        .sessions()
        .active(ctx.actor_id())?
        .map_or(PublicationKind::Post, |(kind, _)| kind);
    let opened = handler(kind)?(ctx).await?;
    let result = if opened.handled {
        opened
    } else {
        handler(PublicationKind::Post)?(ctx).await?
    };
    if !result.effects.is_empty() {
        execute(ctx, result.effects).await?;
    }
    Ok(result.handled)
}

fn handle_view<'a>(context: &'a ActionContext<'a>) -> Fut<'a, crate::Result<Vec<Effect>>> {
    Box::pin(async move {
        let card = render_card(
            context.ctx,
            context.kind(),
            &CardRequest {
                actor_id: context.actor_id,
                publication_id: context.draft_id(),
                view: context.arg("view").map(str::to_owned),
                ..CardRequest::default()
            },
        )?;
        Ok(card_effect(card))
    })
}

fn handle_retry<'a>(context: &'a ActionContext<'a>) -> Fut<'a, crate::Result<Vec<Effect>>> {
    Box::pin(async move {
        let target = match context.arg("target") {
            Some("all") | None => "",
            Some(target) => target,
        };
        let services = context.ctx.services();
        let (actor, id) = (context.actor_id, context.draft_id());
        let result = match context.kind() {
            PublicationKind::Post => PublicationPipeline::retry_target(&services.posts, actor, id, target).await?,
            PublicationKind::Video => PublicationPipeline::retry_target(&services.videos, actor, id, target).await?,
        };
        let params: [(&str, &dyn Display); 2] = [
            ("requeued", &result.requeued),
            ("alreadyQueued", &result.already_queued),
        ];
        let toast = Effect::toast(t(Key::ActionRetryResult, &params));
        if context.arg("origin") != Some("card") {
            return Ok(vec![toast]);
        }
        let card = render_card(
            context.ctx,
            context.kind(),
            &CardRequest {
                actor_id: actor,
                publication_id: id,
                ..CardRequest::default()
            },
        )?;
        let mut effects = vec![toast];
        effects.extend(card_effect(card));
        Ok(effects)
    })
}

/// The actions every publication kind has (`sharedActions`).
pub fn register_shared_actions(registry: &mut Registry) {
    for kind in [PublicationKind::Post, PublicationKind::Video] {
        registry.action(
            kind,
            "view",
            ActionDef {
                handler: handle_view,
                entity: Entity::Draft,
                args: &["view"],
                fresh_card: false,
                session_revision: false,
            },
        );
        registry.action(
            kind,
            "retry",
            ActionDef {
                handler: handle_retry,
                entity: Entity::Draft,
                args: &["target", "origin"],
                fresh_card: false,
                session_revision: false,
            },
        );
    }
}
