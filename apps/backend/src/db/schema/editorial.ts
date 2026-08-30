import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { autoId, json, timestamps } from "./_shared.js";

/** One pass of one producer, kept whether it found anything or not.
 *
 * The raw answer is stored beside the candidates parsed out of it. A Grok pass
 * costs a quarter of an hour of somebody else's compute, so re-reading what it
 * said must never mean asking again -- and when the parse is wrong, the run is
 * the only place the evidence exists. */
export const editorialRuns = sqliteTable(
  "editorial_runs",
  {
    id: autoId(),
    /** `news` searches the outside world, `ideas` reads this Studio's archive. */
    producer: text().notNull(),
    status: text().notNull(), // running, done, failed
    rawText: text(),
    error: text(),
    candidateCount: integer().notNull().default(0),
    duplicateCount: integer().notNull().default(0),
    startedAt: text().notNull(),
    finishedAt: text(),
  },
  (table) => [index("idx_editorial_runs_producer_started").on(table.producer, table.startedAt)],
);

/** A found story or idea, the decision made about it, and the draft it became.
 *
 * This row is the whole point of the radar: the digest and the inbox both wrote
 * their findings into a chat message, so nothing could be answered, counted or
 * kept from being offered twice. */
export const editorialCandidates = sqliteTable(
  "editorial_candidates",
  {
    id: autoId(),
    runId: integer().notNull(),
    producer: text().notNull(),
    /** What makes two findings the same story. Unique, so the same subject
     * arriving tomorrow under another headline or another link is not offered
     * again -- which is what a stored digest would otherwise do daily. */
    clusterKey: text().notNull(),
    title: text().notNull(),
    summary: text().notNull().default(""),
    /** Why this is being offered, in the operator's language. */
    reason: text().notNull().default(""),
    url: text(),
    sourceHost: text(),
    /** Published posts this grew out of, for an archive idea. */
    relatedPostIdsJson: json<number[]>().notNull().default([]),
    /** Knowledge entity slugs this was matched to, which is what the accept and
     * skip counters are kept by. */
    entitySlugsJson: json<string[]>().notNull().default([]),
    score: integer().notNull().default(0),
    scoreJson: json<Record<string, number>>().notNull().default({}),
    status: text().notNull().default("new"), // new, later, skipped, accepted, expired
    skipReason: text(),
    decidedAt: text(),
    /** When an undecided candidate stops being offered. A news story dies in
     * two days; an archive idea does not expire at all and holds null. */
    expiresAt: text(),
    /** When this was last put in front of the operator. A candidate is pushed
     * once and then waits on the radar screen: pushing it again every morning
     * is what a stored digest would do, and it is how a notification stops
     * being read. */
    offeredAt: text(),
    draftId: integer(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("idx_editorial_candidates_cluster").on(table.clusterKey),
    // The other half of "not the same story twice": one canonical link is one
    // candidate, whatever headline it arrives under. SQLite admits many nulls
    // here, which is what an archive idea carries.
    uniqueIndex("idx_editorial_candidates_url").on(table.url),
    index("idx_editorial_candidates_status_score").on(table.status, table.score),
    index("idx_editorial_candidates_run").on(table.runId),
    index("idx_editorial_candidates_draft").on(table.draftId),
  ],
);

/** What a radar-born publication actually did, kept past metric retention.
 *
 * Detailed samples are swept at 35 days; these two marks are not, because the
 * question they answer -- did the stories this radar offered do anything -- is
 * asked over years. They are read by the report, deliberately not by the
 * ranking: one or two publications a day cannot separate a topic from the
 * platform, the hour and the audience it was published to. */
export const editorialOutcomes = sqliteTable(
  "editorial_outcomes",
  {
    candidateId: integer().notNull(),
    /** `24h` or `7d`. */
    horizon: text().notNull(),
    views: integer().notNull().default(0),
    reactions: integer().notNull().default(0),
    shares: integer().notNull().default(0),
    replies: integer().notNull().default(0),
    capturedAt: text().notNull(),
  },
  (table) => [uniqueIndex("idx_editorial_outcomes_key").on(table.candidateId, table.horizon)],
);
