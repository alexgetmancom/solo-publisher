//! The deploy area: the deploy agent's release controls
//! (`bot/operations-screen.ts`). Deliberately outside the content
//! screens. Every deploy action is ask → confirm → progress → result, all as
//! edits of the same message, so a tap never looks like it silently did nothing.

use foundation::i18n::{Key, t};
use foundation::logger::{LogLevel, log};
use serde_json::json;

use crate::Fut;
use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::{ScreenCallback, ScreenId, screen_callback};
use crate::context::Ctx;
use crate::deployment::{
    DeploymentAction, DeploymentOutcome, is_deployment_revision, is_deployment_target, request_deployment,
};
use crate::effects::{error_js_string, show_screen};
use crate::registry::Registry;

pub fn register(registry: &mut Registry) {
    for id in [
        ScreenId::DeployMenu,
        ScreenId::DeployRbAsk,
        ScreenId::DeployPrAsk,
        ScreenId::DeployRollback,
        ScreenId::DeployPromote,
    ] {
        registry.screen(id, operations);
    }
}

/// `handleOperationsCallback`.
fn operations<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(async move {
        let target = callback.arg("target");
        let revision = callback.arg("revision");
        // The target and the release are still validated where they are read:
        // the registry guarantees the shape of a callback, never the meaning of it.
        let valid = is_deployment_target(target) && is_deployment_revision(revision);
        match callback.id {
            ScreenId::DeployRbAsk | ScreenId::DeployPrAsk => {
                if !valid {
                    return Ok(false);
                }
                let action = if callback.id == ScreenId::DeployRbAsk {
                    DeploymentAction::Rollback
                } else {
                    DeploymentAction::Promote
                };
                ask_confirmation(ctx, action, target, revision).await?;
                Ok(true)
            }
            ScreenId::DeployMenu => {
                if !is_deployment_revision(revision) {
                    return Ok(false);
                }
                show_screen(
                    ctx,
                    &deployment_menu_text(revision),
                    Payload::new().reply_markup(deployment_menu_keyboard(revision)?),
                )
                .await?;
                Ok(true)
            }
            _ if !valid => Ok(false),
            ScreenId::DeployRollback => {
                let progress = t(Key::OpsRollingBack, &[("target", &target)]);
                run_deploy_action(ctx, callback, DeploymentAction::Rollback, &progress).await?;
                Ok(true)
            }
            _ => {
                let progress = t(
                    Key::OpsDeploying,
                    &[("target", &target), ("revision", &short(revision))],
                );
                run_deploy_action(ctx, callback, DeploymentAction::Promote, &progress).await?;
                Ok(true)
            }
        }
    })
}

/// A release as the operator reads it: `revision.slice(0, 12)`.
fn short(revision: &str) -> String {
    let units: Vec<u16> = revision.encode_utf16().take(12).collect();
    String::from_utf16_lossy(&units)
}

async fn ask_confirmation(ctx: &Ctx, action: DeploymentAction, target: &str, revision: &str) -> crate::Result<()> {
    let (question, confirm) = match action {
        DeploymentAction::Rollback => (
            t(Key::OpsRollbackQ, &[("target", &target)]),
            screen_callback(ScreenId::DeployRollback, &[&target, &revision])?,
        ),
        DeploymentAction::Promote => (
            t(Key::OpsPromoteQ, &[("target", &target), ("revision", &short(revision))]),
            screen_callback(ScreenId::DeployPromote, &[&target, &revision])?,
        ),
    };
    let original = ctx
        .update
        .callback_query
        .as_ref()
        .and_then(|query| query.message.as_ref())
        .and_then(|message| message.text.as_deref())
        .filter(|text| !text.is_empty());
    let text = match original {
        Some(original) => format!("{original}\n\n⚠️ {question}"),
        None => format!("⚠️ {question}"),
    };
    let keyboard = InlineKeyboard::new().text(t(Key::CommonConfirm, &[]), confirm).text(
        t(Key::CommonBack, &[]),
        screen_callback(ScreenId::DeployMenu, &[&revision])?,
    );
    show_screen(ctx, &text, Payload::new().reply_markup(keyboard)).await
}

/// Shows the progress, then runs the request in the background and edits the
/// same message with its outcome.
async fn run_deploy_action(
    ctx: &Ctx,
    callback: &ScreenCallback,
    action: DeploymentAction,
    progress: &str,
) -> crate::Result<()> {
    show_screen(ctx, progress, Payload::new().reply_markup(InlineKeyboard::new())).await?;
    let target = callback.arg("target").to_owned();
    let revision = callback.arg("revision").to_owned();
    // The lock stops a double tap on the confirm button from firing the
    // request twice before the button even disappears; a tap that finds it
    // held does nothing more.
    let lock_key = format!("{}:{target}:{revision}", callback.id.name());
    let Some(lock) = ctx.bot.action_locks().acquire(&lock_key, ctx.now().as_millisecond()) else {
        return Ok(());
    };
    // Deliberately not awaited: the bot takes updates one at a time per chat,
    // and this request alone can take up to ~150s (agent healthcheck plus image
    // pull). The outcome edits this message through a context of its own,
    // since the update's handling has finished by then.
    let background = Ctx::new(ctx.bot.clone(), ctx.update.clone());
    ctx.bot.spawn(async move {
        let outcome = {
            let _lock = lock;
            let agent = &*background.bot.deps().deploy_agent;
            request_deployment(agent, &background.config, action, &target, &revision).await
        };
        if let Err(error) = finish_deploy_action(&background, outcome, &revision).await {
            log(
                LogLevel::Error,
                "deployment action could not report its outcome",
                Some(json!({"error": error_js_string(&*error)})),
            );
        }
    });
    Ok(())
}

async fn finish_deploy_action(ctx: &Ctx, outcome: DeploymentOutcome, fallback_revision: &str) -> crate::Result<()> {
    let (final_text, revision) = match &outcome {
        DeploymentOutcome::Done { current_revision, .. } => (
            t(Key::OpsDone, &[("revision", &short(current_revision))]),
            current_revision.as_str(),
        ),
        DeploymentOutcome::Failed { message } => (t(Key::OpsFailed, &[("message", message)]), fallback_revision),
    };
    let body = format!("{final_text}\n\n{}", deployment_menu_text(revision));
    show_screen(
        ctx,
        &body,
        Payload::new().reply_markup(deployment_menu_keyboard(revision)?),
    )
    .await
}

fn deployment_menu_keyboard(revision: &str) -> crate::Result<InlineKeyboard> {
    Ok(InlineKeyboard::new()
        .text(
            t(Key::OpsRollbackBtn, &[("target", &"alex")]),
            screen_callback(ScreenId::DeployRbAsk, &[&"alex", &revision])?,
        )
        .row()
        .text(
            t(Key::OpsPromoteBtn, &[("target", &"maru")]),
            screen_callback(ScreenId::DeployPrAsk, &[&"maru", &revision])?,
        )
        .row()
        .text(
            t(Key::OpsPromoteBtn, &[("target", &"worker")]),
            screen_callback(ScreenId::DeployPrAsk, &[&"worker", &revision])?,
        ))
}

fn deployment_menu_text(revision: &str) -> String {
    t(Key::OpsMenu, &[("revision", &short(revision))])
}
