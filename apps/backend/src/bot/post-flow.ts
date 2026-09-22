import type { Flow, FlowStep } from "../application/conversation-flow.js";
import type { DraftMessage } from "../content/message.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { createStudioServices } from "../studio/services/index.js";
import type { ConversationState } from "./conversation-state.js";
import type { PublicationEffect } from "./effects.js";

type PostWizardLocale = "ru" | "en";
export type PostSessionStep = "edit_text" | "schedule_manual" | "schedule_confirm" | "thread_part" | "thread_edit";
type PostFlowStep = PostSessionStep | "completed";

export type PostWizardStep =
  | { type: "edit_text"; locale: PostWizardLocale }
  | { type: "schedule_manual"; locale: PostWizardLocale }
  | { type: "schedule_confirm"; locale: PostWizardLocale; value: Date }
  /** The next post of a thread; `thread_edit` replaces the one at `position`. */
  | { type: "thread_part" }
  | { type: "thread_edit"; position: number };

type PostFlowData = Record<string, unknown>;

export type PostFlowInput = {
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  draftId: number;
  controlMessageId: number | null;
  step: PostWizardStep;
  message: DraftMessage;
};

/** The session payload a step carries beside its name. Inverse of `postStateStep`. */
export function postStepData(step: PostWizardStep | null): Record<string, unknown> {
  if (step?.type === "edit_text" || step?.type === "schedule_manual") return { locale: step.locale };
  if (step?.type === "schedule_confirm") return { locale: step.locale, value: step.value.toISOString() };
  if (step?.type === "thread_edit") return { position: step.position };
  return {};
}

const POST_STEPS: Record<PostFlowStep, FlowStep<PostFlowData, PostFlowInput, PublicationEffect, PostFlowStep>> = {
  edit_text: { name: "edit_text", input: "text", next: () => "completed", accept: acceptPostTextEdit },
  schedule_manual: { name: "schedule_manual", input: "text", next: () => "schedule_confirm", accept: acceptManualPostSchedule },
  schedule_confirm: { name: "schedule_confirm", next: () => "completed" },
  thread_part: { name: "thread_part", input: "text", next: () => "completed", accept: acceptThreadPart },
  thread_edit: { name: "thread_edit", input: "text", next: () => "completed", accept: acceptThreadPart },
  completed: { name: "completed", next: () => null },
};

/** The complete post workflow, including input effects and transitions. */
export const POST_FLOW: Flow<PostFlowData, PostFlowInput, PublicationEffect, PostFlowStep> = {
  kind: "post",
  steps: POST_STEPS,
};

export function postStateStep(state: Pick<ConversationState, "step" | "data"> | null): PostWizardStep | null {
  if (!state) return null;
  if (state.step === "edit_text") return localeStep("edit_text", state.data.locale);
  if (state.step === "schedule_manual") return localeStep("schedule_manual", state.data.locale);
  if (state.step === "thread_part") return { type: "thread_part" };
  if (state.step === "thread_edit") {
    const position = Number(state.data.position);
    return Number.isInteger(position) && position >= 2 ? { type: "thread_edit", position } : null;
  }
  if (state.step === "schedule_confirm") {
    const locale = parseLocale(state.data.locale);
    const date = parseDate(state.data.value);
    return locale && date ? { type: "schedule_confirm", locale, value: date } : null;
  }
  return null;
}

function acceptManualPostSchedule(input: PostFlowInput, data: PostFlowData): PostFlowData {
  const { step } = input;
  if (step.type !== "schedule_manual") throw new StudioError("action.session-stale");
  const posts = createStudioServices(input.backendDb, input.config).posts;
  const { ruAt, enAt } = posts.manualSchedule(input.actorId, input.draftId, step.locale, input.message.text);
  const value = step.locale === "ru" ? ruAt : enAt;
  if (!value) throw new StudioError("err.no-pub-time");
  return { ...data, locale: step.locale, value: value.toISOString() };
}

function acceptPostTextEdit(input: PostFlowInput, data: PostFlowData): PostFlowData {
  if (input.step.type !== "edit_text") throw new StudioError("action.session-stale");
  createStudioServices(input.backendDb, input.config).posts.edit(input.actorId, input.draftId, {
    locale: input.step.locale,
    text: input.message.text,
    entities: input.message.entities,
    media: input.message.media,
    clearMedia: isClearMediaCommand(input.message.text),
  });
  return { ...data, input: input.message };
}

function acceptThreadPart(input: PostFlowInput, data: PostFlowData): PostFlowData {
  const posts = createStudioServices(input.backendDb, input.config).posts;
  const part = {
    textRu: input.message.text,
    entitiesRu: input.message.entities.filter((entity): entity is Record<string, unknown> => typeof entity === "object" && entity !== null),
    media: input.message.media,
  };
  if (input.step.type === "thread_part") posts.appendThreadPart(input.actorId, input.draftId, part);
  else if (input.step.type === "thread_edit") posts.editThreadPart(input.actorId, input.draftId, input.step.position, part);
  else throw new StudioError("action.session-stale");
  return data;
}

function localeStep(type: "edit_text" | "schedule_manual", value: unknown): PostWizardStep | null {
  const locale = parseLocale(value);
  return locale ? { type, locale } : null;
}

function parseLocale(value: unknown): PostWizardLocale | null {
  return value === "ru" || value === "en" ? value : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isClearMediaCommand(text: string): boolean {
  const clean = text.trim().toLowerCase();
  return clean === "/delmedia" || clean === "очистить" || clean === "без медиа" || clean === "clear media";
}
