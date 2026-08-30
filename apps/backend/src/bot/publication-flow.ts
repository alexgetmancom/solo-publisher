import { acceptFlow, type Flow } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import { StudioError } from "../foundation/errors.js";
import { type ConversationState, saveConversationState } from "./conversation-state.js";

/** Advances either publication flow and consumes exactly one session revision. */
export async function advancePublicationFlow<
  TData extends Record<string, unknown>,
  TInput,
  TStep extends string,
  TSession extends ConversationState,
>(
  backendDb: BackendDb,
  actorId: number,
  flow: Flow<TData, TInput, unknown, TStep>,
  session: TSession,
  input: TInput,
  data: TData,
  errorCode: string,
  decorateData?: (data: TData, nextStep: TStep) => TData,
): Promise<Omit<TSession, "step" | "data"> & { step: TStep; data: TData }> {
  const transition = await acceptFlow(flow, session.step, input, data);
  if (!transition?.next) throw new StudioError(errorCode);
  const nextStep = transition.next;
  const nextData = decorateData ? decorateData(transition.data, nextStep) : transition.data;
  const saved = saveConversationState(backendDb, actorId, {
    kind: session.kind,
    draftId: session.draftId,
    step: nextStep,
    data: nextData,
    controlMessageId: session.controlMessageId,
    revision: session.revision,
  });
  return { ...session, ...saved, step: nextStep, data: nextData };
}
