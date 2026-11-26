//! The MP4 → metadata → schedule conversation.
//! It is entered from the intake, which has already captured the file and
//! asked for its language.

use std::sync::LazyLock;

use content::Locale;
use domain::application::conversation_flow::{FlowStepInput, PublicationKind, flow_step_input};
use domain::publishing::video_types::{VIDEO_LENGTH_WARNING_SECONDS, VideoTarget, VideoTechnicalCheck};
use domain::studio::video_fsm::{VIDEO_FLOW, VideoWizardStep, advance_video_metadata};
use foundation::errors::StudioError;
use foundation::i18n::{Key, t};
use foundation::js;
use foundation::logger::{LogLevel, log};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::Fut;
use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::publication_callback;
use crate::context::Ctx;
use crate::dialog_ui::{append_cancel_button, prompt_effect};
use crate::effects::Effect;
use crate::error_text::{describe_error, describe_publication_error};
use crate::media_ingress::materialize_telegram_file;
use crate::publication::card_effect;
use crate::registry::{MessageResult, VideoHandoff};
use crate::screens::intake::connected_video_targets;

use super::ingress::store_telegram_video;
use super::preview::video_preview_card;
use super::scheduling::apply_video_schedule_date;
use super::state::{
    VideoState, VideoStateInput, advance, clear_video_state, get_video_state, save_video_state, time_settings,
    video_duration_label, video_error_effects, video_step_effects,
};

type Effects = crate::Result<Vec<Effect>>;

/// A script is a page of text; anything larger is not one, and reading it
/// into memory should not depend on trusting that.
const SCRIPT_FILE_LIMIT_BYTES: i64 = 256 * 1024;

static SCRIPT_FILE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(txt|md|markdown)$").unwrap());

/// `handleVideoConversationMessage`: the open video conversation's answer
/// to a message; with no conversation open the message is not its own.
pub(super) fn handle_video_conversation_message(ctx: &Ctx) -> Fut<'_, crate::Result<MessageResult>> {
    Box::pin(async move {
        let actor_id = ctx.actor_id();
        let Some(session) = get_video_state(ctx, actor_id)? else {
            return Ok(MessageResult::declined());
        };
        // A step that expects nothing from the operator is driven by its own
        // controls. The message is still ours -- the wizard is open -- so say
        // what the step is waiting for rather than dropping it.
        let Some(input) = flow_step_input(&VIDEO_FLOW, &session.step) else {
            return Ok(MessageResult::handled(vec![prompt_effect(
                ctx,
                PublicationKind::Video,
                &t(Key::VideoAwaitingButton, &[]),
                false,
            )?]));
        };
        let attempt: Effects = async {
            let text = ctx
                .update
                .message
                .as_ref()
                .and_then(|message| message.text.as_deref())
                .map(js::trim)
                .unwrap_or_default()
                .to_owned();
            if input == FlowStepInput::Text && text.is_empty() {
                return Ok(vec![prompt_effect(
                    ctx,
                    PublicationKind::Video,
                    &t(Key::VideoAwaitText, &[]),
                    false,
                )?]);
            }
            match VideoWizardStep::parse(&session.step).filter(|_| session.single_edit()) {
                Some(step) => finish_single_video_edit(ctx, actor_id, &session, step, &text),
                None => accept_video_message(ctx, actor_id, &session, &text).await,
            }
        }
        .await;
        match attempt {
            Ok(effects) => Ok(MessageResult::handled(effects)),
            Err(error) => {
                // The original error is operationally important (disk,
                // Telegram download, media import, Studio validation) and the
                // reply can still be lost to a send failure: log it first.
                log(
                    LogLevel::Error,
                    "Video conversation step failed",
                    Some(json!({"actorId": actor_id, "step": session.step, "error": error.to_string()})),
                );
                let message = format!("🔴 {}: {}", t(Key::VideoValueError, &[]), describe_error(&*error));
                Ok(MessageResult::handled(video_error_effects(
                    ctx, actor_id, &session, &message,
                )?))
            }
        }
    })
}

/// Routes the message to the operation the current step performs. The
/// metadata steps are one case: they differ only in which field they collect.
async fn accept_video_message(ctx: &Ctx, actor_id: i64, session: &VideoState, text: &str) -> Effects {
    match session.step.as_str() {
        "asset" if session.single_edit() => replace_video_asset(ctx, actor_id, session).await,
        "asset" => accept_video_asset(ctx, actor_id, session).await,
        "label" => accept_video_label(ctx, actor_id, session, text),
        "script" => accept_video_script(ctx, actor_id, session, text).await,
        "schedule_common" | "schedule_target" => accept_video_schedule_date(ctx, actor_id, session, text),
        step => match VideoWizardStep::parse(step) {
            Some(step) => accept_video_metadata(ctx, actor_id, session, step, text),
            None => Err(StudioError::new("err.video-restart").into()),
        },
    }
}

async fn accept_video_asset(ctx: &Ctx, actor_id: i64, session: &VideoState) -> Effects {
    // Nothing about this depends on the upload, so fail before spending a
    // Telegram download and before a draft row exists to be orphaned.
    if connected_video_targets(ctx)?.is_empty() {
        return Err(StudioError::new("err.no-video-platforms-connected").into());
    }
    let asset_id = store_telegram_video(ctx, actor_id, None).await?;
    let technical = ctx.services().videos.asset_technical_check(actor_id, asset_id).await?;
    attach_video_asset(ctx, actor_id, session, asset_id, &technical)
}

/// The intake's handoff: the stored video opens the conversation on the
/// upload step and is attached at once.
pub(super) fn attach_intake_video(ctx: &Ctx, handoff: VideoHandoff) -> Fut<'_, Effects> {
    Box::pin(async move {
        let mut data = Map::new();
        data.insert("videoLocale".into(), json!(handoff.video_locale.as_str()));
        let session = save_video_state(
            ctx,
            handoff.actor_id,
            VideoStateInput {
                draft_id: None,
                step: "asset".into(),
                selected: handoff.selected,
                data,
                control_message_id: None,
                revision: None,
            },
        )?;
        attach_video_asset(ctx, handoff.actor_id, &session, handoff.asset_id, &handoff.technical)
    })
}

/// `attachVideoAsset`: a stored video behind a fresh draft, the wizard past
/// the upload step. A clip over the length threshold stops here instead: the
/// file is probed before a draft exists, so answering "no" leaves nothing
/// behind.
fn attach_video_asset(
    ctx: &Ctx,
    actor_id: i64,
    session: &VideoState,
    asset_id: i64,
    technical: &VideoTechnicalCheck,
) -> Effects {
    let mut effects = background_music_warning(technical.background_music_likely_missing);
    if technical.seconds > f64::from(VIDEO_LENGTH_WARNING_SECONDS) {
        effects.extend(video_length_warning_effects(
            ctx,
            actor_id,
            session,
            asset_id,
            technical.seconds,
        )?);
    } else {
        effects.extend(start_video_draft(ctx, actor_id, session, asset_id)?);
    }
    Ok(effects)
}

fn background_music_warning(likely_missing: bool) -> Vec<Effect> {
    if !likely_missing {
        return Vec::new();
    }
    vec![Effect::message(
        t(Key::VideoBackgroundMusicWarning, &[]),
        Payload::new(),
    )]
}

/// Asks about a clip longer than the operator's own cuts ever are, keeping
/// the session on the upload step: a shorter file sent instead is attached in
/// its place.
fn video_length_warning_effects(
    ctx: &Ctx,
    actor_id: i64,
    session: &VideoState,
    asset_id: i64,
    seconds: f64,
) -> Effects {
    let mut data = session.data.clone();
    data.insert("assetId".into(), json!(asset_id));
    let saved = save_video_state(
        ctx,
        actor_id,
        VideoStateInput {
            draft_id: None,
            step: "asset".into(),
            data,
            ..session.input()
        },
    )?;
    let revision = Some(saved.revision);
    let keyboard = InlineKeyboard::new()
        .text(
            t(Key::VideoLengthWarningYes, &[]),
            publication_callback(PublicationKind::Video, "length_ok", &[], revision)?,
        )
        .row();
    let cancel = publication_callback(PublicationKind::Video, "cancel_dialog", &[], None)?;
    let keyboard = append_cancel_button(keyboard, &cancel, revision);
    let text = t(
        Key::VideoLengthWarning,
        &[
            ("dur", &video_duration_label(seconds)),
            ("limit", &VIDEO_LENGTH_WARNING_SECONDS),
        ],
    );
    Ok(vec![Effect::screen(
        text,
        Payload::new().markdown().reply_markup(keyboard),
    )])
}

/// `startVideoDraft`: the upload the operator settled on, behind a fresh
/// draft for the platforms chosen on the destination screen.
pub(super) fn start_video_draft(ctx: &Ctx, actor_id: i64, session: &VideoState, asset_id: i64) -> Effects {
    let selected = session.selected.clone();
    if selected.is_empty() {
        return Err(StudioError::new("err.no-video-platforms-connected").into());
    }
    let videos = ctx.services().videos;
    let locale = if session.data.get("videoLocale").and_then(Value::as_str) == Some("en") {
        Locale::En
    } else {
        Locale::Ru
    };
    let draft_id = videos.create(actor_id, asset_id, Some(locale))?;
    videos.replace_targets(actor_id, draft_id, &selected)?;
    let session = VideoState {
        draft_id: Some(draft_id),
        ..session.clone()
    };
    let saved = advance(
        ctx,
        actor_id,
        &session,
        json!(asset_id),
        session.flow_data(),
        "err.video-restart",
        None,
    )?;
    video_step_effects(ctx, actor_id, &saved)
}

/// Swaps the file behind an existing draft ("🎬 Replace video" on the edit
/// menu); only the draft it lands on already exists.
async fn replace_video_asset(ctx: &Ctx, actor_id: i64, session: &VideoState) -> Effects {
    let Some(draft_id) = session.draft_id else {
        return Err(StudioError::new("err.video-reopen-edit").into());
    };
    let asset_id = store_telegram_video(ctx, actor_id, None).await?;
    let technical = ctx
        .services()
        .videos
        .replace_source(actor_id, draft_id, asset_id)
        .await?;
    let mut effects = background_music_warning(technical.background_music_likely_missing);
    effects.extend(video_card_effects(ctx, actor_id, draft_id)?);
    Ok(effects)
}

/// Renames a finished draft; the name is asked for from its edit menu, so
/// the answer ends on its card.
fn accept_video_label(ctx: &Ctx, actor_id: i64, session: &VideoState, text: &str) -> Effects {
    let draft_id = session.draft_id.ok_or_else(|| StudioError::new("err.video-missing"))?;
    ctx.services().videos.rename(actor_id, draft_id, text)?;
    video_card_effects(ctx, actor_id, draft_id)
}

/// Stores the script, typed into the chat or attached as the .txt or .md
/// file it was written in.
async fn accept_video_script(ctx: &Ctx, actor_id: i64, session: &VideoState, text: &str) -> Effects {
    let draft_id = session.draft_id.ok_or_else(|| StudioError::new("err.video-missing"))?;
    let script = match attached_text(ctx).await? {
        Some(script) => script,
        None => text.to_owned(),
    };
    if js::trim(&script).is_empty() {
        return Err(StudioError::new("video.await-text").into());
    }
    ctx.services().videos.set_script(actor_id, draft_id, &script)?;
    // Asked from the card, this is one field and the card is the answer.
    // Asked by the wizard, it is the step after the upload.
    if session.single_edit() {
        return video_card_effects(ctx, actor_id, draft_id);
    }
    let next = advance(
        ctx,
        actor_id,
        session,
        json!(script),
        session.flow_data(),
        "err.video-restart",
        None,
    )?;
    video_step_effects(ctx, actor_id, &next)
}

/// The text of an attached document, when the answer arrived as a file.
async fn attached_text(ctx: &Ctx) -> crate::Result<Option<String>> {
    let Some(document) = ctx
        .update
        .message
        .as_ref()
        .and_then(|message| message.document.as_ref())
        .filter(|document| !document.file_id.is_empty())
    else {
        return Ok(None);
    };
    let name = document.file_name.as_deref().unwrap_or_default();
    let mime = document.mime_type.as_deref().unwrap_or_default();
    if !SCRIPT_FILE_NAME.is_match(name) && !mime.starts_with("text/") {
        return Err(StudioError::new("video.script-file-type").into());
    }
    if document.file_size.unwrap_or_default() > SCRIPT_FILE_LIMIT_BYTES {
        return Err(StudioError::new("video.script-file-large").into());
    }
    if ctx.config.controller_bot_token.as_deref().is_none_or(str::is_empty) {
        return Err(crate::error("Telegram bot token is not configured."));
    }
    let file = ctx.bot.api().get_file(&document.file_id).await?;
    let file_path = file
        .file_path
        .ok_or_else(|| crate::error(format!("Telegram getFile failed for {}", document.file_id)))?;
    let (path, temporary) = materialize_telegram_file(ctx.bot.api(), &ctx.config, &file_path, ".txt").await?;
    let text = std::fs::read(&path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
    if temporary {
        let _ = std::fs::remove_file(&path);
    }
    Ok(Some(text?))
}

/// One case for every metadata field. A platform's collected fields are
/// handed to Video Studio the moment the flow leaves that platform's chain.
fn accept_video_metadata(ctx: &Ctx, actor_id: i64, session: &VideoState, step: VideoWizardStep, text: &str) -> Effects {
    let draft_id = session.draft_id.ok_or_else(|| StudioError::new("err.video-missing"))?;
    let saved = advance(
        ctx,
        actor_id,
        session,
        json!(text),
        session.flow_data(),
        "err.video-restart",
        None,
    )?;
    // The last step of each platform's chain is where its fields become its
    // stored metadata.
    let completed = match step {
        VideoWizardStep::YoutubeTags => Some(VideoTarget::YoutubeShorts),
        VideoWizardStep::InstagramCaption => Some(VideoTarget::InstagramReels),
        _ => None,
    };
    if let Some(target) = completed {
        ctx.services()
            .videos
            .complete_wizard_target(actor_id, draft_id, target, &saved.data, &session.selected)?;
    }
    video_step_effects(ctx, actor_id, &saved)
}

/// Isolates the one step that legitimately fails on bad input: any other
/// error here must reach the generic path instead of reading as an
/// unparsable date.
fn accept_video_schedule_date(ctx: &Ctx, actor_id: i64, session: &VideoState, text: &str) -> Effects {
    let draft_id = session.draft_id.ok_or_else(|| StudioError::new("err.video-missing"))?;
    let date = match ctx.services().videos.manual_schedule(actor_id, draft_id, text) {
        Ok(date) => date,
        Err(error) => {
            let label = time_settings(ctx, actor_id)?.label;
            let error: crate::Error = error.into();
            let message = describe_publication_error(&*error, &label);
            return video_error_effects(ctx, actor_id, session, &message);
        }
    };
    apply_video_schedule_date(ctx, actor_id, session, date)
}

/// One field of a finished draft, edited outside the wizard order. The value
/// is parsed by the same transition the wizard uses, so "-" and URL fixing
/// cannot drift between the two entry points.
fn finish_single_video_edit(
    ctx: &Ctx,
    actor_id: i64,
    session: &VideoState,
    step: VideoWizardStep,
    text: &str,
) -> Effects {
    let draft_id = session
        .draft_id
        .ok_or_else(|| StudioError::new("err.video-reopen-edit"))?;
    let parsed = advance_video_metadata(step, text, Map::new())?
        .get(step.as_str())
        .cloned()
        .unwrap_or(Value::Null);
    ctx.services()
        .videos
        .edit_metadata_field(actor_id, draft_id, step, &parsed)?;
    video_card_effects(ctx, actor_id, draft_id)
}

/// Ends the dialog on the draft's own card: there is no next question.
fn video_card_effects(ctx: &Ctx, actor_id: i64, draft_id: i64) -> Effects {
    clear_video_state(ctx, actor_id)?;
    Ok(card_effect(video_preview_card(ctx, actor_id, draft_id)?))
}
