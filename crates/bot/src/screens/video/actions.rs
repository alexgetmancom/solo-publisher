//! The video controls (`bot/video-actions.ts`): the 23 actions
//! of the video card and its conversation, beside the two every publication
//! shares.

use domain::application::conversation_flow::{PublicationKind, back_flow};
use domain::application::ports::JsonObject;
use domain::studio::services::videos::VideoView;
use domain::studio::video_fsm::VIDEO_FLOW;
use foundation::errors::StudioError;
use foundation::i18n::{Key, t};
use foundation::time::{manual_schedule_example, parse_iso_instant};
use jiff::Timestamp;
use serde_json::{Map, Value, json};

use crate::Fut;
use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::publication_callback;
use crate::context::Ctx;
use crate::dialog_ui::{prompt_effect, result_navigation_keyboard};
use crate::effects::{CardRef, Effect};
use crate::publication::{ActionContext, ActionDef, ActionHandler, CardRequest, Entity, card_effect, render_card};
use crate::registry::Registry;
use crate::screens::entry::main_menu_text;

use super::conversation::start_video_draft;
use super::preview::video_preview_card;
use super::scheduling::{apply_video_schedule_date, finish_video_now, finish_video_schedule};
use super::state::{
    VideoState, VideoStateInput, advance, clear_video_state, get_video_state, is_video_step, require_video_target,
    save_video_state, schedule_choice_keyboard, time_settings, video_step_effects, video_target_label,
};

type Effects = crate::Result<Vec<Effect>>;

const SCHEDULE_SESSION_STEPS: [&str; 2] = ["schedule_common", "schedule_target"];

/// One editable field of the edit menu: its button, its prompt and the
/// platform it belongs to (none for the draft's own fields).
struct EditField {
    field: &'static str,
    label: Key,
    prompt: Key,
    target: Option<&'static str>,
}

const EDIT_FIELDS: [EditField; 7] = [
    EditField {
        field: "label",
        label: Key::VideoEditCardName,
        prompt: Key::VideoEditLabelPrompt,
        target: None,
    },
    EditField {
        field: "script",
        label: Key::VideoEditScript,
        prompt: Key::VideoEditScriptPrompt,
        target: None,
    },
    EditField {
        field: "youtube_title",
        label: Key::VideoEditYtTitle,
        prompt: Key::VideoEditYtTitlePrompt,
        target: Some("youtube_shorts"),
    },
    EditField {
        field: "youtube_description",
        label: Key::VideoEditYtDesc,
        prompt: Key::VideoEditYtDescPrompt,
        target: Some("youtube_shorts"),
    },
    EditField {
        field: "youtube_game_url",
        label: Key::VideoEditGameUrl,
        prompt: Key::VideoEditGameUrlPrompt,
        target: Some("youtube_shorts"),
    },
    EditField {
        field: "youtube_tags",
        label: Key::VideoEditYtTags,
        prompt: Key::VideoEditYtTagsPrompt,
        target: Some("youtube_shorts"),
    },
    EditField {
        field: "instagram_caption",
        label: Key::VideoEditIgCaption,
        prompt: Key::VideoEditIgCaptionPrompt,
        target: Some("instagram_reels"),
    },
];

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
        PublicationKind::Video,
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

/// `defineVideoActionHandlers`.
pub fn register(registry: &mut Registry) {
    use Entity::{Draft, Session};
    let r = registry;
    define(r, "cancel_dialog", handle_cancel_dialog, Session, &[], false, true);
    define(r, "length_ok", handle_length_confirm, Session, &[], false, true);
    define(r, "game_skip", handle_game_skip, Session, &[], false, true);
    define(r, "script_skip", handle_script_skip, Session, &[], false, true);
    define(r, "meta_back", handle_meta_back, Session, &[], false, true);
    define(r, "schedule", handle_schedule_start, Draft, &[], true, false);
    define(r, "common", handle_schedule_mode, Draft, &[], true, true);
    define(r, "individual", handle_schedule_mode, Draft, &[], true, true);
    define(r, "publish", handle_now_ask, Draft, &[], true, false);
    define(r, "publish_confirm", handle_now_confirm, Draft, &[], true, true);
    define(r, "cancel", handle_cancel_ask, Draft, &[], true, false);
    // Reachable from a standalone reminder message, not only from the card,
    // so card freshness would reject a legitimate cancellation. The service
    // validates target state instead.
    define(r, "cancel_confirm", handle_cancel, Draft, &[], false, false);
    define(r, "time", handle_time, Draft, &["axis"], true, false);
    define(
        r,
        "sched_pick",
        handle_schedule_pick,
        Draft,
        &["axis", "clock"],
        true,
        true,
    );
    define(r, "sched_manual", handle_schedule_manual, Draft, &[], true, true);
    define(r, "sched_now", handle_schedule_now, Draft, &[], true, true);
    define(r, "sched_confirm", handle_schedule_confirm, Draft, &[], true, true);
    define(r, "remove_ask", handle_remove_ask, Draft, &["target"], true, false);
    define(r, "remove", handle_remove, Draft, &["target"], true, false);
    define(r, "edit_menu", handle_edit_menu, Draft, &[], true, false);
    define(r, "edit_field", handle_edit_field, Draft, &["field"], true, false);
    define(r, "edit_media", handle_edit_media, Draft, &[], true, false);
    define(r, "settle", handle_settle, Draft, &["target"], true, false);
}

fn studio_error(code: &str) -> crate::Error {
    StudioError::new(code).into()
}

/// `requireFlowStep`.
fn require_flow_step(session: Option<&VideoState>, allowed: &[&str], error_code: &str) -> crate::Result<()> {
    match session {
        Some(session) if allowed.contains(&session.step.as_str()) => Ok(()),
        _ => Err(studio_error(error_code)),
    }
}

fn video_targets(view: &VideoView) -> crate::Result<Vec<domain::publishing::video_types::VideoTarget>> {
    view.targets
        .iter()
        .map(|row| require_video_target(&row.target))
        .collect()
}

/// The draft's own conversation, on one of `steps`.
fn require_video_session(
    ctx: &Ctx,
    actor_id: i64,
    id: i64,
    steps: &[&str],
    error_code: &str,
) -> crate::Result<VideoState> {
    let session = get_video_state(ctx, actor_id)?
        .filter(|session| session.draft_id == Some(id))
        .ok_or_else(|| studio_error(error_code))?;
    require_flow_step(Some(&session), steps, error_code)?;
    Ok(session)
}

/// The draft's card, in place. Every action that ends on (or refreshes) the
/// same card ends here.
fn show_video_card(ctx: &Ctx, actor_id: i64, id: i64) -> Effects {
    Ok(card_effect(video_preview_card(ctx, actor_id, id)?))
}

/// A yes/no question on top of the draft's own card. "Back" always returns
/// to that card, so a declined confirmation costs the operator nothing.
fn video_confirmation_effect(
    context: &ActionContext<'_>,
    view: &str,
    revision: Option<i64>,
    target: Option<&str>,
) -> Effects {
    let card = render_card(
        context.ctx,
        PublicationKind::Video,
        &CardRequest {
            actor_id: context.actor_id,
            publication_id: context.draft_id(),
            view: Some(view.to_owned()),
            target: target.map(str::to_owned),
            revision,
        },
    )?;
    Ok(card_effect(card))
}

fn handle_cancel_dialog<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor) = (context.ctx, context.actor_id);
        let session = get_video_state(ctx, actor)?;
        clear_video_state(ctx, actor)?;
        // The draft exists once a video file was uploaded (even mid-wizard):
        // cancel returns to that draft's own card so nothing is orphaned.
        if let Some(draft_id) = session.and_then(|session| session.draft_id) {
            return show_video_card(ctx, actor, draft_id);
        }
        // Cancelling is navigation, not a content change: this same message
        // becomes the control panel.
        Ok(vec![Effect::MainMenu {
            text: main_menu_text(ctx, actor)?,
        }])
    })
}

/// "Upload it anyway" on the length question: the file the question was
/// asked about becomes the draft, so a second upload sent meanwhile cannot be
/// adopted by a stale button.
fn handle_length_confirm<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor) = (context.ctx, context.actor_id);
        let session = get_video_state(ctx, actor)?;
        require_flow_step(session.as_ref(), &["asset"], "err.video-restart")?;
        let session = session.ok_or_else(|| studio_error("err.video-restart"))?;
        let Some(asset_id) = session.data.get("assetId").and_then(Value::as_f64) else {
            return Err(studio_error("err.video-restart"));
        };
        start_video_draft(ctx, actor, &session, asset_id as i64)
    })
}

/// A skip of the game link or the script: the step accepts its empty answer
/// and the wizard goes on, after saying what was skipped.
fn skip_step(context: &ActionContext<'_>, step: &str, input: &str, notice: Key) -> Effects {
    let (ctx, actor) = (context.ctx, context.actor_id);
    let session = get_video_state(ctx, actor)?;
    require_flow_step(session.as_ref(), &[step], "err.video-reopen-create")?;
    let session = session
        .filter(|session| session.draft_id.is_some_and(|id| id != 0))
        .ok_or_else(|| studio_error("err.video-reopen-create"))?;
    let next = advance(
        ctx,
        actor,
        &session,
        json!(input),
        session.flow_data(),
        "err.video-reopen-create",
        None,
    )?;
    let mut effects = vec![Effect::screen(t(notice, &[]), Payload::new())];
    effects.extend(video_step_effects(ctx, actor, &next)?);
    Ok(effects)
}

fn handle_game_skip<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move { skip_step(context, "youtube_game_url", "-", Key::VideoGameSkipped) })
}

/// Moves past the script without one. Nothing is stored: a video with no
/// script is the ordinary case, not an empty script.
fn handle_script_skip<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move { skip_step(context, "script", "", Key::VideoScriptSkipped) })
}

fn selection(session: &VideoState) -> JsonObject {
    let mut data = Map::new();
    data.insert(
        "selectedTargets".into(),
        Value::Array(session.selected.iter().map(|target| target.as_str().into()).collect()),
    );
    data
}

fn handle_meta_back<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor) = (context.ctx, context.actor_id);
        let session = get_video_state(ctx, actor)?;
        let previous = session
            .as_ref()
            .and_then(|session| back_flow(&VIDEO_FLOW, &session.step, &selection(session)));
        let (Some(session), Some(previous)) = (
            session.filter(|session| session.draft_id.is_some_and(|id| id != 0)),
            previous,
        ) else {
            return Err(studio_error("err.video-reopen-create"));
        };
        let saved = save_video_state(
            ctx,
            actor,
            VideoStateInput {
                step: previous.to_owned(),
                ..session.input()
            },
        )?;
        video_step_effects(ctx, actor, &saved)
    })
}

fn handle_schedule_confirm<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor) = (context.ctx, context.actor_id);
        let session = require_video_session(
            ctx,
            actor,
            context.draft_id(),
            &["schedule_confirm"],
            "action.schedule-expired",
        )?;
        let Some(Value::Object(values)) = session.data.get("schedule") else {
            return Err(studio_error("action.schedule-expired"));
        };
        if !values.values().all(Value::is_string) {
            return Err(studio_error("action.schedule-expired"));
        }
        let schedule = values
            .iter()
            .map(|(target, value)| {
                let target = require_video_target(target)?;
                let at = parse_iso_instant(value.as_str().unwrap_or_default())
                    .map_err(|_| studio_error("action.schedule-expired"))?;
                Ok((target, at))
            })
            .collect::<crate::Result<Vec<_>>>()?;
        finish_video_schedule(ctx, actor, &session, &schedule).await
    })
}

fn handle_schedule_start<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor, id) = (context.ctx, context.actor_id, context.draft_id());
        let targets = video_targets(&ctx.services().videos.get(actor, id)?)?;
        if targets.is_empty() {
            return Err(studio_error("err.video-no-platforms"));
        }
        let session = save_video_state(
            ctx,
            actor,
            VideoStateInput {
                draft_id: Some(id),
                step: "schedule_choice".into(),
                selected: targets,
                data: Map::new(),
                control_message_id: None,
                revision: None,
            },
        )?;
        let keyboard = schedule_choice_keyboard(session.draft_id, session.revision, &session.selected)?;
        let time = time_settings(ctx, actor)?;
        Ok(vec![Effect::screen(
            t(Key::VideoScheduleTimeMsk, &[("timezone", &time.label)]),
            Payload::new().markdown().reply_markup(keyboard),
        )])
    })
}

fn handle_schedule_mode<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor, id) = (context.ctx, context.actor_id, context.draft_id());
        let session = require_video_session(ctx, actor, id, &["schedule_choice"], "err.video-reopen-publish")?;
        let targets = video_targets(&ctx.services().videos.get(actor, id)?)?;
        if targets.is_empty() {
            return Err(studio_error("err.video-reopen-publish"));
        }
        let mode = match context.action() {
            mode @ ("common" | "individual") => mode,
            _ => return Err(studio_error("err.video-reopen-publish")),
        };
        let mut data = session.data.clone();
        data.insert(
            "selectedTargets".into(),
            Value::Array(targets.iter().map(|target| target.as_str().into()).collect()),
        );
        let session = VideoState {
            data: data.clone(),
            selected: targets.clone(),
            ..session
        };
        let first = targets.first().copied();
        let decorate = |mut data: JsonObject, next: &str| -> crate::Result<JsonObject> {
            if next != "schedule_target" {
                return Ok(data);
            }
            let first = first.ok_or_else(|| studio_error("err.video-no-platforms"))?;
            data.insert("schedule".into(), json!({}));
            data.insert("target".into(), json!(first.as_str()));
            Ok(data)
        };
        let next = advance(
            ctx,
            actor,
            &session,
            json!(mode),
            data,
            "err.video-reopen-publish",
            Some(&decorate),
        )?;
        video_step_effects(ctx, actor, &next)
    })
}

fn handle_now_ask<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let session = save_video_state(
            context.ctx,
            context.actor_id,
            VideoStateInput {
                draft_id: Some(context.draft_id()),
                step: "schedule_confirm".into(),
                selected: Vec::new(),
                data: Map::new(),
                control_message_id: None,
                revision: None,
            },
        )?;
        video_confirmation_effect(context, "confirm_now", Some(session.revision), None)
    })
}

fn handle_now_confirm<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor) = (context.ctx, context.actor_id);
        let session = require_video_session(
            ctx,
            actor,
            context.draft_id(),
            &["schedule_confirm"],
            "action.schedule-expired",
        )?;
        finish_video_now(ctx, actor, &session).await
    })
}

fn handle_cancel_ask<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move { video_confirmation_effect(context, "confirm_cancel", None, None) })
}

fn handle_remove_ask<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let target = require_video_target(context.arg("target").unwrap_or_default())?;
        video_confirmation_effect(context, "confirm_remove", None, Some(target.as_str()))
    })
}

fn handle_cancel<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor) = (context.ctx, context.actor_id);
        let result = ctx.services().videos.cancel(actor, context.draft_id()).await?;
        clear_video_state(ctx, actor)?;
        let manual_removal = result
            .manual_removal
            .iter()
            .map(|removal| {
                let url = match removal.url.as_deref().filter(|url| !url.is_empty()) {
                    Some(url) => format!(": {url}"),
                    None => String::new(),
                };
                t(
                    Key::VideoRemoveManually,
                    &[("label", &video_target_label(&removal.target)), ("url", &url)],
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let held_private = if result.held_private_youtube_ids.is_empty() {
            String::new()
        } else {
            format!("\n{}", t(Key::VideoHeldPrivate, &[]))
        };
        let attention = if result.hold_failures.is_empty() {
            String::new()
        } else {
            format!("\n{}", t(Key::VideoHoldFailed, &[]))
        };
        let published = if manual_removal.is_empty() {
            String::new()
        } else {
            format!("\n\n{}\n{manual_removal}", t(Key::VideoAlreadyPublished, &[]))
        };
        let hours = domain::studio::config::studio_config(ctx.ports())
            .video()?
            .retention_hours;
        Ok(vec![Effect::screen(
            format!(
                "{}{held_private}{attention}{published}",
                t(Key::VideoCancelledLocal, &[("hours", &hours)])
            ),
            Payload::new().reply_markup(result_navigation_keyboard()),
        )])
    })
}

fn handle_time<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor) = (context.ctx, context.actor_id);
        let target = require_video_target(context.arg("axis").unwrap_or_default())?;
        let current = get_video_state(ctx, actor)?;
        let mut data = Map::new();
        data.insert("target".into(), json!(target.as_str()));
        let saved = save_video_state(
            ctx,
            actor,
            VideoStateInput {
                draft_id: Some(context.draft_id()),
                step: "schedule_target".into(),
                selected: vec![target],
                data,
                control_message_id: None,
                revision: current.map(|current| current.revision),
            },
        )?;
        video_step_effects(ctx, actor, &saved)
    })
}

fn handle_schedule_pick<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor, id) = (context.ctx, context.actor_id, context.draft_id());
        let session = require_video_session(ctx, actor, id, &SCHEDULE_SESSION_STEPS, "action.schedule-expired")?;
        // `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`, by UTF-16 units.
        let units: Vec<u16> = context.arg("clock").unwrap_or_default().encode_utf16().collect();
        let slice =
            |from: usize, to: usize| String::from_utf16_lossy(&units[from.min(units.len())..to.min(units.len())]);
        let value = ctx
            .services()
            .videos
            .slot_time(actor, &format!("{}:{}", slice(0, 2), slice(2, 4)))?;
        apply_video_schedule_date(ctx, actor, &session, value)
    })
}

fn handle_schedule_manual<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor) = (context.ctx, context.actor_id);
        require_video_session(
            ctx,
            actor,
            context.draft_id(),
            &SCHEDULE_SESSION_STEPS,
            "action.schedule-expired",
        )?;
        let time = time_settings(ctx, actor)?;
        let example = manual_schedule_example(&time.zone, ctx.now());
        Ok(vec![prompt_effect(
            ctx,
            PublicationKind::Video,
            &t(
                Key::VideoEnterDatetime,
                &[("timezone", &time.label), ("example", &example)],
            ),
            false,
        )?])
    })
}

/// "Send now" on a scheduling step answers the step the operator is on, not
/// the whole draft: in per-platform mode only the platform being scheduled
/// goes out immediately and the rest keep asking for their times.
fn handle_schedule_now<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor) = (context.ctx, context.actor_id);
        let session = require_video_session(
            ctx,
            actor,
            context.draft_id(),
            &SCHEDULE_SESSION_STEPS,
            "action.schedule-expired",
        )?;
        let now: Timestamp = ctx.services().videos.immediate_time();
        apply_video_schedule_date(ctx, actor, &session, now)
    })
}

fn handle_remove<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor, id) = (context.ctx, context.actor_id, context.draft_id());
        let target = require_video_target(context.arg("target").unwrap_or_default())?;
        if ctx.services().videos.remove_target(actor, id, target)?.cancelled {
            clear_video_state(ctx, actor)?;
            return Ok(vec![Effect::screen(
                t(Key::VideoAllRemoved, &[]),
                Payload::new().reply_markup(result_navigation_keyboard()),
            )]);
        }
        let mut effects = show_video_card(ctx, actor, id)?;
        effects.push(Effect::toast(t(Key::VideoRemoved, &[("label", &target.label())])));
        Ok(effects)
    })
}

fn handle_settle<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor, id) = (context.ctx, context.actor_id, context.draft_id());
        let target = require_video_target(context.arg("target").unwrap_or_default())?;
        let settled = ctx.services().videos.settle_target(actor, id, target).await?;
        let confirmed = settled.get("url").is_some_and(domain::json::truthy);
        let mut effects = show_video_card(ctx, actor, id)?;
        effects.push(Effect::toast(t(
            if confirmed {
                Key::VideoSettled
            } else {
                Key::VideoSettledUnconfirmed
            },
            &[],
        )));
        Ok(effects)
    })
}

fn handle_edit_menu<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor, id) = (context.ctx, context.actor_id, context.draft_id());
        let services = ctx.services();
        let videos = &services.videos;
        let details = videos.get(actor, id)?;
        let can_edit_label = matches!(details.draft.status.as_str(), "draft" | "editing");
        let targets = videos.metadata_editable_targets(actor, id)?;
        let mut keyboard = InlineKeyboard::new();
        for definition in &EDIT_FIELDS {
            let editable = match definition.target {
                Some(target) => targets.iter().any(|editable| editable.as_str() == target),
                None => can_edit_label,
            };
            if editable {
                keyboard = keyboard
                    .text(
                        t(definition.label, &[]),
                        publication_callback(PublicationKind::Video, "edit_field", &[&id, &definition.field], None)?,
                    )
                    .row();
            }
        }
        if videos.source_replaceable(actor, id)? {
            keyboard = keyboard
                .text(
                    t(Key::VideoEditMedia, &[]),
                    publication_callback(PublicationKind::Video, "edit_media", &[&id], None)?,
                )
                .row();
        }
        let keyboard = keyboard.text(
            t(Key::CommonBack, &[]),
            publication_callback(PublicationKind::Video, "view", &[&id, &"overview"], None)?,
        );
        Ok(vec![Effect::Screen {
            text: t(Key::VideoWhatToEdit, &[]),
            options: Payload::new().markdown().reply_markup(keyboard),
            card: Some(CardRef::Video { draft_id: id }),
        }])
    })
}

/// Opens one field of a finished draft for a single answer.
fn open_single_edit(context: &ActionContext<'_>, step: &str, prompt: Key) -> Effects {
    let (ctx, actor, id) = (context.ctx, context.actor_id, context.draft_id());
    let selected = video_targets(&ctx.services().videos.get(actor, id)?)?;
    let mut data = Map::new();
    data.insert("is_single_edit".into(), Value::Bool(true));
    save_video_state(
        ctx,
        actor,
        VideoStateInput {
            draft_id: Some(id),
            step: step.to_owned(),
            selected,
            data,
            control_message_id: None,
            revision: None,
        },
    )?;
    Ok(vec![prompt_effect(
        ctx,
        PublicationKind::Video,
        &t(prompt, &[]),
        false,
    )?])
}

fn handle_edit_field<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let field = context.arg("field").unwrap_or_default();
        let Some(definition) = EDIT_FIELDS.iter().find(|definition| definition.field == field) else {
            return Err(studio_error("err.video-reopen-edit"));
        };
        // Every field is a step of the flow: the answer is parsed by the same
        // transition the wizard uses.
        if !is_video_step(field) {
            return Err(studio_error("err.video-reopen-edit"));
        }
        open_single_edit(context, field, definition.prompt)
    })
}

/// Asks for a replacement upload. The answer is a file rather than text, so
/// the session waits on the same `asset` step the wizard uses.
fn handle_edit_media<'a>(context: &'a ActionContext<'a>) -> Fut<'a, Effects> {
    Box::pin(async move {
        let (ctx, actor, id) = (context.ctx, context.actor_id, context.draft_id());
        if !ctx.services().videos.source_replaceable(actor, id)? {
            return Err(studio_error("err.video-source-locked"));
        }
        open_single_edit(context, "asset", Key::VideoEditMediaPrompt)
    })
}
