import { and, desc, eq, gte, like, type SQL } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { publicationEvents } from "../db/schema.js";

export type JournalQuery = {
  since?: string | undefined;
  type?: string | undefined;
  severity?: "info" | "warn" | "error" | undefined;
  ref?: string | undefined;
  limit: number;
};

/** The journal, read directly.
 *
 * Every other reader of this table arrives with a publication in hand:
 * `timeline` wants one, `audit` wants the last thirty days of delivery. What
 * neither reaches is an event about nothing in particular -- a bug report filed
 * through the Studio's own feedback tool, a restart loop, a token that is about
 * to expire. Those are recorded "where its operator will see it", and until
 * this there was no command that showed them. */
export function journalEvents(backendDb: BackendDb, query: JournalQuery): Record<string, unknown> {
  const filters: SQL[] = [];
  if (query.since) filters.push(gte(publicationEvents.createdAt, query.since));
  // A prefix, because the useful question is about a family of events --
  // `runtime.`, `mcp.`, `publish.job.` -- far more often than about one type.
  if (query.type) filters.push(like(publicationEvents.eventType, `${query.type}%`));
  if (query.severity) filters.push(eq(publicationEvents.severity, query.severity));
  if (query.ref) filters.push(eq(publicationEvents.publicationKey, query.ref));
  const where = filters.length ? and(...filters) : undefined;
  const rows = unsafeDb(backendDb)
    .db.select({
      id: publicationEvents.id,
      ref: publicationEvents.publicationKey,
      eventType: publicationEvents.eventType,
      severity: publicationEvents.severity,
      target: publicationEvents.target,
      message: publicationEvents.message,
      details: publicationEvents.detailsJson,
      createdAt: publicationEvents.createdAt,
    })
    .from(publicationEvents)
    .where(where)
    .orderBy(desc(publicationEvents.createdAt), desc(publicationEvents.id))
    .limit(query.limit)
    .all();
  return {
    query: { since: query.since ?? null, type: query.type ?? null, severity: query.severity ?? null, ref: query.ref ?? null },
    count: rows.length,
    // A full page is a truncated answer, and a caller that does not know it was
    // truncated reads the oldest row as the beginning of the story.
    truncated: rows.length === query.limit,
    events: rows.map((row) => ({ ...row, details: parseDetails(row.details) })),
  };
}

function parseDetails(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
