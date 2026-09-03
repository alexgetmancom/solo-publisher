import { sql } from "drizzle-orm";
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
export function recordEvent(db: Pick<BackendDatabase, "get">, clock: Clock, input: DomainEventInput): boolean {
  const now = clock.now().toISOString();
  const ref = input.ref ?? null;
  const target = input.target ?? null;
  const cutoff = input.cooldownSeconds ? new Date(clock.now().getTime() - input.cooldownSeconds * 1000).toISOString() : null;
  const result = db.get<number[]>(sql`
    INSERT INTO ${publicationEvents}
      (publication_key, event_type, severity, target, message, details_json, created_at)
    SELECT ${ref}, ${input.type}, ${input.severity}, ${target}, ${input.message}, ${JSON.stringify(input.details ?? {})}, ${now}
    WHERE ${cutoff} IS NULL OR NOT EXISTS (
      SELECT 1 FROM ${publicationEvents}
      WHERE publication_key IS ${ref}
        AND event_type = ${input.type}
        AND target IS ${target}
        AND created_at >= ${cutoff}
    )
    RETURNING 1 AS inserted
  `);
  const inserted = result?.[0] === 1;
  // Every stored event reaches the Telegram consumer, which polls. A suppressed
  // duplicate has nothing to wake it for.
  if (inserted) ringWorker("telegram-events");
  return inserted;
}
