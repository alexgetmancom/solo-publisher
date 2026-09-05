import type { Context } from "grammy";
import { flowStepInput } from "../application/conversation-flow.js";
import { mediaSizeAdvice } from "../content/media-size-advice.js";
import type { DraftMessage } from "../content/message.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { appendPendingAlbum } from "./albums.js";
import { clearConversationState, getConversationState } from "./conversation-state.js";
import type { PublicationEffect, PublicationMessageResult } from "./effects.js";
import { describePublicationError } from "./error-text.js";
import { persistentKeyboard } from "./menu-render.js";
import { extractMessage } from "./message.js";
import { POST_FLOW, postStateStep } from "./post-flow.js";
import { applyAdminState } from "./post-input-actions.js";
import { postPreviewCard } from "./publication-renderers.js";

/** The conversational text-post screen. It owns operator input from the moment
 * the intake decides the material is a post, and keeps the root bot router
 * limited to authorization and screen dispatch. */
export async function handlePostMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<PublicationMessageResult> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const state = getConversationState(backendDb, actorId, "post");
  const stateStep = postStateStep(state);
  const message = extractMessage(ctx);
  const mediaGroupId = ctx.message && "media_group_id" in ctx.message ? ctx.message.media_group_id : undefined;
  if (mediaGroupId && message.media.length > 0) {
    const media = message.media[0];
    if (!media) return { handled: true, effects: [] };
    // An album is several messages: the collector settles them into one draft a
    // few seconds later. Without an open edit it is new material — the intake
    // hands albums straight here, because several photos can only be a post.
    const editing = stateStep && state?.draftId ? { step: stateStep, draftId: state.draftId, revision: state.revision } : null;
    const isNew = appendPendingAlbum(backendDb, {
      actorId,
      chatId: Number(ctx.chat?.id),
      mediaGroupId,
      text: message.text,
      entities: message.entities,
      media,
      step: editing?.step ?? null,
      draftId: editing?.draftId ?? null,
      stateRevision: editing?.revision ?? null,
    });
    return { handled: true, effects: isNew ? [{ type: "screen", text: t(locale, "post.album-received") }] : [] };
  }
  if (stateStep && flowStepInput(POST_FLOW, stateStep.type) && state?.draftId) {
    try {
      const effects = await applyAdminState(ctx, backendDb, config, stateStep, state.draftId, state.controlMessageId, state.revision);
      return { handled: true, effects };
    } catch (error) {
      const scheduleInput = stateStep.type === "schedule_manual";
      const errorText = describePublicationError(
        locale,
        error,
        createStudioServices(backendDb, config).settings.timeConfig(actorId, config),
      );
      return {
        handled: true,
        effects: [{ type: "screen", text: scheduleInput ? errorText : t(locale, "post.value-error", { error: errorText }) }],
      };
    }
  }
  // Nothing is open and this is not an album: the intake is the way in, and
  // guessing what an unannounced message is meant to be is its job, not ours.
  return {
    handled: true,
    effects: [{ type: "screen", text: t(locale, "post.need-new-post"), options: { reply_markup: persistentKeyboard(locale) } }],
  };
}

/** Turns captured material into a post draft and its preview card. The intake
 * calls this from a button press and the post screen from the message itself;
 * one implementation, so a post made either way is the same post.
 *
 * Nothing is asked of a provider on the way: the English translation is queued
 * with the draft and lands in this same card a moment later. Waiting for it here
 * was the difference between a card in 100ms and a card in two seconds. */
export async function createPostFromMessage(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  message: DraftMessage,
): Promise<PublicationEffect[]> {
  const draftId = createStudioServices(backendDb, config).posts.create(actorId, message);
  clearConversationState(backendDb, actorId, "post");
  const preview = postPreviewCard(backendDb, config, actorId, draftId);
  // Advice ahead of the card, never after it: the card carries the buttons the
  // advice points at, and it stays the last thing in the chat.
  const advice = mediaSizeAdvice(message.media);
  const locale = settingsService(backendDb).locale(actorId);
  return [
    ...(advice
      ? [
          {
            type: "screen" as const,
            text: t(locale, "post.media-large", { megabytes: advice.megabytes, recommended: advice.recommendedMegabytes }),
          },
        ]
      : []),
    {
      type: "screen",
      text: preview.text,
      options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
      card: { kind: "post", draftId },
    },
  ];
}
