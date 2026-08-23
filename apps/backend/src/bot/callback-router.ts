import type { Menu } from "@grammyjs/menu";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { type MessageKey, t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { runCallbackAction } from "./callback-effects.js";
import { isSupersededCard } from "./card-freshness.js";
import { getActiveConversationState, getConversationState } from "./conversation-state.js";
import { executePublicationEffects, type PublicationEffect, type PublicationMessageResult } from "./effects.js";
import { describePublicationError } from "./error-text.js";
import { handlePostMessage } from "./post-screen.js";
import type {
  PublicationActionContext,
  PublicationActionDefinition,
  PublicationDraftActionContext,
} from "./publication-action-contract.js";
import { isFreshPublicationAction, logPublicationActionError, publicationAction } from "./publication-actions.js";
import {
  type PublicationCallback,
  type PublicationKind,
  parseDraftId,
  parseSessionCallback,
  requireSessionRevision,
} from "./publication-callback.js";
import { publicationRenderers } from "./publication-renderers.js";
import { screenCallback } from "./screen-callback.js";
import { handleVideoConversationMessage } from "./video-conversation.js";

type CallbackRouterContext = Omit<PublicationActionContext, "args" | "pipeline" | "services" | "renderer"> & {
  data: string;
  rawArgs: string[];
};

type PublicationMessageHandler = (ctx: Context, backendDb: BackendDb, config: BackendConfig) => Promise<PublicationMessageResult>;

const PUBLICATION_MESSAGE_HANDLERS: Record<PublicationKind, PublicationMessageHandler> = {
  post: handlePostMessage,
  video: handleVideoConversationMessage,
};

const INVALID_ENTITY_TEXT: Record<PublicationKind, MessageKey> = {
  post: "action.invalid-post",
  video: "err.video-reopen-create",
};

const UNKNOWN_KEYBOARD = (locale: StudioLocale): InlineKeyboard =>
  new InlineKeyboard().text(t(locale, "menu.work-queue"), screenCallback("queue_home"));

/** Dispatches a Telegram publication callback through the single action registry. */
export async function handlePublicationCallback(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  mainMenu?: Menu<Context>,
): Promise<boolean> {
  const rawData = ctx.callbackQuery?.data;
  if (!rawData) return false;
  const parsed = parseSessionCallback(rawData);
  const callback = parsed.callback;
  if (!callback) return false;

  const actorId = Number(ctx.from?.id);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) return false;
  const locale = settingsService(backendDb).locale(actorId);
  const action = publicationAction(callback.kind, callback.action);
  const common = {
    ctx,
    backendDb,
    config,
    actorId,
    locale,
    data: parsed.data,
    callback,
    action: callback.action,
    revision: parsed.revision,
    rawArgs: callback.args,
    mainMenu,
    invalidEntityCode: INVALID_ENTITY_TEXT[callback.kind],
  } satisfies CallbackRouterContext;
  const services = createStudioServices(backendDb, config);

  await runCallbackAction(
    ctx,
    backendDb,
    {
      locale,
      lockKey: `${actorId}:${parsed.data}`,
      describe: (error) => describePublicationError(locale, error, services.settings.timeConfig(actorId, config)),
      onError: (error) => logPublicationActionError(common, error),
    },
    async () => {
      if (!action) return staleEffects(locale, true);

      const pipeline = { post: services.posts, video: services.videos }[callback.kind];
      const renderer = publicationRenderers(backendDb, config, services)[callback.kind];
      const draftId = action.entity === "draft" ? parseDraftId(callback.args[0]) : undefined;
      if (action.entity === "draft" && draftId == null)
        return [{ type: "answer-callback", text: t(locale, INVALID_ENTITY_TEXT[callback.kind]) }];
      if (!hasDeclaredArguments(action, callback.args, action.entity === "draft")) return staleEffects(locale, false);

      const session = getConversationState(backendDb, actorId, callback.kind);
      if (action.sessionRevision && parsed.revision == null) return staleEffects(locale, false);
      if (parsed.revision != null) requireSessionRevision(session?.revision, parsed.revision);
      if (action.freshCard && isStaleCardCallback(ctx, backendDb, callback)) return staleEffects(locale, false);
      // Rejects a callback pointing at a draft this actor cannot open, before the handler runs.
      if (draftId != null) pipeline.get(actorId, draftId);

      const actionContext = {
        ...common,
        args: namedArguments(action, callback.args, action.entity === "draft"),
        ...(draftId != null ? { draftId } : {}),
        pipeline,
        services,
        renderer,
        // Only "draft" actions carry a draft id; the handler type demands one, and the guards
        // above guarantee it for exactly those actions.
      } as PublicationDraftActionContext;
      return action.handler(actionContext);
    },
  );
  return true;
}

export function isStaleCardCallback(ctx: Context, backendDb: BackendDb, callback: PublicationCallback): boolean {
  if (!isFreshPublicationAction(callback.kind, callback.action)) return false;
  const draftId = parseDraftId(callback.args[0]);
  return draftId != null && isSupersededCard(ctx, backendDb, callback.kind, draftId);
}

/** Routes a message through the active publication flow, or starts a post when no flow is open. */
export async function handlePublicationMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const actorId = Number(ctx.from?.id);
  const active = getActiveConversationState(backendDb, actorId);
  const opened = await PUBLICATION_MESSAGE_HANDLERS[active?.kind ?? "post"](ctx, backendDb, config);
  // A conversation that declines its own message no longer exists: its session
  // was retired between the two reads. The post screen owns what to say then,
  // and a message must never end up answered by nobody.
  const result = opened.handled ? opened : await handlePostMessage(ctx, backendDb, config);
  if (result.effects.length) await executePublicationEffects(ctx, backendDb, result.effects);
  return result.handled;
}

function hasDeclaredArguments(action: PublicationActionDefinition, callbackArgs: string[], hasDraftId: boolean): boolean {
  const values = hasDraftId ? callbackArgs.slice(1) : callbackArgs;
  return values.length === action.args.length;
}

function namedArguments(
  action: PublicationActionDefinition,
  callbackArgs: string[],
  hasDraftId: boolean,
): Record<string, string | undefined> {
  const values = hasDraftId ? callbackArgs.slice(1) : callbackArgs;
  return Object.fromEntries(action.args.map((name, index) => [name, values[index]]));
}

/** The one answer to a control that no longer means anything: the card was
 * replaced, the dialog moved on, or the action itself is gone. */
function staleEffects(locale: StudioLocale, includeQueue: boolean): PublicationEffect[] {
  const text = t(locale, "action.card-stale");
  const answer = { type: "answer-callback" as const, text };
  if (!includeQueue) return [answer];
  return [answer, { type: "screen", mode: "reply", text, options: { reply_markup: UNKNOWN_KEYBOARD(locale) } }];
}
