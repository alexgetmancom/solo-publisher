//! The video card (`interfaces/telegram/video-preview.ts`, `video-time.ts`,
//! the video half of `bot/publication-renderers.ts`) and the source preview
//! the schedule confirmation offers (`sendVideoSourcePreview`).

use domain::application::conversation_flow::PublicationKind;
use domain::application::ports::{JsonObject, StudioVideoDraftRecord, StudioVideoTargetRecord};
use domain::json::{js_string, truthy};
use domain::publishing::state::{
    is_audience_mutation_retryable, is_video_target_editable, is_video_target_metadata_editable,
    is_video_target_schedulable,
};
use domain::publishing::video_types::{VIDEO_TARGETS, VideoTarget};
use foundation::i18n::{Key, t};
use foundation::markdown::escape_markdown;
use foundation::time::{format_zoned_date_time, parse_iso_instant};
use serde_json::Value;

use crate::Fut;
use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::{ScreenCallback, ScreenId, publication_callback, screen, screen_number};
use crate::context::Ctx;
use crate::dialog_ui::{DialogButton, confirmation_keyboard};
use crate::publication::delivery_previews::media_source;
use crate::publication::{CardRequest, PublicationCard};

use super::state::{TimeSettings, time_settings};

/// Every screen a video card can show.
const VIDEO_VIEWS: [&str; 4] = ["overview", "confirm_now", "confirm_cancel", "confirm_remove"];

/// The card renderer of the video kind.
pub fn render_card(ctx: &Ctx, request: &CardRequest) -> crate::Result<PublicationCard> {
    let time = time_settings(ctx, request.actor_id)?;
    let preview = ctx
        .services()
        .videos
        .preview(request.actor_id, request.publication_id)?;
    let view = request
        .view
        .as_deref()
        .filter(|view| VIDEO_VIEWS.contains(view))
        .unwrap_or("overview");
    let target = request.target.as_deref().and_then(VideoTarget::parse);
    let (text, keyboard) = video_preview(&preview.draft, &preview.targets, &time, view, request.revision, target)?;
    Ok(PublicationCard {
        kind: PublicationKind::Video,
        draft_id: request.publication_id,
        text,
        keyboard,
        view: None,
    })
}

/// `videoPreviewCard`: the card as every Telegram path renders it.
pub fn video_preview_card(ctx: &Ctx, actor_id: i64, draft_id: i64) -> crate::Result<PublicationCard> {
    render_card(
        ctx,
        &CardRequest {
            actor_id,
            publication_id: draft_id,
            ..CardRequest::default()
        },
    )
}

fn video_callback(action: &str, args: &[&dyn std::fmt::Display]) -> crate::Result<String> {
    Ok(publication_callback(PublicationKind::Video, action, args, None)?)
}

/// `videoPreview`: the draft, one section per platform it has, and the
/// controls for what can still be done to it.
fn video_preview(
    draft: &StudioVideoDraftRecord,
    targets: &[StudioVideoTargetRecord],
    time: &TimeSettings,
    view: &str,
    revision: Option<i64>,
    target: Option<VideoTarget>,
) -> crate::Result<(String, InlineKeyboard)> {
    let title = if draft.label.is_empty() {
        t(Key::VpreviewTitleFallback, &[])
    } else {
        draft.label.clone()
    };
    let mut lines = vec![
        format!("🎬 *{}*", escape_markdown(&title)),
        format!("{}: *{}*", t(Key::VpreviewLanguage, &[]), draft.locale.to_uppercase()),
        format!(
            "{}: *{}*",
            t(Key::VpreviewStatus, &[]),
            video_status_label(&draft.status)
        ),
    ];
    let mut keyboard = InlineKeyboard::new();
    let id = draft.id;
    // One pass over the platforms this publication has, in catalogue order:
    // the controls are the same question for each of them.
    for target in VIDEO_TARGETS {
        let Some(row) = targets.iter().find(|candidate| candidate.target == target.as_str()) else {
            continue;
        };
        let label: [(&str, &dyn std::fmt::Display); 1] = [("target", &target.label())];
        lines.push(String::new());
        lines.extend(target_lines(target, &row.metadata_json));
        let scheduled = match row.scheduled_at.as_deref().filter(|at| !at.is_empty()) {
            Some(at) => format!(" · {}", format_video_time(at, time)?),
            None => String::new(),
        };
        lines.push(format!(
            "{}: {}{scheduled}",
            t(Key::VpreviewState, &[]),
            video_status_label(&row.status)
        ));
        let mut controls = 0;
        let mut control = |keyboard: InlineKeyboard, text: String, callback: String| {
            controls += 1;
            keyboard.text(text, callback)
        };
        if is_video_target_schedulable(&row.status) {
            keyboard = control(
                keyboard,
                t(Key::VpreviewTime, &label),
                video_callback("time", &[&id, &target.as_str()])?,
            );
        }
        if is_video_target_editable(&row.status) {
            keyboard = control(
                keyboard,
                t(Key::VpreviewRemove, &label),
                video_callback("remove_ask", &[&id, &target.as_str()])?,
            );
        }
        if is_audience_mutation_retryable(&row.status) {
            keyboard = control(
                keyboard,
                t(Key::VpreviewRetry, &label),
                video_callback("retry", &[&id, &target.as_str(), &"card"])?,
            );
        }
        // A publication that lost its worker cannot be retried -- nobody knows
        // whether it landed -- but a provider route can be asked, because the
        // same fenced request returns the post it already has.
        if row.status == "verification_required" && row.delivery_provider == "zernio" {
            keyboard = control(
                keyboard,
                t(Key::VpreviewSettle, &label),
                video_callback("settle", &[&id, &target.as_str()])?,
            );
        }
        if controls > 0 {
            keyboard = keyboard.row();
        }
    }
    let text = lines.join("\n");
    if view != "overview" {
        return confirmation_preview(id, text, view, revision, target);
    }
    // Publishing now and scheduling are the same pair of choices a text post
    // offers on its own card.
    let status = draft.status.as_str();
    if !targets.is_empty() && matches!(status, "draft" | "editing") {
        keyboard = keyboard
            .text(t(Key::PostPublishNowBtn, &[]), video_callback("publish", &[&id])?)
            .row()
            .text(t(Key::PostScheduleBtn, &[]), video_callback("schedule", &[&id])?)
            .row();
    }
    if matches!(status, "draft" | "editing" | "scheduled")
        && targets
            .iter()
            .any(|target| is_video_target_metadata_editable(&target.status))
    {
        keyboard = keyboard
            .text(t(Key::VpreviewEditDetails, &[]), video_callback("edit_menu", &[&id])?)
            .row();
    }
    // Nothing left to cancel once it is cancelled.
    if status != "cancelled" {
        keyboard = keyboard
            .text(t(Key::VpreviewCancelPub, &[]), video_callback("cancel", &[&id])?)
            .row();
    }
    Ok((
        text,
        keyboard.text(t(Key::QueueBackBtn, &[]), screen(ScreenId::QueueHome)),
    ))
}

/// `metadata.<key>`, when truthy, as text.
fn field(metadata: &JsonObject, key: &str) -> Option<String> {
    metadata.get(key).filter(|value| truthy(value)).map(js_string)
}

/// The fields one platform carries, as its own card section.
fn target_lines(target: VideoTarget, metadata: &JsonObject) -> Vec<String> {
    if target == VideoTarget::YoutubeShorts {
        let mut lines = vec![
            "▶️ *YouTube Shorts*".to_owned(),
            format!(
                "{}: {}",
                t(Key::VpreviewYtTitleLabel, &[]),
                escape_markdown(&field(metadata, "title").unwrap_or_else(|| "—".into()))
            ),
        ];
        if let Some(description) = field(metadata, "description") {
            lines.push(format!(
                "{}: {}",
                t(Key::VpreviewDescription, &[]),
                escape_markdown(&description)
            ));
        }
        if let Some(game) = field(metadata, "gameUrl") {
            lines.push(format!("{}: {}", t(Key::VpreviewGame, &[]), escape_markdown(&game)));
        }
        if let Some(Value::Array(tags)) = metadata.get("tags")
            && !tags.is_empty()
        {
            let tags: Vec<String> = tags.iter().map(js_string).collect();
            lines.push(format!(
                "{}: {}",
                t(Key::VpreviewTags, &[]),
                escape_markdown(&tags.join(", "))
            ));
        }
        return lines;
    }
    vec![
        "📸 *Instagram Reels*".to_owned(),
        format!(
            "{}: {}",
            t(Key::VpreviewDescription, &[]),
            escape_markdown(&field(metadata, "caption").unwrap_or_else(|| "—".into()))
        ),
    ]
}

fn confirmation_preview(
    id: i64,
    overview: String,
    view: &str,
    revision: Option<i64>,
    target: Option<VideoTarget>,
) -> crate::Result<(String, InlineKeyboard)> {
    let back_label = t(Key::CommonBack, &[]);
    let back = video_callback("view", &[&id, &"overview"])?;
    let keyboard = |label: &str, callback: &str| {
        confirmation_keyboard(
            DialogButton { label, callback },
            DialogButton {
                label: &back_label,
                callback: &back,
            },
            revision,
        )
    };
    match view {
        "confirm_now" => Ok((
            format!("{overview}\n\n{}", t(Key::VideoPublishNowQ, &[])),
            keyboard(
                &t(Key::VideoPublishNowYes, &[]),
                &video_callback("publish_confirm", &[&id])?,
            ),
        )),
        "confirm_cancel" => Ok((
            format!(
                "{overview}\n\n⚠️ *{}*\n{}",
                t(Key::VpreviewCancelConfirmQ, &[]),
                t(Key::VpreviewCancelConfirmWarn, &[])
            ),
            keyboard(
                &t(Key::VpreviewCancelYes, &[]),
                &video_callback("cancel_confirm", &[&id])?,
            ),
        )),
        _ => {
            let target = target.ok_or_else(|| crate::error("Video removal confirmation target is missing."))?;
            let label: [(&str, &dyn std::fmt::Display); 1] = [("target", &target.label())];
            Ok((
                format!(
                    "{overview}\n\n⚠️ *{}*\n{}",
                    t(Key::VpreviewRemoveConfirmQ, &label),
                    t(Key::VpreviewRemoveConfirmWarn, &label)
                ),
                keyboard(
                    &t(Key::VpreviewRemoveYes, &label),
                    &video_callback("remove", &[&id, &target.as_str()])?,
                ),
            ))
        }
    }
}

/// `formatVideoTime`: a stored instant in the Studio's zone.
fn format_video_time(value: &str, time: &TimeSettings) -> crate::Result<String> {
    let at = parse_iso_instant(value).map_err(|_| crate::error("Invalid time value"))?;
    Ok(format_zoned_date_time(Some(at), &time.zone, &time.label))
}

fn video_status_label(status: &str) -> String {
    let key = match status {
        "editing" => Key::VstatusEditing,
        "draft" => Key::VstatusDraft,
        "scheduled" => Key::VstatusScheduled,
        "preparing" => Key::VstatusPreparing,
        "prepared" => Key::VstatusPrepared,
        "publishing" => Key::VstatusPublishing,
        "published" => Key::VstatusPublished,
        "failed" => Key::VstatusFailed,
        "verification_required" => Key::VstatusVerificationRequired,
        "cancelled" => Key::VstatusCancelled,
        other => return other.to_owned(),
    };
    t(key, &[])
}

/// `delivery_preview_video:<id>` (`sendVideoSourcePreview`): the video behind
/// a publication, sent only when asked for. The previews show what each
/// platform receives as text; the clip is the same file for all of them.
pub fn delivery_preview_video<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(async move {
        let Some(id) = screen_number(callback.arg("id"), 1) else {
            return Ok(false);
        };
        let source = ctx.services().videos.preview(ctx.actor_id(), id)?.delivery.source;
        let media = source.as_ref().and_then(media_source);
        let gone = t(Key::VideoSourceGone, &[]);
        ctx.answer_callback_query(media.is_none().then_some(gone.as_str()), false)
            .await?;
        if let Some(media) = media {
            ctx.reply_with_file("sendVideo", "video", media, Payload::new()).await?;
        }
        Ok(true)
    })
}
