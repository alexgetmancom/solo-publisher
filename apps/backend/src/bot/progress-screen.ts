import { type Context, InlineKeyboard } from "grammy";
import { targetDefinition } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { escapeMarkdown } from "../foundation/markdown.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { executePublicationEffects } from "./effects.js";
import { renderPostProgress } from "./progress.js";
import { screenCallback } from "./screen-callback.js";

/** Renders and updates one durable publication-progress card in place. The
 * buttons it carries -- details, overview, cancel the rest -- are declared
 * screens, so the card no longer parses its own callback data. */
export async function showPostProgress(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  draftId: number,
  view: { details: boolean; confirmCancel?: true; cancelRemaining?: true },
): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const posts = createStudioServices(backendDb, config).posts;
  // Cancelling the rest names the platforms it is about to stop before it stops
  // them, because the answer depends on which ones are still to go out.
  if (view.confirmCancel) {
    const pending = posts.pendingTargets(actorId, draftId);
    const stoppable = pending.filter((item) => !item.started).map((item) => label(item.target));
    await executePublicationEffects(ctx, backendDb, [
      {
        type: "screen",
        text: `⚠️ *${t(locale, "progress.cancel-remaining-q")}*\n${escapeMarkdown(stoppable.join(", ") || t(locale, "post.none"))}\n\n${t(locale, "progress.cancel-remaining-warn")}`,
        options: {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text(t(locale, "progress.cancel-remaining-btn"), screenCallback("progress_cancel_confirm", [draftId]))
            .row()
            .text(t(locale, "common.back"), screenCallback("progress", [draftId])),
        },
        card: { kind: "post-progress", draftId, details: false },
      },
    ]);
    return;
  }
  if (view.cancelRemaining) {
    const report = posts.cancelRemaining(actorId, draftId);
    // What was stopped and what was too far along to stop, said out loud: the
    // second list is the one an operator otherwise discovers on the platform.
    const stopped = report.stopped.map(label).join(", ");
    const finishing = report.finishing.map(label).join(", ");
    await ctx.answerCallbackQuery({
      text: [
        stopped ? t(locale, "progress.cancel-stopped", { targets: stopped }) : t(locale, "progress.cancel-stopped-none"),
        finishing ? t(locale, "progress.cancel-finishing", { targets: finishing }) : "",
      ]
        .filter(Boolean)
        .join("\n"),
      show_alert: true,
    });
  }
  const progress = renderPostProgress(posts.progress(actorId, draftId), locale, view.details);
  await executePublicationEffects(ctx, backendDb, [
    {
      type: "screen",
      text: progress.text,
      options: { parse_mode: "Markdown", reply_markup: progress.keyboard },
      card: { kind: "post-progress", draftId, details: view.details },
    },
  ]);
}

/** A target as the operator selected it, falling back to its id for a site
 * reason no target list names. */
function label(target: string): string {
  return targetDefinition(target)?.label ?? target;
}
