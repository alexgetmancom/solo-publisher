//! The video conversation's state and the screens it asks with
//! (`bot/video-ui.ts`): every path that advances the wizard -- a typed message
//! or a tapped control -- ends on [`video_step_effects`] with the step the
//! transition produced, so no caller decides which question comes next.

use domain::application::conversation_flow::{PublicationKind, accept_flow, back_flow};
use domain::application::ports::{ConversationSessionKind, JsonObject};
use domain::publishing::video_types::VideoTarget;
use domain::studio::video_fsm::{VIDEO_FLOW, VideoWizardStep, is_video_wizard_step};
use foundation::errors::StudioError;
use foundation::i18n::{Key, t};
use foundation::js::number_to_string;
use foundation::time::{Zone, format_zoned_locale_string, manual_schedule_example};
use jiff::Timestamp;
use serde_json::{Map, Value};

use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::{ScreenId, publication_callback, screen_callback};
use crate::context::Ctx;
use crate::dialog_ui::{DialogButton, append_cancel_button, append_confirmation_row, prompt_effect};
use crate::effects::{CardRef, Effect};
use crate::publication::scheduling::{
    SCHEDULE_SLOT_PRESETS, ScheduleAxis, ScheduleButton, ScheduleConfirmation, ScheduleEngine,
    schedule_confirmation_effects, schedule_time_keyboard,
};
use crate::publication::{advance_flow, delivery_previews};
use crate::session::{ConversationState, ConversationStateInput};

type Effects = crate::Result<Vec<Effect>>;

/// `VideoConversationState`: the conversation row with its step known to be
/// one of the flow's and the platforms it schedules.
#[derive(Clone, Debug, PartialEq)]
pub struct VideoState {
    pub draft_id: Option<i64>,
    pub step: String,
    pub selected: Vec<VideoTarget>,
    pub data: JsonObject,
    pub control_message_id: Option<i64>,
    pub revision: i64,
}

/// `VideoConversationInput`: what a save writes; `revision`, when given, must
/// still be the stored one.
pub struct VideoStateInput {
    pub draft_id: Option<i64>,
    pub step: String,
    pub selected: Vec<VideoTarget>,
    pub data: JsonObject,
    pub control_message_id: Option<i64>,
    pub revision: Option<i64>,
}

impl VideoState {
    /// The same session, saved again as it is (`{ ...session, … }`).
    pub fn input(&self) -> VideoStateInput {
        VideoStateInput {
            draft_id: self.draft_id,
            step: self.step.clone(),
            selected: self.selected.clone(),
            data: self.data.clone(),
            control_message_id: self.control_message_id,
            revision: Some(self.revision),
        }
    }

    fn conversation(&self) -> ConversationState {
        ConversationState {
            kind: ConversationSessionKind::Video,
            draft_id: self.draft_id,
            step: self.step.clone(),
            data: self.data.clone(),
            control_message_id: self.control_message_id,
            revision: self.revision,
        }
    }

    pub fn single_edit(&self) -> bool {
        self.data.get("is_single_edit").is_some_and(domain::json::truthy)
    }

    /// `{ ...session.data, selectedTargets: session.selected }`: what the flow
    /// reads its transitions from.
    pub fn flow_data(&self) -> JsonObject {
        with_selected(&self.data, &self.selected)
    }
}

fn target_names(targets: &[VideoTarget]) -> Value {
    Value::Array(targets.iter().map(|target| target.as_str().into()).collect())
}

fn with_selected(data: &JsonObject, selected: &[VideoTarget]) -> JsonObject {
    let mut data = data.clone();
    data.insert("selectedTargets".into(), target_names(selected));
    data
}

/// `{ selectedTargets }` alone, which is all a step's `back` reads.
fn selection(selected: &[VideoTarget]) -> JsonObject {
    with_selected(&Map::new(), selected)
}

/// `parseVideoStep`.
pub fn is_video_step(value: &str) -> bool {
    VIDEO_FLOW.steps.iter().any(|step| step.name == value)
}

pub fn require_video_target(value: &str) -> crate::Result<VideoTarget> {
    VideoTarget::parse(value).ok_or_else(|| StudioError::new("err.unknown-platform").into())
}

/// `parseSelectedTargets`: an array of distinct known targets.
fn parse_selected_targets(value: &Value) -> Option<Vec<VideoTarget>> {
    let Value::Array(values) = value else {
        return None;
    };
    let targets: Vec<VideoTarget> = values
        .iter()
        .map(|value| value.as_str().and_then(VideoTarget::parse))
        .collect::<Option<_>>()?;
    let distinct = targets
        .iter()
        .enumerate()
        .all(|(index, target)| !targets[..index].contains(target));
    distinct.then_some(targets)
}

/// `getVideoState`: a row whose step or selection no longer parses is retired.
pub fn get_video_state(ctx: &Ctx, actor_id: i64) -> crate::Result<Option<VideoState>> {
    let Some(state) = ctx.sessions().get(actor_id, ConversationSessionKind::Video)? else {
        return Ok(None);
    };
    if !is_video_step(&state.step) {
        clear_video_state(ctx, actor_id)?;
        return Ok(None);
    }
    let selected = match state.data.get("selectedTargets") {
        None => Some(Vec::new()),
        Some(value) => parse_selected_targets(value),
    };
    let Some(selected) = selected else {
        clear_video_state(ctx, actor_id)?;
        return Ok(None);
    };
    Ok(Some(VideoState {
        draft_id: state.draft_id,
        step: state.step,
        selected,
        data: state.data,
        control_message_id: state.control_message_id,
        revision: state.revision,
    }))
}

/// `saveVideoState`.
pub fn save_video_state(ctx: &Ctx, actor_id: i64, input: VideoStateInput) -> crate::Result<VideoState> {
    let data = with_selected(&input.data, &input.selected);
    let saved = ctx.sessions().save(
        actor_id,
        &ConversationStateInput {
            kind: ConversationSessionKind::Video,
            draft_id: input.draft_id,
            step: input.step.clone(),
            data,
            control_message_id: input.control_message_id,
            revision: input.revision,
        },
    )?;
    Ok(VideoState {
        draft_id: saved.draft_id,
        step: input.step,
        selected: input.selected,
        data: saved.data,
        control_message_id: saved.control_message_id,
        revision: saved.revision,
    })
}

pub fn clear_video_state(ctx: &Ctx, actor_id: i64) -> crate::Result<()> {
    Ok(ctx.sessions().clear(actor_id, ConversationSessionKind::Video)?)
}

/// What a transition adds to the data once it knows the step it leads to.
pub type Decorate<'a> = &'a dyn Fn(JsonObject, &str) -> crate::Result<JsonObject>;

/// `advancePublicationFlow` over the video flow: the step accepts `input`,
/// the dialog moves to the step it names and consumes one session revision.
pub fn advance(
    ctx: &Ctx,
    actor_id: i64,
    session: &VideoState,
    input: Value,
    data: JsonObject,
    error_code: &str,
    decorate: Option<Decorate>,
) -> crate::Result<VideoState> {
    let transition = accept_flow(&VIDEO_FLOW, &session.step, input, data)?;
    let Some((next, data)) = transition.and_then(|transition| transition.next.map(|next| (next, transition.data)))
    else {
        return Err(StudioError::new(error_code).into());
    };
    let data = match decorate {
        Some(decorate) => decorate(data, next)?,
        None => data,
    };
    let saved = advance_flow(ctx, actor_id, &session.conversation(), Some(next), data, error_code)?;
    Ok(VideoState {
        draft_id: saved.draft_id,
        step: saved.step,
        selected: session.selected.clone(),
        data: saved.data,
        control_message_id: saved.control_message_id,
        revision: saved.revision,
    })
}

/// `mm:ss`, the one way a clip's length is written to the operator.
pub fn video_duration_label(seconds: f64) -> String {
    format!(
        "{:0>2}:{:0>2}",
        number_to_string((seconds / 60.0).floor()),
        number_to_string(seconds % 60.0)
    )
}

pub fn video_target_label(target: &str) -> String {
    VideoTarget::parse(target).map_or_else(|| target.to_owned(), |target| target.label().to_owned())
}

pub(super) struct TimeSettings {
    pub label: String,
    pub zone: Zone,
}

pub(super) fn time_settings(ctx: &Ctx, actor_id: i64) -> crate::Result<TimeSettings> {
    let config = ctx.services().settings.time_config(actor_id)?;
    let zone = Zone::parse(&config.timezone)
        .ok_or_else(|| crate::error(format!("Invalid time zone specified: {}", config.timezone)))?;
    Ok(TimeSettings {
        label: config.timezone_label,
        zone,
    })
}

/// `videoStepEffects`: whatever the flow's current step asks the operator for.
pub fn video_step_effects(ctx: &Ctx, actor_id: i64, session: &VideoState) -> Effects {
    let time = time_settings(ctx, actor_id)?;
    let example = || manual_schedule_example(&time.zone, ctx.now());
    if let Some(step) = VideoWizardStep::parse(&session.step) {
        return metadata_prompt_effects(step, session);
    }
    match session.step.as_str() {
        "schedule_choice" => Ok(video_control_effects(
            session,
            t(Key::VideoSavedChooseSchedule, &[("timezone", &time.label)]),
            schedule_choice_keyboard(session.draft_id, session.revision, &session.selected)?,
        )),
        "schedule_common" => video_time_effects(
            session,
            t(
                Key::VideoEnterDatetime,
                &[("timezone", &time.label), ("example", &example())],
            ),
        ),
        "schedule_target" => {
            // The step schedules one of the targets the operator picked, so a
            // target outside the selection means the session drifted from its
            // buttons.
            let target = session
                .data
                .get("target")
                .and_then(Value::as_str)
                .and_then(VideoTarget::parse)
                .filter(|target| session.selected.contains(target))
                .ok_or_else(|| StudioError::new("err.video-restart"))?;
            video_time_effects(
                session,
                t(
                    Key::VideoScheduleTargetPrompt,
                    &[
                        ("target", &target.label()),
                        ("timezone", &time.label),
                        ("example", &example()),
                    ],
                ),
            )
        }
        "script" => script_prompt_effects(session),
        _ => Err(StudioError::new("err.video-restart").into()),
    }
}

fn video_callback(action: &str, args: &[&dyn std::fmt::Display], revision: Option<i64>) -> crate::Result<String> {
    Ok(publication_callback(PublicationKind::Video, action, args, revision)?)
}

fn cancel_dialog_callback() -> crate::Result<String> {
    video_callback("cancel_dialog", &[], None)
}

/// The one question of the wizard that is allowed to go unanswered: a video
/// can be published without its script, and most of the archive was.
fn script_prompt_effects(session: &VideoState) -> Effects {
    let keyboard = InlineKeyboard::new().text(
        t(Key::VideoSkip, &[]),
        video_callback("script_skip", &[], Some(session.revision))?,
    );
    let keyboard = append_cancel_button(keyboard, &cancel_dialog_callback()?, Some(session.revision));
    Ok(vec![Effect::screen(
        t(Key::VideoPromptScript, &[]),
        Payload::new().reply_markup(keyboard),
    )])
}

/// `videoErrorEffects`: an unusable value is answered with the same question,
/// carrying the same controls -- the flow's Back among them. Steps that are
/// not a question of the flow's own (the upload, the rename from the card, a
/// field edited on its own) keep the plain prompt: their way back is the
/// cancel that returns to the card.
pub fn video_error_effects(ctx: &Ctx, actor_id: i64, session: &VideoState, message: &str) -> Effects {
    let rerenders = !session.single_edit()
        && (is_video_wizard_step(&session.step)
            || matches!(session.step.as_str(), "schedule_common" | "schedule_target"));
    if !rerenders {
        return Ok(vec![prompt_effect(ctx, PublicationKind::Video, message, true)?]);
    }
    let mut effects = video_step_effects(ctx, actor_id, session)?;
    match effects.first_mut() {
        Some(Effect::Screen { text, .. }) => *text = format!("{message}\n\n{text}"),
        _ => return Err(StudioError::new("err.video-restart").into()),
    }
    Ok(effects)
}

fn metadata_prompt_effects(step: VideoWizardStep, session: &VideoState) -> Effects {
    let revision = Some(session.revision);
    let mut keyboard = InlineKeyboard::new();
    if step == VideoWizardStep::YoutubeGameUrl {
        keyboard = keyboard.text(t(Key::VideoSkip, &[]), video_callback("game_skip", &[], revision)?);
    }
    if back_flow(&VIDEO_FLOW, step.as_str(), &selection(&session.selected)).is_some() {
        keyboard = keyboard.text(t(Key::CommonBack, &[]), video_callback("meta_back", &[], revision)?);
    }
    let keyboard = append_cancel_button(keyboard, &cancel_dialog_callback()?, revision);
    let prompt = match step {
        VideoWizardStep::YoutubeTitle => Key::VideoPromptYtTitle,
        VideoWizardStep::YoutubeDescription => Key::VideoPromptYtDescription,
        VideoWizardStep::YoutubeGameUrl => Key::VideoPromptYtGameUrl,
        VideoWizardStep::YoutubeTags => Key::VideoPromptYtTags,
        VideoWizardStep::InstagramCaption => Key::VideoPromptIgCaption,
    };
    Ok(vec![Effect::screen(
        t(prompt, &[]),
        Payload::new().reply_markup(keyboard),
    )])
}

/// `videoControlEffects`: a control screen, bound as the draft's card once
/// there is a draft.
fn video_control_effects(session: &VideoState, text: String, keyboard: InlineKeyboard) -> Vec<Effect> {
    vec![Effect::Screen {
        text,
        options: Payload::new().markdown().reply_markup(keyboard),
        card: session.draft_id.map(|draft_id| CardRef::Video { draft_id }),
    }]
}

fn target_keys(targets: &[VideoTarget]) -> Vec<&'static str> {
    targets.iter().map(|target| target.as_str()).collect()
}

fn video_time_effects(session: &VideoState, text: String) -> Effects {
    let draft_id = session.draft_id.ok_or_else(|| StudioError::new("err.video-missing"))?;
    let keys = target_keys(&session.selected);
    let engine = ScheduleEngine {
        kind: PublicationKind::Video,
        publication_id: draft_id,
        axis_keys: &keys,
        slot_values: &SCHEDULE_SLOT_PRESETS,
    };
    let axis = ScheduleAxis {
        values: engine.slot_values,
        label: &|clock| clock.to_owned(),
        callback: &|clock| engine.axis_callback(clock),
    };
    let keyboard = schedule_time_keyboard(
        &axis,
        Some(session.revision),
        // Emitted here rather than from the shared engine: sending on the
        // spot is something the video pipeline can do and the post one cannot.
        Some(ScheduleButton {
            label: t(Key::VideoSendNowBtn, &[]),
            callback: video_callback("sched_now", &[&draft_id], None)?,
        }),
        ScheduleButton {
            label: t(Key::VideoEnterTimeBtn, &[]),
            callback: engine.manual_callback(None)?,
        },
        ScheduleButton {
            label: t(Key::CommonCancel, &[]),
            callback: cancel_dialog_callback()?,
        },
    )?;
    Ok(video_control_effects(session, text, keyboard))
}

/// One time for every platform, or one each. Built here for both ways in: the
/// wizard's own step and "📅 Schedule" on a finished draft's card.
pub fn schedule_choice_keyboard(
    draft_id: Option<i64>,
    revision: i64,
    selected: &[VideoTarget],
) -> crate::Result<InlineKeyboard> {
    let draft_id = draft_id.ok_or_else(|| StudioError::new("err.video-missing"))?;
    let revision = Some(revision);
    let mut keyboard = InlineKeyboard::new().text(
        t(Key::VideoSameTime, &[]),
        video_callback("common", &[&draft_id], revision)?,
    );
    if selected.len() > 1 {
        keyboard = keyboard.row().text(
            t(Key::VideoDifferentTime, &[]),
            video_callback("individual", &[&draft_id], revision)?,
        );
    }
    Ok(append_cancel_button(
        keyboard.row(),
        &cancel_dialog_callback()?,
        revision,
    ))
}

/// `videoScheduleConfirmationEffects`: the per-target summary with its
/// confirm/back keyboard, for a session already on `schedule_confirm`. Shared
/// because the schedule is completed from slot buttons and from a typed date,
/// and both must land on the identical confirmation.
pub fn video_schedule_confirmation_effects(
    ctx: &Ctx,
    actor_id: i64,
    session: &VideoState,
    schedule: &[(VideoTarget, Timestamp)],
) -> Effects {
    let draft_id = session
        .draft_id
        .filter(|id| *id != 0)
        .ok_or_else(|| StudioError::new("err.video-missing"))?;
    let services = ctx.services();
    let videos = &services.videos;
    let time = time_settings(ctx, actor_id)?;
    let entries: Vec<(String, Timestamp)> = session
        .selected
        .iter()
        .filter_map(|target| {
            schedule
                .iter()
                .find(|(key, _)| key == target)
                .map(|(_, at)| (target.as_str().to_owned(), *at))
        })
        .collect();
    let keys = target_keys(&session.selected);
    let engine = ScheduleEngine {
        kind: PublicationKind::Video,
        publication_id: draft_id,
        axis_keys: &keys,
        slot_values: &[],
    };
    // The clip itself is not in the previews -- it is the same file for every
    // platform -- so the one button that shows it sits beside the confirmation.
    let keyboard = InlineKeyboard::new()
        .text(
            t(Key::VideoShowSource, &[]),
            screen_callback(ScreenId::DeliveryPreviewVideo, &[&draft_id])?,
        )
        .row();
    let (confirm_label, back_label) = (t(Key::CommonConfirm, &[]), t(Key::CommonBack, &[]));
    let (confirm, back) = (
        engine.confirm_callback()?,
        video_callback("schedule", &[&draft_id], None)?,
    );
    let keyboard = append_confirmation_row(
        keyboard,
        DialogButton {
            label: &confirm_label,
            callback: &confirm,
        },
        DialogButton {
            label: &back_label,
            callback: &back,
        },
        Some(session.revision),
    );
    // A time asked for immediately reads as a stamp a minute out, which says
    // nothing about what the operator chose. Name it instead.
    let format_value = |value: Timestamp| {
        if videos.is_immediate(value) {
            t(Key::VideoNowLabel, &[])
        } else {
            format!("{} {}", format_zoned_locale_string(value, &time.zone), time.label)
        }
    };
    let projections = videos.preview(actor_id, draft_id)?.delivery.projections;
    Ok(schedule_confirmation_effects(ScheduleConfirmation {
        kind: PublicationKind::Video,
        publication_id: draft_id,
        intro: None,
        title: t(Key::CommonConfirmSchedule, &[]),
        title_prefix: "🎬",
        entries,
        label: &video_target_label,
        format_value: &format_value,
        keyboard,
        effects: vec![delivery_previews::effect(projections)],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_read_as_minutes_and_seconds() {
        assert_eq!(video_duration_label(95.0), "01:35");
        assert_eq!(video_duration_label(5.0), "00:05");
        assert_eq!(video_duration_label(600.0), "10:00");
    }

    #[test]
    fn a_selection_is_distinct_known_targets() {
        assert_eq!(
            parse_selected_targets(&serde_json::json!(["youtube_shorts"])),
            Some(vec![VideoTarget::YoutubeShorts])
        );
        assert_eq!(
            parse_selected_targets(&serde_json::json!(["youtube_shorts", "youtube_shorts"])),
            None
        );
        assert_eq!(parse_selected_targets(&serde_json::json!(["tiktok"])), None);
        assert_eq!(parse_selected_targets(&serde_json::json!("youtube_shorts")), None);
    }
}
