import type { PublicationKind } from "./conversation-flow.js";

export type PublicationScheduleAxis = "locale" | "target";

type PublicationCapabilities = {
  scheduleAxis: PublicationScheduleAxis;
};

export type PublicationSchedule = {
  values: Partial<Record<string, Date>>;
  allowPast?: boolean;
  immediateKey?: string;
};

type PublicationRetrySummary = {
  requeued: number;
  alreadyQueued: number;
};

type PublicationView = {
  id: number;
  status: string;
};

export type Issue = {
  target?: string;
  locale?: "ru" | "en";
  code?: string;
  kind?: string;
  label?: string;
};

type PreviewModel = PublicationView & {
  issues: Issue[];
};

/** The shared application vocabulary implemented directly by each publication service. */
export type PublicationPipeline = {
  kind: PublicationKind;
  capabilities: PublicationCapabilities;
  get(actorId: number, publicationId: number): PublicationView;
  preview(actorId: number, publicationId: number): PreviewModel;
  validate(actorId: number, publicationId: number): Issue[] | Promise<Issue[]>;
  schedule(actorId: number, publicationId: number, schedule: PublicationSchedule): unknown;
  publish(actorId: number, publicationId: number): unknown;
  cancel(actorId: number, publicationId: number): unknown;
  retryTarget(actorId: number, publicationId: number, target: string): PublicationRetrySummary;
  removeTarget(actorId: number, publicationId: number, target: string): unknown;
  toggleTarget(actorId: number, publicationId: number, target: string): unknown;
  slotTime(actorId: number, clock: string): Date;
};
