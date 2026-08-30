import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { editorialCandidates, editorialOutcomes, editorialRuns } from "../db/schema.js";
import { canonicalUrl, clusterKey, SAME_STORY_SIMILARITY, sourceHost, titleSimilarity } from "./cluster.js";

/** Radar persistence. The radar owns these three tables and reaches Drizzle for
 * them directly, the way Analytics and Operations do for theirs. */

export type EditorialProducer = "news" | "ideas";
export type CandidateStatus = "new" | "later" | "skipped" | "accepted" | "expired";

/** Why a candidate was passed over. The reasons differ in meaning, which is the
 * only reason to ask for one: "already covered" says nothing about the subject,
 * while "not my subject" says everything. */
export const SKIP_REASONS = ["off-topic", "already-covered", "weak-source"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type CandidateInput = {
  title: string;
  summary: string;
  reason: string;
  url: string | null;
  relatedPostIds: number[];
  entitySlugs: string[];
};

export type EditorialCandidate = {
  id: number;
  producer: EditorialProducer;
  title: string;
  summary: string;
  reason: string;
  url: string | null;
  sourceHost: string | null;
  relatedPostIds: number[];
  entitySlugs: string[];
  score: number;
  status: CandidateStatus;
  createdAt: string;
};

/** How long a found story is still worth offering. An archive idea holds no
 * expiry at all: "write the hub page for this cluster" is as true next month. */
const NEWS_LIFETIME_HOURS = 48;
/** How far back a new finding is compared for being the same story as an old one. */
const SIMILARITY_WINDOW_DAYS = 14;

export function startRun(backendDb: BackendDb, producer: EditorialProducer): number {
  const startedAt = backendDb.clock.now().toISOString();
  const row = unsafeDb(backendDb)
    .db.insert(editorialRuns)
    .values({ producer, status: "running", startedAt })
    .returning({ id: editorialRuns.id })
    .get();
  return row.id;
}

export function finishRun(
  backendDb: BackendDb,
  runId: number,
  result: { status: "done" | "failed"; rawText?: string | null; error?: string | null; candidates?: number; duplicates?: number },
): void {
  unsafeDb(backendDb)
    .db.update(editorialRuns)
    .set({
      status: result.status,
      rawText: result.rawText ?? null,
      error: result.error ?? null,
      candidateCount: result.candidates ?? 0,
      duplicateCount: result.duplicates ?? 0,
      finishedAt: backendDb.clock.now().toISOString(),
    })
    .where(eq(editorialRuns.id, runId))
    .run();
}

/** Stores what one run found, dropping what this radar has already offered.
 *
 * The two exact collapses are unique indexes, so a duplicate is refused by the
 * database rather than by a check standing apart from the insert. The
 * similarity pass runs before them and catches the restated headline that
 * neither index can see. */
export function storeCandidates(
  backendDb: BackendDb,
  runId: number,
  producer: EditorialProducer,
  scored: (CandidateInput & { score: number; scores: Record<string, number> })[],
): { inserted: number; duplicates: number } {
  const now = backendDb.clock.now();
  const timestamp = now.toISOString();
  const expiresAt = producer === "news" ? new Date(now.getTime() + NEWS_LIFETIME_HOURS * 3_600_000).toISOString() : null;
  const recent = recentTitles(backendDb, now);
  let inserted = 0;
  let duplicates = 0;
  for (const item of scored) {
    const url = canonicalUrl(item.url);
    const key = clusterKey(item.title);
    if (recent.some((title) => titleSimilarity(title, item.title) >= SAME_STORY_SIMILARITY)) {
      duplicates += 1;
      continue;
    }
    const row = unsafeDb(backendDb)
      .db.insert(editorialCandidates)
      .values({
        runId,
        producer,
        clusterKey: key,
        title: item.title,
        summary: item.summary,
        reason: item.reason,
        url,
        sourceHost: sourceHost(url),
        relatedPostIdsJson: item.relatedPostIds,
        entitySlugsJson: item.entitySlugs,
        score: item.score,
        scoreJson: item.scores,
        expiresAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing()
      .returning({ id: editorialCandidates.id })
      .get();
    if (row) {
      inserted += 1;
      recent.push(item.title);
    } else duplicates += 1;
  }
  return { inserted, duplicates };
}

function recentTitles(backendDb: BackendDb, now: Date): string[] {
  const since = new Date(now.getTime() - SIMILARITY_WINDOW_DAYS * 86_400_000).toISOString();
  return unsafeDb(backendDb)
    .db.select({ title: editorialCandidates.title })
    .from(editorialCandidates)
    .where(gte(editorialCandidates.createdAt, since))
    .all()
    .map((row) => row.title);
}

export function candidateCounts(backendDb: BackendDb): { waiting: number; later: number } {
  const rows = unsafeDb(backendDb)
    .db.select({ status: editorialCandidates.status, count: sql<number>`count(*)` })
    .from(editorialCandidates)
    .where(inArray(editorialCandidates.status, ["new", "later"]))
    .groupBy(editorialCandidates.status)
    .all();
  const of = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
  return { waiting: of("new"), later: of("later") };
}

export function listCandidates(backendDb: BackendDb, status: CandidateStatus, limit: number): EditorialCandidate[] {
  return unsafeDb(backendDb)
    .db.select()
    .from(editorialCandidates)
    .where(eq(editorialCandidates.status, status))
    .orderBy(desc(editorialCandidates.score), desc(editorialCandidates.createdAt))
    .limit(limit)
    .all()
    .map(toCandidate);
}

/** Candidates never yet put in front of the operator, best first. */
export function unofferedCandidates(backendDb: BackendDb, limit: number): EditorialCandidate[] {
  return unsafeDb(backendDb)
    .db.select()
    .from(editorialCandidates)
    .where(and(eq(editorialCandidates.status, "new"), isNull(editorialCandidates.offeredAt)))
    .orderBy(desc(editorialCandidates.score), desc(editorialCandidates.createdAt))
    .limit(limit)
    .all()
    .map(toCandidate);
}

export function markOffered(backendDb: BackendDb, ids: readonly number[]): void {
  if (ids.length === 0) return;
  const now = backendDb.clock.now().toISOString();
  unsafeDb(backendDb)
    .db.update(editorialCandidates)
    .set({ offeredAt: now, updatedAt: now })
    .where(and(inArray(editorialCandidates.id, [...ids]), isNull(editorialCandidates.offeredAt)))
    .run();
}

export function getCandidate(backendDb: BackendDb, id: number): EditorialCandidate | null {
  const row = unsafeDb(backendDb).db.select().from(editorialCandidates).where(eq(editorialCandidates.id, id)).get();
  return row ? toCandidate(row) : null;
}

/** Records a decision, and says whether this tap is the one that made it.
 *
 * The status the decision was taken under is in the `WHERE`, so the second tap
 * on a card left open in the chat -- or on yesterday's -- changes nothing and
 * is told so, instead of overwriting a decision already made. */
export function decideCandidate(
  backendDb: BackendDb,
  id: number,
  decision: { status: "later" | "skipped"; skipReason?: SkipReason },
): boolean {
  const now = backendDb.clock.now().toISOString();
  const updated = unsafeDb(backendDb)
    .db.update(editorialCandidates)
    .set({
      status: decision.status,
      ...(decision.skipReason ? { skipReason: decision.skipReason } : {}),
      decidedAt: now,
      updatedAt: now,
    })
    .where(and(eq(editorialCandidates.id, id), inArray(editorialCandidates.status, ["new", "later"])))
    .returning({ id: editorialCandidates.id })
    .all();
  return updated.length > 0;
}

/** Retires undecided findings whose moment has passed. An expiry is a decision
 * the operator did not make, and it is counted as one -- weakly. */
export function expireCandidates(backendDb: BackendDb): number {
  const now = backendDb.clock.now().toISOString();
  return unsafeDb(backendDb)
    .db.update(editorialCandidates)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        inArray(editorialCandidates.status, ["new", "later"]),
        sql`${editorialCandidates.expiresAt} is not null`,
        lt(editorialCandidates.expiresAt, now),
      ),
    )
    .returning({ id: editorialCandidates.id })
    .all().length;
}

export type DecisionCounters = {
  bySlug: Map<string, { accepted: number; skipped: number }>;
  byHost: Map<string, { accepted: number; skipped: number }>;
  accepted: number;
  skipped: number;
};

/** Everything the ranking is allowed to learn from: decisions, counted.
 *
 * Skips that said "already covered" are left out of the subject counters on
 * purpose. They are a statement about one story, not about the subject, and
 * counting them taught the ranking to abandon exactly the clusters this Studio
 * publishes most. */
export function decisionCounters(backendDb: BackendDb): DecisionCounters {
  const rows = unsafeDb(backendDb)
    .db.select({
      status: editorialCandidates.status,
      skipReason: editorialCandidates.skipReason,
      slugs: editorialCandidates.entitySlugsJson,
      host: editorialCandidates.sourceHost,
    })
    .from(editorialCandidates)
    .where(inArray(editorialCandidates.status, ["accepted", "skipped"]))
    .all();
  const counters: DecisionCounters = { bySlug: new Map(), byHost: new Map(), accepted: 0, skipped: 0 };
  for (const row of rows) {
    const accepted = row.status === "accepted";
    if (!accepted && row.skipReason === "already-covered") continue;
    if (accepted) counters.accepted += 1;
    else counters.skipped += 1;
    const bump = (map: Map<string, { accepted: number; skipped: number }>, key: string) => {
      const entry = map.get(key) ?? { accepted: 0, skipped: 0 };
      if (accepted) entry.accepted += 1;
      else entry.skipped += 1;
      map.set(key, entry);
    };
    for (const slug of row.slugs) bump(counters.bySlug, slug);
    // A weak source is a statement about the source; nothing else is.
    if (row.host && (accepted || row.skipReason === "weak-source")) bump(counters.byHost, row.host);
  }
  return counters;
}

/** Accepted candidates whose publication has not yet been measured at `horizon`. */
export function candidatesAwaitingOutcome(backendDb: BackendDb, horizon: "24h" | "7d", before: string) {
  const measured = unsafeDb(backendDb)
    .db.select({ candidateId: editorialOutcomes.candidateId })
    .from(editorialOutcomes)
    .where(eq(editorialOutcomes.horizon, horizon));
  return unsafeDb(backendDb)
    .db.select({ id: editorialCandidates.id, draftId: editorialCandidates.draftId, decidedAt: editorialCandidates.decidedAt })
    .from(editorialCandidates)
    .where(
      and(
        eq(editorialCandidates.status, "accepted"),
        sql`${editorialCandidates.draftId} is not null`,
        lt(editorialCandidates.decidedAt, before),
        sql`${editorialCandidates.id} not in ${measured}`,
      ),
    )
    .all();
}

export function recordOutcome(
  backendDb: BackendDb,
  candidateId: number,
  horizon: "24h" | "7d",
  metrics: { views: number; reactions: number; shares: number; replies: number },
): void {
  unsafeDb(backendDb)
    .db.insert(editorialOutcomes)
    .values({ candidateId, horizon, ...metrics, capturedAt: backendDb.clock.now().toISOString() })
    .onConflictDoNothing()
    .run();
}

/** What accepted findings did, by subject: the report the outcomes exist for.
 * Read by an operator deciding whether to change the line, never by the ranking. */
export function outcomeReport(backendDb: BackendDb, horizon: "24h" | "7d") {
  return unsafeDb(backendDb)
    .db.select({
      candidateId: editorialOutcomes.candidateId,
      title: editorialCandidates.title,
      producer: editorialCandidates.producer,
      views: editorialOutcomes.views,
      reactions: editorialOutcomes.reactions,
      shares: editorialOutcomes.shares,
      replies: editorialOutcomes.replies,
    })
    .from(editorialOutcomes)
    .innerJoin(editorialCandidates, eq(editorialCandidates.id, editorialOutcomes.candidateId))
    .where(eq(editorialOutcomes.horizon, horizon))
    .orderBy(desc(editorialOutcomes.capturedAt))
    .limit(20)
    .all();
}

export function lastRun(backendDb: BackendDb, producer: EditorialProducer) {
  return (
    unsafeDb(backendDb)
      .db.select()
      .from(editorialRuns)
      .where(eq(editorialRuns.producer, producer))
      .orderBy(desc(editorialRuns.startedAt))
      .limit(1)
      .get() ?? null
  );
}

export function recentRuns(backendDb: BackendDb, limit: number) {
  return unsafeDb(backendDb).db.select().from(editorialRuns).orderBy(desc(editorialRuns.startedAt)).limit(limit).all();
}

function toCandidate(row: typeof editorialCandidates.$inferSelect): EditorialCandidate {
  return {
    id: row.id,
    producer: row.producer as EditorialProducer,
    title: row.title,
    summary: row.summary,
    reason: row.reason,
    url: row.url,
    sourceHost: row.sourceHost,
    relatedPostIds: row.relatedPostIdsJson,
    entitySlugs: row.entitySlugsJson,
    score: row.score,
    status: row.status as CandidateStatus,
    createdAt: row.createdAt,
  };
}
