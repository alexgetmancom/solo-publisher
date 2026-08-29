import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { t } from "../foundation/i18n/index.js";
import { formatZonedDateTime } from "../foundation/time.js";
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
  const message = extractMessage(ctx);
  const input: PostFlowInput = { backendDb, config, actorId, draftId, controlMessageId, step, message };
  const session = requireConversationState(backendDb, actorId, "post", expectedRevision ?? null);
  const saved = await advancePublicationFlow(backendDb, actorId, POST_FLOW, session, input, session.data, "action.session-stale");
  if (saved.step === "schedule_confirm") return renderPostScheduleConfirmation(backendDb, config, actorId, draftId, saved);
  const preview = postPreviewCard(backendDb, config, actorId, draftId);
  return [{ type: "session", operation: "clear", kind: "post", actorId }, ...publicationCardEffect(preview, { type: "prompt" })];
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
