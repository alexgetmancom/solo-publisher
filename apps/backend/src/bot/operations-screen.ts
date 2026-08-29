import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { withActionLock } from "../foundation/action-lock.js";
import type { BackendConfig } from "../foundation/config.js";
import { isDeploymentRevision, isDeploymentTarget, requestDeploymentPromote, requestDeploymentRollback } from "../foundation/deployment.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { settingsService } from "../studio/services/settings.js";
import { showScreen } from "./effects.js";
import { type ScreenCallback, screenCallback } from "./screen-callback.js";

/** Operations callbacks are deliberately outside content/post screens.
 * Every deploy action is ask -> confirm -> progress -> result, all as edits
 * to the same message, so a tap never looks like it silently did nothing. */
export async function handleOperationsCallback(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  callback: ScreenCallback,
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(ctx.from?.id ?? 0);
  const target = callback.args.target ?? "";
  const revision = callback.args.revision ?? "";
  // The target and the release are still validated where they are read: the
  // registry guarantees the shape of a callback, never the meaning of it.
  const deployment = isDeploymentTarget(target) && isDeploymentRevision(revision) ? { target, revision } : null;

  if (callback.id === "deploy_rb_ask" || callback.id === "deploy_pr_ask") {
    if (!deployment) return false;
    return askConfirmation(ctx, locale, callback.id === "deploy_rb_ask" ? "rollback" : "promote", deployment.target, deployment.revision);
  }

  if (callback.id === "deploy_menu") {
    if (!isDeploymentRevision(revision)) return false;
    await ctx.answerCallbackQuery();
    await showScreen(ctx, deploymentMenuText(locale, revision), { reply_markup: deploymentMenuKeyboard(locale, revision) });
    return true;
  }

  if (!deployment) return false;
  const lockKey = `${callback.id}:${deployment.target}:${deployment.revision}`;
  if (callback.id === "deploy_rollback") {
    await runDeployAction(ctx, locale, lockKey, deployment.revision, t(locale, "ops.rolling-back", { target: deployment.target }), () =>
      requestDeploymentRollback(config, deployment.target, deployment.revision),
    );
    return true;
  }
  const progress = t(locale, "ops.deploying", { target: deployment.target, revision: deployment.revision.slice(0, 12) });
  await runDeployAction(ctx, locale, lockKey, deployment.revision, progress, () =>
    requestDeploymentPromote(config, deployment.target, deployment.revision),
  );
  return true;
}

async function askConfirmation(
  ctx: Context,
  locale: StudioLocale,
  action: "rollback" | "promote",
  target: string,
  revision: string,
): Promise<boolean> {
  await ctx.answerCallbackQuery();
  const question =
    action === "rollback"
      ? t(locale, "ops.rollback-q", { target })
      : t(locale, "ops.promote-q", { target, revision: revision.slice(0, 12) });
  const confirmData =
    action === "rollback" ? screenCallback("deploy_rollback", [target, revision]) : screenCallback("deploy_promote", [target, revision]);
  const original = ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : undefined;
  await showScreen(ctx, `${original ? `${original}\n\n` : ""}⚠️ ${question}`, {
    reply_markup: new InlineKeyboard()
      .text(t(locale, "common.confirm"), confirmData)
      .text(t(locale, "common.back"), screenCallback("deploy_menu", [revision])),
  });
  return true;
}

async function runDeployAction(
  ctx: Context,
  locale: StudioLocale,
  lockKey: string,
  menuRevision: string,
  progressText: string,
  action: () => Promise<{ ok: true; release: string; currentRevision: string } | { ok: false; message: string }>,
): Promise<void> {
  await ctx.answerCallbackQuery();
  await showScreen(ctx, progressText, { reply_markup: new InlineKeyboard() });
  // Deliberately not awaited: the bot polls updates one at a time, and this
  // request alone can take up to ~150s (agent healthcheck plus image pull).
  // Awaiting it here would freeze every chat's buttons and messages until it
  // resolves. Let it run in the background and edit this message once it's done.
  // withActionLock stops a double tap on the confirm button from firing the
  // request twice before the button even disappears.
  void withActionLock(lockKey, action)
    .then((result) => (result.ok ? finishDeployAction(ctx, locale, result.value, menuRevision) : undefined))
    .catch((error) =>
      finishDeployAction(ctx, locale, { ok: false, message: error instanceof Error ? error.message : String(error) }, menuRevision),
    );
}

async function finishDeployAction(
  ctx: Context,
  locale: StudioLocale,
  result: { ok: true; release: string; currentRevision: string } | { ok: false; message: string },
  fallbackRevision: string,
): Promise<void> {
  const finalText = result.ok
    ? t(locale, "ops.done", { revision: result.currentRevision.slice(0, 12) })
    : t(locale, "ops.failed", { message: result.message });
  const revision = result.ok ? result.currentRevision : fallbackRevision;
  const body = `${finalText}\n\n${deploymentMenuText(locale, revision)}`;
  await showScreen(ctx, body, { reply_markup: deploymentMenuKeyboard(locale, revision) });
}

function deploymentMenuKeyboard(locale: StudioLocale, revision: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(locale, "ops.rollback-btn", { target: "alex" }), screenCallback("deploy_rb_ask", ["alex", revision]))
    .row()
    .text(t(locale, "ops.promote-btn", { target: "maru" }), screenCallback("deploy_pr_ask", ["maru", revision]))
    .row()
    .text(t(locale, "ops.promote-btn", { target: "worker" }), screenCallback("deploy_pr_ask", ["worker", revision]));
}

function deploymentMenuText(locale: StudioLocale, revision: string): string {
  return t(locale, "ops.menu", { revision: revision.slice(0, 12) });
}
