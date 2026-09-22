import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { t } from "../foundation/i18n/index.js";
import { formatZonedDateTime } from "../foundation/time.js";
import { importTelegramMedia } from "../interfaces/telegram/media-ingress.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { requireConversationState } from "./conversation-state.js";
import { confirmationKeyboard } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import { extractMessage } from "./message.js";
import { POST_FLOW, type PostFlowInput, type PostWizardStep, postStateStep } from "./post-flow.js";
import { publicationCallback } from "./publication-callback.js";
import { advancePublicationFlow } from "./publication-flow.js";
import { postPreviewCard, publicationCardEffect, publicationRenderers } from "./publication-renderers.js";
import { createPublicationScheduleEngine, scheduleConfirmationEffects } from "./scheduling.js";

export async function applyAdminState(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  step: PostWizardStep,
  draftId: number,
  controlMessageId: number | null,
  expectedRevision?: number | null,
): Promise<PublicationEffect[]> {
  const actorId = Number(ctx.from?.id);
  const extracted = extractMessage(ctx);
  const message = extracted.media.length
    ? { ...extracted, media: await importTelegramMedia(ctx.api, backendDb, config, actorId, extracted.media) }
    : extracted;
  const input: PostFlowInput = { backendDb, config, actorId, draftId, controlMessageId, step, message };
  const session = requireConversationState(backendDb, actorId, "post", expectedRevision ?? null);
  const saved = await advancePublicationFlow(backendDb, actorId, POST_FLOW, session, input, session.data, "action.session-stale");
  if (saved.step === "schedule_confirm") return renderPostScheduleConfirmation(backendDb, config, actorId, draftId, saved);
  if (step.type === "thread_part" || step.type === "thread_edit")
    return [
      { type: "session", operation: "clear", kind: "post", actorId },
      ...threadPartSaved(backendDb, config, actorId, draftId, step.type),
    ];
  const preview = postPreviewCard(backendDb, config, actorId, draftId);
  return [{ type: "session", operation: "clear", kind: "post", actorId }, ...publicationCardEffect(preview)];
}

/** After a new post of the thread: write another, or finish and review the
 * whole. After a rewrite: straight back to the review it came from. Chat input
 * and a finished album both land here. */
export function threadPartScreen(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  step: "thread_part" | "thread_edit",
): { text: string; keyboard: InlineKeyboard; markdown: boolean } {
  const locale = settingsService(backendDb).locale(actorId);
  if (step === "thread_edit") {
    const card = publicationRenderers(backendDb, config).post.card({ actorId, publicationId: draftId, locale, view: "thread" });
    return { text: card.text, keyboard: card.keyboard, markdown: true };
  }
  const parts = createStudioServices(backendDb, config).posts.get(actorId, draftId).thread.length + 1;
  return {
    text: t(locale, "action.thread-part-added", { parts }),
    keyboard: new InlineKeyboard()
      .text(t(locale, "action.thread-more"), publicationCallback("post", "thread_add", [draftId]))
      .text(t(locale, "action.thread-done"), publicationCallback("post", "thread_done", [draftId])),
    markdown: false,
  };
}

function threadPartSaved(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  step: "thread_part" | "thread_edit",
): PublicationEffect[] {
  const screen = threadPartScreen(backendDb, config, actorId, draftId, step);
  const options = { ...(screen.markdown ? { parse_mode: "Markdown" as const } : {}), reply_markup: screen.keyboard };
  // The add-or-finish question is not the card: the card is repainted when the
  // English arrives, and that repaint took these buttons away seconds after
  // they appeared. The thread review after a rewrite is the card.
  if (step === "thread_part") return [{ type: "screen", text: screen.text, options }];
  return [{ type: "screen", text: screen.text, options, card: { kind: "post", draftId } }];
}

function renderPostScheduleConfirmation(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  state: { revision: number; data: Record<string, unknown> },
): PublicationEffect[] {
  const locale = settingsService(backendDb).locale(actorId);
  const step = postStateStep({ step: "schedule_confirm", data: state.data });
  if (step?.type !== "schedule_confirm") throw new StudioError("action.schedule-expired");
  const posts = createStudioServices(backendDb, config).posts;
  const timeConfig = createStudioServices(backendDb, config).settings.timeConfig(actorId, config);
  const card = publicationRenderers(backendDb, config).post.card({
    actorId,
    publicationId: draftId,
    locale,
  });
  const engine = createPublicationScheduleEngine({
    kind: "post",
    publicationId: draftId,
    scheduleAxis: "locale",
    axisKeys: [step.locale],
    axisLabel: (key) => key.toUpperCase(),
    slotValues: [],
  });
  return scheduleConfirmationEffects({
    kind: "post",
    publicationId: draftId,
    intro: card.text,
    title: t(locale, "common.confirm-schedule"),
    titlePrefix: "📅",
    entries: [{ key: step.locale, value: step.value }],
    label: (key) => key.toUpperCase(),
    formatValue: (value) => formatZonedDateTime(value, timeConfig.TIMEZONE, timeConfig.TIMEZONE_LABEL),
    keyboard: confirmationKeyboard(
      { label: t(locale, "post.confirm-schedule-btn"), callback: engine.confirmCallback() },
      {
        label: t(locale, "common.back"),
        callback: publicationCallback("post", "view", [draftId, step.locale === "ru" ? "schedule_ru" : "schedule_en"]),
      },
      state.revision,
    ),
    effects: [{ type: "delivery-previews", projections: posts.preview(actorId, draftId).delivery.projections, locale }],
  });
}
