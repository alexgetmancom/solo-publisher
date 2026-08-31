import { and, eq, gte, isNull } from "drizzle-orm";
import type { Clock, DomainEventInput, EventStore } from "../../application/ports.js";
import { ringWorker } from "../../foundation/worker-signal.js";
import { publicationEvents } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** Durable SQLite implementation of the application event port. */
export function createEventStore(db: BackendDatabase, clock: Clock): EventStore {
  return {
    record: (input) => recordEvent(db, clock, input),
  };
}

/** Same event implementation against either the root database or a transaction handle. */
export function recordEvent(db: Pick<BackendDatabase, "select" | "insert">, clock: Clock, input: DomainEventInput): boolean {
  // Every domain event reaches an operator through the Telegram consumer, which
  // polls. One funnel, so no producer can forget to ring.
  ringWorker("telegram-events");
  const now = clock.now().toISOString();
  const ref = input.ref ?? null;
  const target = input.target ?? null;
  if (input.cooldownSeconds) {
    const cutoff = new Date(clock.now().getTime() - input.cooldownSeconds * 1000).toISOString();
    const refCondition = ref == null ? isNull(publicationEvents.publicationKey) : eq(publicationEvents.publicationKey, ref);
    const targetCondition = target == null ? isNull(publicationEvents.target) : eq(publicationEvents.target, target);
    const duplicate = db
      .select({ id: publicationEvents.id })
      .from(publicationEvents)
      .where(and(refCondition, eq(publicationEvents.eventType, input.type), targetCondition, gte(publicationEvents.createdAt, cutoff)))
      .get();
    if (duplicate) return false;
  }
  db.insert(publicationEvents)
    .values({
      publicationKey: ref,
      eventType: input.type,
      severity: input.severity,
      target,
      message: input.message,
      detailsJson: JSON.stringify(input.details ?? {}),
      createdAt: now,
    })
    .run();
  return true;
}
