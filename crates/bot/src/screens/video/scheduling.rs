//! Scheduling a video (`bot/video-scheduling.ts`): one chosen time applied to
//! whichever scheduling step the session is on, and the confirmed schedule
//! rendered as the final card.

use domain::application::ports::JsonObject;
use domain::publishing::video_types::{VideoTarget, VideoTechnicalCheck};
use domain::studio::video_fsm::video_schedule_dates;
use foundation::errors::StudioError;
use foundation::i18n::{Key, t};
use foundation::js::number_to_string;
use foundation::time::to_iso_string;
use jiff::Timestamp;
use serde_json::{Value, json};

use crate::api::payload::Payload;
use crate::context::Ctx;
use crate::effects::{CardRef, Effect};

use super::preview::video_preview_card;
use super::state::{
    VideoState, advance, clear_video_state, video_duration_label, video_schedule_confirmation_effects,
    video_step_effects,
};

type Effects = crate::Result<Vec<Effect>>;

fn require_draft(session: &VideoState) -> crate::Result<i64> {
    session
        .draft_id
        .filter(|id| *id != 0)
        .ok_or_else(|| StudioError::new("err.video-missing").into())
}

/// `applyVideoScheduleDate`: slot buttons and a typed date advance
/// identically, so the flow decides what comes next and neither caller
/// recomputes the remaining platforms.
pub fn apply_video_schedule_date(ctx: &Ctx, actor_id: i64, session: &VideoState, date: Timestamp) -> Effects {
    if session.draft_id.is_none() {
        return Err(StudioError::new("err.video-missing").into());
    }
    let next = advance(
        ctx,
        actor_id,
        session,
        json!(to_iso_string(date)),
        session.flow_data(),
        "err.video-reopen-publish",
        None,
    )?;
    if next.step == "schedule_target" {
        return video_step_effects(ctx, actor_id, &next);
    }
    let schedule = match next.data.get("schedule") {
        Some(Value::Object(schedule)) => schedule.clone(),
        _ => JsonObject::new(),
    };
    video_schedule_confirmation_effects(ctx, actor_id, &next, &video_schedule_dates(&schedule)?)
}

pub async fn finish_video_schedule(
    ctx: &Ctx,
    actor_id: i64,
    session: &VideoState,
    schedule: &[(VideoTarget, Timestamp)],
) -> Effects {
    let draft_id = require_draft(session)?;
    let technical = ctx.services().videos.schedule(actor_id, draft_id, schedule).await?;
    show_scheduled_video(ctx, actor_id, draft_id, &technical)
}

/// Telegram only renders the result; the immediate scheduling policy lives
/// in Video Studio.
pub async fn finish_video_now(ctx: &Ctx, actor_id: i64, session: &VideoState) -> Effects {
    let draft_id = require_draft(session)?;
    let technical = ctx.services().videos.publish(actor_id, draft_id).await?;
    show_scheduled_video(ctx, actor_id, draft_id, &technical)
}

/// The transport-neutral technical check as a Telegram summary line.
fn video_check_summary(technical: &VideoTechnicalCheck) -> String {
    let no_audio = t(Key::VideoNoAudio, &[]);
    let audio_codec = technical.audio_codec.as_deref().unwrap_or(&no_audio);
    let has_audio = technical.audio_codec.as_deref().is_some_and(|codec| !codec.is_empty());
    let fps = if technical.fps != 0.0 && !technical.fps.is_nan() {
        // `toFixed(0)`: ties of a positive rate round up, as `round` does.
        format!("{} FPS", number_to_string(technical.fps.round()))
    } else {
        t(Key::VideoFpsUnknown, &[])
    };
    t(
        Key::VideoCheckSummary,
        &[
            (
                "dims",
                &format!(
                    "{}×{}",
                    number_to_string(technical.width),
                    number_to_string(technical.height)
                ),
            ),
            ("dur", &video_duration_label(technical.seconds)),
            (
                "codecs",
                &format!(
                    "{}/{}",
                    technical.video_codec.to_uppercase(),
                    audio_codec.to_uppercase()
                ),
            ),
            (
                "sound",
                &if has_audio {
                    t(Key::VideoHasAudio, &[])
                } else {
                    no_audio.clone()
                },
            ),
            ("fps", &fps),
            (
                "mb",
                &number_to_string((technical.size_bytes as f64 / 1024.0 / 1024.0).ceil()),
            ),
        ],
    )
}

fn show_scheduled_video(ctx: &Ctx, actor_id: i64, draft_id: i64, technical: &VideoTechnicalCheck) -> Effects {
    let preview = video_preview_card(ctx, actor_id, draft_id)?;
    let reminder_minutes = ctx.services().settings.notifications(actor_id)?.reminder_minutes;
    let warning = if technical.aspect_ok {
        String::new()
    } else {
        format!("\n{}", t(Key::VideoAspectWarning, &[]))
    };
    let text = format!(
        "{}{warning}\n\n✅ {}. {}\n\n{}",
        video_check_summary(technical),
        t(Key::CommonScheduled, &[]),
        t(Key::VideoReminder, &[("minutes", &reminder_minutes)]),
        preview.text
    );
    clear_video_state(ctx, actor_id)?;
    Ok(vec![
        Effect::screen(format!("✅ {}", t(Key::VideoConfirmedCard, &[])), Payload::new()),
        Effect::Screen {
            text,
            options: Payload::new().markdown().reply_markup(preview.keyboard),
            card: Some(CardRef::Video { draft_id }),
        },
    ])
}
