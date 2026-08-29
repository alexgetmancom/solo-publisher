import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { executePublicationEffects } from "./effects.js";
import { renderPostProgress } from "./progress.js";

/** Renders and updates one durable publication-progress card in place. The
 * three buttons it carries -- details, overview, cancel the rest -- are three
 * declared screens, so the card no longer parses its own callback data. */
export async function showPostProgress(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  draftId: number,
  view: { details: boolean; cancelRemaining?: true },
): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const posts = createStudioServices(backendDb, config).posts;
  if (view.cancelRemaining) {
    posts.cancelJobs(actorId, draftId);
    await ctx.answerCallbackQuery({ text: t(locale, "progress.remaining-cancelled") });
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
