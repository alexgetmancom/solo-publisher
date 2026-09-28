import { t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { definePostActionHandlers } from "./post-actions.js";
import {
  action,
  type PublicationActionDefinition,
  type PublicationActionResult,
  type PublicationDraftActionContext,
} from "./publication-action-contract.js";
import type { PublicationKind } from "./publication-callback.js";
import { publicationCardEffect } from "./publication-renderers.js";
import { defineVideoActionHandlers } from "./video-actions.js";

const sharedActions = {
  view: action(handleView, { entity: "draft", args: ["view"] }),
  retry: action(handleRetry, { entity: "draft", args: ["target", "origin"] }),
} as const satisfies Record<string, PublicationActionDefinition>;

const publicationActions = {
  post: { ...sharedActions, ...definePostActionHandlers(action) },
  video: { ...sharedActions, ...defineVideoActionHandlers(action) },
} as const satisfies Record<PublicationKind, Readonly<Record<string, PublicationActionDefinition>>>;

const ACTION_TABLES: Record<PublicationKind, Readonly<Record<string, PublicationActionDefinition>>> = publicationActions;

export function publicationAction(kind: PublicationKind, name: string): PublicationActionDefinition | undefined {
  return ACTION_TABLES[kind][name];
}

export function publicationActionNames(kind: PublicationKind): string[] {
  return Object.keys(publicationActions[kind]);
}

export function isFreshPublicationAction(kind: PublicationKind, name: string): boolean {
  return publicationAction(kind, name)?.freshCard === true;
}

async function handleView(context: PublicationDraftActionContext): Promise<PublicationActionResult> {
  const card = context.renderer.card({
    actorId: context.actorId,
    publicationId: context.draftId,
    locale: context.locale,
    view: context.args.view,
  });
  return publicationCardEffect(card);
}

async function handleRetry(context: PublicationDraftActionContext): Promise<PublicationActionResult> {
  const target = context.args.target === "all" ? "" : (context.args.target ?? "");
  const result = await context.pipeline.retryTarget(context.actorId, context.draftId, target);
  const toast = {
    type: "toast" as const,
    text: t(context.locale, "action.retry-result", { requeued: result.requeued, alreadyQueued: result.alreadyQueued }),
  };
  if (context.args.origin !== "card") return [toast];
  const card = context.renderer.card({
    actorId: context.actorId,
    publicationId: context.draftId,
    locale: context.locale,
  });
  return [toast, ...publicationCardEffect(card)];
}

export function logPublicationActionError(
  context: Pick<PublicationDraftActionContext, "actorId" | "callback" | "action">,
  error: unknown,
): void {
  log("error", "Publication action failed", {
    actorId: context.actorId,
    kind: context.callback.kind,
    action: context.action,
    error,
  });
}
