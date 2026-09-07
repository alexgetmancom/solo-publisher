export type PublicationKind = "post" | "video";

/** Transport-neutral shape for a conversational publication workflow. */
type FlowAcceptance<TData, TEffect = never> = {
  data: TData;
  effects?: readonly TEffect[];
};

/** What a step expects from the transport. Steps without one are reached by a
 * control (a button), not by something the operator sends, so a message adapter
 * must leave them alone instead of guessing. A "text_file" step reads the same
 * answer either typed or attached as the file it was written in, so an empty
 * message there is not yet an empty answer. */
type FlowStepInput = "text" | "text_file" | "media";

export type FlowStep<TData, TInput = unknown, TEffect = never, TStep extends string = string> = {
  name: TStep;
  input?: FlowStepInput;
  accept?: (input: TInput, data: TData) => TData | FlowAcceptance<TData, TEffect> | Promise<TData | FlowAcceptance<TData, TEffect>>;
  next: (data: TData) => TStep | null;
  back?: (data: TData) => TStep | null;
};

export type Flow<TData, TInput = unknown, TEffect = never, TStep extends string = string> = {
  kind: PublicationKind;
  steps: Record<TStep, FlowStep<TData, TInput, TEffect, TStep>>;
};

type FlowTransition<TData, TEffect = never, TStep extends string = string> = {
  data: TData;
  next: TStep | null;
  effects: readonly TEffect[];
};

/** Executes one transport-neutral step transition for an adapter. */
export async function acceptFlow<TData, TInput, TEffect = never, TStep extends string = string>(
  flow: Flow<TData, TInput, TEffect, TStep>,
  stepName: string,
  input: TInput,
  data: TData,
): Promise<FlowTransition<TData, TEffect, TStep> | null> {
  const step = flow.steps[stepName as TStep];
  if (!step?.accept) return null;
  const accepted = await step.accept(input, data);
  const nextData = isFlowAcceptance<TData, TEffect>(accepted) ? accepted.data : accepted;
  return {
    data: nextData,
    next: step.next(nextData),
    effects: isFlowAcceptance<TData, TEffect>(accepted) ? (accepted.effects ?? []) : [],
  };
}

/** The step a "back" control returns to, or null when nothing precedes it. */
export function backFlow<TData, TInput, TEffect = never, TStep extends string = string>(
  flow: Flow<TData, TInput, TEffect, TStep>,
  stepName: string,
  data: TData,
): TStep | null {
  return flow.steps[stepName as TStep]?.back?.(data) ?? null;
}

/** What the step at `stepName` expects an adapter to deliver, or null when the
 * step is not driven by operator input at all (or does not exist). */
export function flowStepInput<TData, TInput, TEffect = never>(flow: Flow<TData, TInput, TEffect>, stepName: string): FlowStepInput | null {
  return flow.steps[stepName]?.input ?? null;
}

function isFlowAcceptance<TData, TEffect>(value: TData | FlowAcceptance<TData, TEffect>): value is FlowAcceptance<TData, TEffect> {
  return typeof value === "object" && value !== null && "data" in value && "effects" in value;
}
