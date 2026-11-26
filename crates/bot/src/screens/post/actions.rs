//! The post controls: the 25 actions of
//! the post card beside the two every publication shares.

use content::Locale;
use domain::application::conversation_flow::PublicationKind;
use domain::application::ports::{ConversationSessionKind, StoryPublishMode};
use domain::publishing::preflight::{PreflightKind, PublicationPreflightIssue};
use domain::studio::services::posts::PostScheduleInput;
use domain::targets::target_definition;
use foundation::errors::StudioError;
use foundation::i18n::{Key, plural, t};
use foundation::js::number_to_string;
use foundation::time::{Zone, manual_schedule_example};
use jiff::Timestamp;

use crate::Fut;
use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::publication_callback;
use crate::context::Ctx;
use crate::dialog_ui::{prompt_effect, result_navigation_keyboard};
use crate::effects::{CardRef, Effect};
use crate::publication::{
    ActionContext, ActionDef, ActionHandler, CardRequest, Entity, card_effect, delivery_previews, render_card,
};
use crate::registry::Registry;
use crate::screens::entry::main_menu_text;
use crate::session::ConversationStateInput;

use super::flow::{PostWizardStep, post_state_step, post_step_data};
use super::input::scope;
use super::preview::mode_label;
use super::progress::render_post_progress;
use super::story_cards::{Intent, show_story_card_choice};

type Effects = crate::Result<Vec<Effect>>;

fn define(
    registry: &mut Registry,
    name: &'static str,
    handler: ActionHandler,
    entity: Entity,
    args: &'static [&'static str],
    fresh_card: bool,
    session_revision: bool,
) {
    registry.action(
        PublicationKind::Post,
        name,
        ActionDef {
            handler,
            entity,
            args,
            fresh_card,
            session_revision,
        },
    );
}

/// `definePostActionHandlers`.
pub fn register(registry: &mut Registry) {
    use Entity::{Draft, Session};
    let r = registry;
    define(r, "toggle", handle_toggle, Draft, &["target"], true, false);
    define(r, "cancel", handle_cancel, Draft, &["view"], true, false);
    define(r, "cancel_confirm", handle_cancel_confirm, Draft, &[], true, false);
    define(r, "cancel_dialog", handle_cancel_dialog, Session, &[], false, true);
    define(r, "cycle_mode", handle_cycle_mode, Draft, &[], true, false);
    define(r, "edit_ru", handle_edit, Draft, &[], true, false);
    define(r, "edit_en", handle_edit, Draft, &[], true, false);
    define(r, "schedule", handle_schedule, Draft, &[], true, false);
    define(r, "sched_scope", handle_schedule_scope, Draft, &["scope"], true, false);
    define(r, "sched_pick", handle_schedule_pick, Draft, &["axis", "clock"], true, false);
    define(r, "sched_confirm", handle_manual_schedule_confirm, Draft, &[], true, true);
    define(r, "sched_manual", handle_manual_schedule, Draft, &["axis"], true, false);
    define(r, "story_publish_all", handle_story_choice, Draft, &[], true, false);
    define(r, "story_publish_site", handle_story_choice, Draft, &[], true, false);
    define(r, "story_schedule_all", handle_story_choice, Draft, &[], true, false);
    define(r, "story_schedule_site", handle_story_choice, Draft, &[], true, false);
    define(r, "make_thread", handle_make_thread, Draft, &[], true, false);
    define(r, "thread_add", handle_thread_add, Draft, &[], false, false);
    define(r, "thread_done", handle_thread_done, Draft, &[], false, false);
    define(r, "thread_edit", handle_thread_edit, Draft, &["position", "locale"], true, false);
    define(r, "thread_remove", handle_thread_remove, Draft, &["position", "locale"], true, false);
    define(r, "skip", handle_skip, Draft, &["target", "origin"], false, false);
    define(r, "resend", handle_resend, Draft, &["target"], true, false);
    define(r, "publish", handle_publish, Draft, &[], true, false);
    define(r, "publish_confirm", handle_publish_confirm, Draft, &[], true, false);
}

fn unknown_action() -> crate::Error {
    StudioError::new("action.unknown").into()
}

fn card(context: &ActionContext<'_>, view: Option<&str>) -> crate::Result<crate::publication::PublicationCard> {
    render_card(
        context.ctx,
        PublicationKind::Post,
        &CardRequest {
            actor_id: context.actor_id,
            publication_id: context.draft_id(),
            view: view.map(str::to_owned),
            ..CardRequest::default()
        },
    )
}

/// `previewEffects`: the card on `view`, after an optional toast.
fn preview_effects(context: &ActionContext<'_>, view: &str, toast: Option<String>) -> Effects {
    let mut effects: Vec<Effect> = toast.into_iter().map(Effect::toast).collect();
    effects.extend(card_effect(card(context, Some(view))?));
    Ok(effects)
}

fn save_post_step(ctx: &Ctx, actor_id: i64, draft_id: i64, step: PostWizardStep) -> crate::Result<()> {
    ctx.sessions().save(
        actor_id,
        &ConversationStateInput {
            kind: ConversationSessionKind::Post,
            draft_id: Some(draft_id),
            step: step.name().to_owned(),
            data: post_step_data(step),
            control_message_id: None,
            revision: None,
        },
    )?;
    Ok(())
}

fn clear_post_session(ctx: &Ctx, actor_id: i64) -> crate::Result<()> {
    Ok(ctx.sessions().clear(actor_id, ConversationSessionKind::Post)?)
}

fn handle_cycle_mode<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let next = context
            .ctx
            .services()
            .posts
            .cycle_mode(context.actor_id, context.draft_id())?;
        preview_effects(
            context,
            "overview",
            Some(format!("{}: {}", t(Key::PostMode, &[]), mode_label(next))),
        )
    })
}

fn handle_toggle<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let target = context.arg("target").filter(|target| !target.is_empty()).ok_or_else(unknown_action)?;
        context
            .ctx
            .services()
            .posts
            .toggle_target(context.actor_id, context.draft_id(), target)?;
        let mut effects = vec![Effect::toast(t(Key::ActionTargetUpdated, &[("target", &target)]))];
        effects.extend(card_effect(card(context, Some("platforms"))?));
        Ok(effects)
    })
}

/// The counterpart of retry on the same card: the publication is finished
/// without the targets that did not land.
fn handle_skip<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let target = context.arg("target").filter(|target| *target != "all");
        let result = context
            .ctx
            .services()
            .posts
            .skip_target(context.actor_id, context.draft_id(), target)?;
        let toast = Effect::toast(t(Key::ActionSkipResult, &[("abandoned", &result.abandoned)]));
        if context.arg("origin") != Some("card") {
            return Ok(vec![toast]);
        }
        let mut effects = vec![toast];
        effects.extend(card_effect(card(context, None)?));
        Ok(effects)
    })
}

/// Sends a settled publication to one more platform; the refusals reach the
/// operator as the error toast the service raises.
fn handle_resend<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let target = context.arg("target").filter(|target| !target.is_empty()).ok_or_else(unknown_action)?;
        context
            .ctx
            .services()
            .posts
            .resend_target(context.actor_id, context.draft_id(), target)?;
        let label = target_definition(target).map_or(target, |definition| definition.label);
        let mut effects = vec![Effect::toast(t(Key::ActionResendQueued, &[("target", &label)]))];
        effects.extend(card_effect(card(context, Some("resend"))?));
        Ok(effects)
    })
}

fn handle_cancel<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let view = context.arg("view").unwrap_or("confirm_cancel");
        Ok(card_effect(card(context, Some(view))?))
    })
}

fn handle_cancel_confirm<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (actor, id) = (context.actor_id, context.draft_id());
        let services = context.ctx.services();
        let was_scheduled = services.posts.get(actor, id)?.status == "scheduled";
        services.posts.cancel(actor, id)?;
        let result = if was_scheduled {
            Key::ActionPublicationCancelled
        } else {
            Key::ActionDraftCancelled
        };
        Ok(vec![
            Effect::toast(t(Key::ActionCancelled, &[])),
            Effect::screen(
                t(result, &[("id", &id)]),
                Payload::new().reply_markup(result_navigation_keyboard()),
            ),
        ])
    })
}

fn handle_cancel_dialog<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        Ok(vec![
            Effect::SessionClear {
                kind: ConversationSessionKind::Post,
                actor_id: context.actor_id,
            },
            Effect::MainMenu {
                text: main_menu_text(context.ctx, context.actor_id)?,
            },
        ])
    })
}

fn handle_edit<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let locale = match context.action() {
            "edit_ru" => Locale::Ru,
            "edit_en" => Locale::En,
            _ => return Err(StudioError::new("action.session-stale").into()),
        };
        let ctx = context.ctx;
        save_post_step(ctx, context.actor_id, context.draft_id(), PostWizardStep::EditText { locale })?;
        Ok(vec![
            Effect::toast(t(Key::ActionSendReplacement, &[])),
            prompt_effect(ctx, PublicationKind::Post, &t(Key::ActionSendNewText, &[]), false)?,
        ])
    })
}

fn handle_publish<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(show_publication_intent(context, Intent::Publish))
}

fn handle_publish_confirm<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move { queue_post_now(context) })
}

fn handle_story_choice<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let action = context.action();
        let mode = if action.ends_with("_all") {
            StoryPublishMode::All
        } else {
            StoryPublishMode::SiteOnly
        };
        context
            .ctx
            .services()
            .posts
            .set_story_publish_mode(context.actor_id, context.draft_id(), mode)?;
        if action.starts_with("story_publish_") {
            queue_post_now(context)
        } else {
            preview_effects(context, "schedule", None)
        }
    })
}

fn handle_make_thread<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let services = context.ctx.services();
        let (actor, id) = (context.actor_id, context.draft_id());
        services.posts.make_thread(actor, id)?;
        // The parts need their English before anything can publish, so the
        // card comes back rather than the publish confirmation.
        let parts = services.posts.get(actor, id)?.thread.len() + 1;
        preview_effects(
            context,
            "overview",
            Some(t(Key::ActionThreadMade, &[("parts", &parts)])),
        )
    })
}

/// Opens the next post of the thread: whatever the next message carries
/// becomes it.
fn handle_thread_add<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let ctx = context.ctx;
        let (actor, id) = (context.actor_id, context.draft_id());
        save_post_step(ctx, actor, id, PostWizardStep::ThreadPart)?;
        let next = ctx.services().posts.get(actor, id)?.thread.len() + 2;
        Ok(vec![prompt_effect(
            ctx,
            PublicationKind::Post,
            &t(Key::ActionThreadSendPart, &[("part", &next)]),
            false,
        )?])
    })
}

/// The thread is written: the author reviews it whole before anything else.
fn handle_thread_done<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        clear_post_session(context.ctx, context.actor_id)?;
        preview_effects(context, "thread", None)
    })
}

fn handle_thread_edit<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let ctx = context.ctx;
        let position = thread_position(context.arg("position"))?;
        let locale = thread_locale(context.arg("locale"));
        save_post_step(
            ctx,
            context.actor_id,
            context.draft_id(),
            PostWizardStep::ThreadEdit { position, locale },
        )?;
        let prompt = if locale == Locale::En {
            Key::ActionThreadSendReplacementEn
        } else {
            Key::ActionThreadSendReplacement
        };
        Ok(vec![prompt_effect(
            ctx,
            PublicationKind::Post,
            &t(prompt, &[("part", &position)]),
            false,
        )?])
    })
}

fn handle_thread_remove<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let position = thread_position(context.arg("position"))?;
        let services = context.ctx.services();
        let (actor, id) = (context.actor_id, context.draft_id());
        services.posts.remove_thread_part(actor, id, position)?;
        let view = if services.posts.get(actor, id)?.thread.is_empty() {
            "overview"
        } else {
            "thread"
        };
        preview_effects(
            context,
            view,
            Some(t(Key::ActionThreadPartRemoved, &[("part", &position)])),
        )
    })
}

/// Which language of the thread a button was pressed in. Russian is what a
/// callback from before the English screen existed means.
fn thread_locale(value: Option<&str>) -> Locale {
    if value == Some("en") { Locale::En } else { Locale::Ru }
}

fn thread_position(value: Option<&str>) -> crate::Result<i64> {
    // `Number(undefined)` is NaN.
    let position = value.map_or(f64::NAN, foundation::js::number);
    if !foundation::js::is_integer(position) || position < 2.0 {
        return Err(StudioError::new("action.invalid-callback-argument").into());
    }
    Ok(position as i64)
}

fn handle_schedule<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        clear_post_session(context.ctx, context.actor_id)?;
        let status = context
            .ctx
            .services()
            .posts
            .get(context.actor_id, context.draft_id())?
            .status;
        if status == "scheduled" {
            return preview_effects(context, "schedule", None);
        }
        show_publication_intent(context, Intent::Schedule).await
    })
}

async fn show_publication_intent(context: &ActionContext<'_>, intent: Intent) -> Effects {
    if let Some(preflight) = show_publication_preflight(context)? {
        return Ok(preflight);
    }
    if let Some(choice) = show_story_card_choice(context.ctx, context.actor_id, context.draft_id(), intent)? {
        return Ok(choice);
    }
    match intent {
        Intent::Publish => send_publish_confirmation(context),
        Intent::Schedule => preview_effects(context, "schedule", None),
    }
}

fn handle_schedule_scope<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let Some(scope_arg) = context.arg("scope").filter(|scope| !scope.is_empty()) else {
            return Ok(vec![Effect::toast(t(Key::ActionUnknown, &[]))]);
        };
        clear_post_session(context.ctx, context.actor_id)?;
        let now = context.ctx.now();
        match scope_arg {
            "ru_now" => commit_locale_schedule(context, Locale::Ru, now, Some(Locale::Ru)),
            "en_now" => commit_locale_schedule(context, Locale::En, now, Some(Locale::En)),
            "both" => preview_effects(context, "schedule_ru", None),
            _ => Ok(vec![Effect::toast(t(Key::ActionUnknown, &[]))]),
        }
    })
}

fn handle_schedule_pick<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (Some(axis), Some(clock)) = (
            context.arg("axis").filter(|axis| !axis.is_empty()),
            context.arg("clock").filter(|clock| !clock.is_empty()),
        ) else {
            return Ok(vec![Effect::toast(t(Key::ActionUnknown, &[]))]);
        };
        clear_post_session(context.ctx, context.actor_id)?;
        // `${clock.slice(0, 2)}:${clock.slice(2, 4)}`, by UTF-16 units.
        let units: Vec<u16> = clock.encode_utf16().collect();
        let slice = |from: usize, to: usize| String::from_utf16_lossy(&units[from.min(units.len())..to.min(units.len())]);
        let value = context
            .ctx
            .services()
            .posts
            .slot_time(context.actor_id, &format!("{}:{}", slice(0, 2), slice(2, 4)))?;
        commit_locale_schedule(context, require_schedule_locale(axis)?, value, None)
    })
}

fn handle_manual_schedule_confirm<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let ctx = context.ctx;
        let state = ctx.sessions().get(context.actor_id, ConversationSessionKind::Post)?;
        let step = post_state_step(state.as_ref());
        let (Some(PostWizardStep::ScheduleConfirm { locale, value }), Some(state)) = (step, state) else {
            return Ok(vec![Effect::toast(t(Key::ActionScheduleExpired, &[]))]);
        };
        if state.draft_id != Some(context.draft_id()) {
            return Ok(vec![Effect::toast(t(Key::ActionScheduleExpired, &[]))]);
        }
        clear_post_session(ctx, context.actor_id)?;
        commit_locale_schedule(context, locale, value, None)
    })
}

fn handle_manual_schedule<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let Some(axis) = context.arg("axis").filter(|axis| !axis.is_empty()) else {
            return Ok(vec![Effect::toast(t(Key::ActionUnknown, &[]))]);
        };
        let locale = require_schedule_locale(axis)?;
        let ctx = context.ctx;
        clear_post_session(ctx, context.actor_id)?;
        let time_config = ctx.services().settings.time_config(context.actor_id)?;
        save_post_step(
            ctx,
            context.actor_id,
            context.draft_id(),
            PostWizardStep::ScheduleManual { locale },
        )?;
        let zone = Zone::parse(&time_config.timezone)
            .ok_or_else(|| crate::error(format!("Invalid time zone specified: {}", time_config.timezone)))?;
        let example = manual_schedule_example(&zone, ctx.now());
        Ok(vec![
            Effect::toast(t(Key::ActionSendTime, &[])),
            prompt_effect(
                ctx,
                PublicationKind::Post,
                &t(
                    Key::ActionEnterDatetime,
                    &[("timezone", &time_config.timezone_label), ("example", &example)],
                ),
                false,
            )?,
        ])
    })
}

fn queue_post_now(context: &ActionContext<'_>) -> Effects {
    let services = context.ctx.services();
    let (actor, id) = (context.actor_id, context.draft_id());
    services.posts.publish(actor, id)?;
    let (text, keyboard) = render_post_progress(&services.posts.progress(actor, id)?, false)?;
    Ok(vec![
        Effect::toast(t(Key::ActionQueued, &[])),
        Effect::screen(t(Key::ActionPostQueued, &[("id", &id)]), Payload::new()),
        Effect::Screen {
            text,
            options: Payload::new().markdown().reply_markup(keyboard),
            card: Some(CardRef::PostProgress {
                draft_id: id,
                details: false,
            }),
        },
    ])
}

/// Commits one locale's schedule at once (a slot, a typed time, or "now").
/// When the other locale still needs a time and has enabled targets, its slot
/// screen comes next instead of the result.
fn commit_locale_schedule(
    context: &ActionContext<'_>,
    locale: Locale,
    value: Timestamp,
    immediate: Option<Locale>,
) -> Effects {
    let services = context.ctx.services();
    let posts = &services.posts;
    let (actor, id) = (context.actor_id, context.draft_id());
    let at = posts.schedule_at(actor, id, scope(locale), value)?;
    posts.schedule(
        actor,
        id,
        &PostScheduleInput {
            ru_at: at.ru_at,
            en_at: at.en_at,
            allow_past: false,
            immediate_locale: immediate,
        },
    )?;
    let (other, other_at) = match locale {
        Locale::Ru => (Locale::En, at.en_at),
        Locale::En => (Locale::Ru, at.ru_at),
    };
    if other_at.is_none() && posts.has_locale_targets(actor, id, other)? {
        let view = if other == Locale::Ru { "schedule_ru" } else { "schedule_en" };
        return preview_effects(context, view, None);
    }
    let mut effects = vec![Effect::toast(t(Key::CommonScheduled, &[]))];
    effects.extend(card_effect(card(context, Some("overview"))?));
    Ok(effects)
}

fn send_publish_confirmation(context: &ActionContext<'_>) -> Effects {
    let projections = context
        .ctx
        .services()
        .posts
        .preview(context.actor_id, context.draft_id())?
        .delivery
        .projections;
    let mut effects = vec![delivery_previews::effect(projections)];
    effects.extend(card_effect(card(context, Some("confirm_publish"))?));
    Ok(effects)
}

fn show_publication_preflight(context: &ActionContext<'_>) -> crate::Result<Option<Vec<Effect>>> {
    let ctx = context.ctx;
    let (actor, id) = (context.actor_id, context.draft_id());
    let issues = ctx.services().posts.validate(actor, id)?;
    let Some(issue) = issues.first() else {
        return Ok(None);
    };
    // An overflow a thread would resolve needs a message, not an alert: an
    // alert cannot carry a button. Only when every issue is one.
    let parts = if issues.iter().all(|item| item.thread_parts.is_some_and(|parts| parts > 0)) {
        issues.iter().filter_map(|item| item.thread_parts).max().unwrap_or(0)
    } else {
        0
    };
    if parts > 1 {
        let label = plural(
            parts as u64,
            &t(Key::ActionPartsOne, &[]),
            &t(Key::ActionPartsFew, &[]),
            &t(Key::ActionPartsMany, &[]),
        );
        let revision = ctx
            .sessions()
            .get(actor, ConversationSessionKind::Post)?
            .map(|state| state.revision);
        let keyboard = InlineKeyboard::new().text(
            t(Key::ActionPreflightThreadButton, &[("parts", &label)]),
            publication_callback(PublicationKind::Post, "make_thread", &[&id], revision)?,
        );
        let text = t(
            Key::ActionPreflightThread,
            &[
                ("label", &issue.label),
                ("actual", &number(issue.actual)),
                ("limit", &number(issue.limit)),
                ("parts", &label),
            ],
        );
        return Ok(Some(vec![Effect::Screen {
            text,
            options: Payload::new().reply_markup(keyboard),
            card: Some(CardRef::Post { draft_id: id, view: None }),
        }]));
    }
    Ok(Some(vec![Effect::Toast {
        text: preflight_toast(issue),
        show_alert: true,
    }]))
}

/// `value ?? 0`, as JavaScript prints it.
fn number(value: Option<f64>) -> String {
    number_to_string(value.unwrap_or(0.0))
}

/// A refusal an author can act on: the limit issues count characters, the
/// language and content ones name what is missing.
fn preflight_toast(issue: &PublicationPreflightIssue) -> String {
    let expected = issue.locale.as_str().to_uppercase();
    let label = &issue.label;
    match issue.kind {
        PreflightKind::Language => {
            let written = issue.written.unwrap_or(issue.locale).as_str().to_uppercase();
            t(
                Key::ActionPreflightLanguage,
                &[("label", label), ("expected", &expected), ("written", &written)],
            )
        }
        PreflightKind::Empty => match issue.part {
            Some(part) if part > 0 => t(
                Key::ActionPreflightEmptyPart,
                &[("label", label), ("expected", &expected), ("part", &part)],
            ),
            _ => t(Key::ActionPreflightEmpty, &[("label", label), ("expected", &expected)]),
        },
        PreflightKind::MediaSize => {
            let megabytes = |value: Option<f64>, round: fn(f64) -> f64| {
                number_to_string(round(value.unwrap_or(0.0) / 1_048_576.0))
            };
            t(
                Key::ActionPreflightMediaSize,
                &[
                    ("label", label),
                    ("actual", &megabytes(issue.actual, f64::ceil)),
                    ("limit", &megabytes(issue.limit, f64::floor)),
                ],
            )
        }
        PreflightKind::MediaLimit => t(
            Key::ActionPreflightMedia,
            &[
                ("label", label),
                ("actual", &number(issue.actual)),
                ("limit", &number(issue.limit)),
            ],
        ),
        _ => match issue.part {
            Some(part) if part > 0 => t(
                Key::ActionPreflightPart,
                &[
                    ("label", label),
                    ("part", &part),
                    ("actual", &number(issue.actual)),
                    ("limit", &number(issue.limit)),
                ],
            ),
            _ => t(
                Key::ActionPreflight,
                &[
                    ("label", label),
                    ("actual", &number(issue.actual)),
                    ("limit", &number(issue.limit)),
                ],
            ),
        },
    }
}

fn require_schedule_locale(value: &str) -> crate::Result<Locale> {
    match value {
        "ru" => Ok(Locale::Ru),
        "en" => Ok(Locale::En),
        _ => Err(StudioError::new("err.unknown-scope").into()),
    }
}
