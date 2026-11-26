//! The publication-progress card (`bot/progress.ts`, `bot/progress-screen.ts`):
//! one durable card, updated in place, and its four screen buttons.

use domain::studio::services::post_progress::{PostProgressState, PostProgressStatus};
use domain::targets::target_definition;
use foundation::i18n::{Key, t};
use foundation::logger::{LogLevel, log};
use foundation::markdown::escape_markdown;
use foundation::text::truncate_unicode;
use serde_json::json;

use crate::Fut;
use crate::api::is_unchanged_message_edit;
use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::{ScreenCallback, ScreenId, screen, screen_callback, screen_number};
use crate::cards;
use crate::context::Ctx;
use crate::effects::{CardRef, Effect, error_js_string, execute};
use crate::registry::Registry;

use super::preview::post_preview_card;

pub fn register(registry: &mut Registry) {
    registry.screen(ScreenId::Progress, progress);
    registry.screen(ScreenId::ProgressDetails, progress_details);
    registry.screen(ScreenId::ProgressCancel, progress_cancel);
    registry.screen(ScreenId::ProgressCancelConfirm, progress_cancel_confirm);
}

#[derive(Clone, Copy, Default)]
struct View {
    details: bool,
    confirm_cancel: bool,
    cancel_remaining: bool,
}

fn route<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback, view: View) -> Fut<'a, crate::Result<bool>> {
    Box::pin(async move {
        let Some(draft_id) = screen_number(callback.arg("draft"), 1) else {
            return Ok(false);
        };
        show_post_progress(ctx, draft_id, view).await?;
        Ok(true)
    })
}

fn progress<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    route(ctx, callback, View::default())
}

fn progress_details<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    route(
        ctx,
        callback,
        View {
            details: true,
            ..View::default()
        },
    )
}

fn progress_cancel<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    route(
        ctx,
        callback,
        View {
            confirm_cancel: true,
            ..View::default()
        },
    )
}

fn progress_cancel_confirm<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    route(
        ctx,
        callback,
        View {
            cancel_remaining: true,
            ..View::default()
        },
    )
}

/// A target as the operator selected it, its id for one no list names.
fn label(target: &str) -> String {
    target_definition(target).map_or_else(|| target.to_owned(), |definition| definition.label.to_owned())
}

/// `showPostProgress`.
async fn show_post_progress(ctx: &Ctx, draft_id: i64, view: View) -> crate::Result<()> {
    let actor_id = ctx.actor_id();
    let services = ctx.services();
    let posts = &services.posts;
    // Cancelling the rest names the platforms it is about to stop first.
    if view.confirm_cancel {
        let stoppable: Vec<String> = posts
            .pending_targets(actor_id, draft_id)?
            .iter()
            .filter(|item| !item.started)
            .map(|item| label(&item.target))
            .collect();
        let named = match stoppable.join(", ") {
            joined if joined.is_empty() => t(Key::PostNone, &[]),
            joined => joined,
        };
        let keyboard = InlineKeyboard::new()
            .text(
                t(Key::ProgressCancelRemainingBtn, &[]),
                screen_callback(ScreenId::ProgressCancelConfirm, &[&draft_id])?,
            )
            .row()
            .text(t(Key::CommonBack, &[]), screen_callback(ScreenId::Progress, &[&draft_id])?);
        return execute(
            ctx,
            vec![Effect::Screen {
                text: format!(
                    "⚠️ *{}*\n{}\n\n{}",
                    t(Key::ProgressCancelRemainingQ, &[]),
                    escape_markdown(&named),
                    t(Key::ProgressCancelRemainingWarn, &[])
                ),
                options: Payload::new().markdown().reply_markup(keyboard),
                card: Some(CardRef::PostProgress {
                    draft_id,
                    details: false,
                }),
            }],
        )
        .await;
    }
    if view.cancel_remaining {
        let report = posts.cancel_remaining(actor_id, draft_id)?;
        // What was stopped and what was too far along to stop, said out loud.
        let stopped = report.stopped.iter().map(|target| label(target)).collect::<Vec<_>>().join(", ");
        let finishing = report.finishing.iter().map(|target| label(target)).collect::<Vec<_>>().join(", ");
        let mut lines = vec![if stopped.is_empty() {
            t(Key::ProgressCancelStoppedNone, &[])
        } else {
            t(Key::ProgressCancelStopped, &[("targets", &stopped)])
        }];
        if !finishing.is_empty() {
            lines.push(t(Key::ProgressCancelFinishing, &[("targets", &finishing)]));
        }
        ctx.answer_callback_query(Some(&lines.join("\n")), true).await?;
    }
    let (text, keyboard) = render_post_progress(&posts.progress(actor_id, draft_id)?, view.details)?;
    execute(
        ctx,
        vec![Effect::Screen {
            text,
            options: Payload::new().markdown().reply_markup(keyboard),
            card: Some(CardRef::PostProgress {
                draft_id,
                details: view.details,
            }),
        }],
    )
    .await
}

/// `renderPostProgress`.
pub fn render_post_progress(state: &PostProgressState, details: bool) -> crate::Result<(String, InlineKeyboard)> {
    let counts = state.counts;
    let completed = counts.published + counts.failed + counts.verification_required + counts.cancelled;
    let total = state.targets.len();
    let title = if counts.failed + counts.verification_required > 0 {
        t(Key::ProgressIssuesTitle, &[])
    } else if completed as usize == total && total > 0 {
        t(Key::ProgressCompleteTitle, &[])
    } else {
        t(Key::ProgressPublishingTitle, &[])
    };
    let mut lines = vec![
        format!("{title} · *Post #{}*", state.draft_id),
        String::new(),
        format!("{}: *{completed} / {total}*", t(Key::ProgressProgress, &[])),
        format!("✅ {}: {}", t(Key::ProgressPublished, &[]), counts.published),
        format!("🔄 {}: {}", t(Key::ProgressPublishing, &[]), counts.publishing),
        format!("⏳ {}: {}", t(Key::ProgressWaiting, &[]), counts.waiting),
        format!("❌ {}: {}", t(Key::ProgressFailed, &[]), counts.failed),
        format!(
            "⚠️ {}: {}",
            t(Key::ProgressVerificationRequired, &[]),
            counts.verification_required
        ),
    ];
    if details {
        for group in [content::Locale::Ru, content::Locale::En] {
            let items: Vec<_> = state.targets.iter().filter(|item| item.locale == group).collect();
            if items.is_empty() {
                continue;
            }
            lines.push(String::new());
            lines.push(format!("*{}*", group.as_str().to_uppercase()));
            for item in items {
                let unlanded = matches!(
                    item.status,
                    PostProgressStatus::Failed | PostProgressStatus::VerificationRequired
                );
                let error = match item.error.as_deref().filter(|error| !error.is_empty()) {
                    Some(error) if unlanded => format!(" — {}", short_error(error)),
                    _ => String::new(),
                };
                lines.push(format!("{} {}{error}", status_icon(item.status), item.label));
            }
        }
    }
    let (label, target) = if details {
        (Key::ProgressHideDetails, ScreenId::Progress)
    } else {
        (Key::ProgressShowDetails, ScreenId::ProgressDetails)
    };
    let mut keyboard = InlineKeyboard::new().text(t(label, &[]), screen_callback(target, &[&state.draft_id])?);
    if counts.waiting + counts.publishing > 0 {
        keyboard = keyboard.text(
            t(Key::ProgressCancelRemaining, &[]),
            screen_callback(ScreenId::ProgressCancel, &[&state.draft_id])?,
        );
    }
    keyboard = keyboard
        .row()
        .text(t(Key::CommonMenu, &[]), screen(ScreenId::MenuHome));
    Ok((lines.join("\n"), keyboard))
}

/// `refreshPostControlCard`: the progress card redrawn in place after a
/// publish step. An identical redraw is the normal path and stays silent.
pub async fn refresh_post_control_card(ctx: &Ctx, draft_id: i64) -> crate::Result<()> {
    let Some((binding, details)) = cards::post_progress_card(ctx.db(), draft_id)? else {
        return Ok(());
    };
    let state = domain::studio::services::post_progress::post_progress_state(&ctx.studio(), draft_id)?;
    let (text, keyboard) = render_post_progress(&state, details)?;
    let result = ctx
        .bot
        .api()
        .edit_message_text(
            binding.chat_id,
            binding.message_id,
            &text,
            Payload::new().markdown().reply_markup(keyboard),
        )
        .await;
    if let Err(error) = result
        && !is_unchanged_message_edit(&error)
    {
        log(
            LogLevel::Warn,
            "post control card refresh failed",
            Some(json!({"draftId": draft_id, "error": error_js_string(&error)})),
        );
    }
    Ok(())
}

/// `refreshPostPreviewCard`: the editor card redrawn on the screen it is on,
/// for a change the operator did not make (the English arriving).
pub async fn refresh_post_preview_card(ctx: &Ctx, draft_id: i64) -> crate::Result<()> {
    let Some(card) = cards::post_card(ctx.db(), draft_id)? else {
        return Ok(());
    };
    let Some(draft) = ctx.ports().drafts().get(draft_id)? else {
        return Ok(());
    };
    let preview = post_preview_card(ctx, draft.actor_id, draft_id, card.view.as_deref())?;
    let result = ctx
        .bot
        .api()
        .edit_message_text(
            card.chat_id,
            card.message_id,
            &preview.text,
            Payload::new().markdown().reply_markup(preview.keyboard),
        )
        .await;
    if let Err(error) = result
        && !is_unchanged_message_edit(&error)
    {
        log(
            LogLevel::Warn,
            "post preview card refresh failed",
            Some(json!({"draftId": draft_id, "error": error_js_string(&error)})),
        );
    }
    Ok(())
}

fn status_icon(status: PostProgressStatus) -> &'static str {
    match status {
        PostProgressStatus::Published => "✅",
        PostProgressStatus::Publishing => "🔄",
        PostProgressStatus::Waiting => "⏳",
        PostProgressStatus::Failed => "❌",
        PostProgressStatus::VerificationRequired => "⚠️",
        PostProgressStatus::Cancelled => "⏹",
    }
}

/// A platform error can be arbitrarily long; truncation comes before
/// escaping so the card never ends in a lone `\`.
fn short_error(value: &str) -> String {
    escape_markdown(truncate_unicode(value, 180))
}
