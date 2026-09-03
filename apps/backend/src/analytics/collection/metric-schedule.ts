import crypto from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { TARGET_GROUPS } from "../../botTargets.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { drafts, metricSchedule, publicationTargets } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { metricCheckpointAt } from "./metric-checkpoints.js";

/** The public t.me page answers in about 90ms or not at all, and a failed
 * check simply returns in 15 minutes. */
export const MAX_METRIC_TASKS_PER_CYCLE = 30;

/** How long a metric-collection lock outlives the worker holding it. */
export const METRIC_LOCK_TIMEOUT_SECONDS = 900;

export type MetricTask = {
  publicationKey: string;
  target: string;
  checkCount: number;
  messageId: number;
  dateUtc: string | null;
  externalId: string | null;
  externalIds: string[];
  url: string | null;
  lockId: string;
};

const PAID_METRIC_TARGETS = TARGET_GROUPS.x;

export function ensureMetricSchedule(backendDb: BackendDb, targets: readonly string[]): void {
  if (targets.length === 0) return;
  const rows = unsafeDb(backendDb)
    .db.select({
      publicationKey: publicationTargets.publicationKey,
      dateUtc: publicationTargets.publishedAt,
      target: publicationTargets.target,
    })
    .from(drafts)
    .innerJoin(publicationTargets, eq(publicationTargets.publicationKey, sql`'post:' || ${drafts.postId}`))
    .leftJoin(
      metricSchedule,
      and(eq(metricSchedule.publicationKey, publicationTargets.publicationKey), eq(metricSchedule.target, publicationTargets.target)),
    )
    .where(
      and(
        eq(publicationTargets.status, "published"),
        inArray(publicationTargets.target, [...targets]),
        isNull(metricSchedule.publicationKey),
      ),
    )
    .all();
  const now = new Date().toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const row of rows) {
      const publishedAt = parseDate(row.dateUtc);
      tx.insert(metricSchedule)
        .values({
          publicationKey: row.publicationKey,
          target: row.target,
          nextCheckAt: metricCheckpointAt(publishedAt.toISOString(), 0, publishedAt)?.toISOString() ?? publishedAt.toISOString(),
          frozenAt: null,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
  });
}

export function claimDueMetricTasks(
  backendDb: BackendDb,
  config: BackendConfig,
  targets: readonly string[],
  worker = `metrics:${crypto.randomUUID()}`,
): MetricTask[] {
  if (targets.length === 0) return [];
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - METRIC_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const rows = unsafeDb(backendDb)
    .db.select({
      publicationKey: metricSchedule.publicationKey,
      target: metricSchedule.target,
      checkCount: metricSchedule.checkCount,
      messageId: sql<number>`${drafts.postId}`,
      dateUtc: publicationTargets.publishedAt,
      externalId: publicationTargets.externalId,
      externalIds: publicationTargets.externalIdsJson,
      url: publicationTargets.url,
      lockedBy: metricSchedule.lockedBy,
      lockedAt: metricSchedule.lockedAt,
    })
    .from(metricSchedule)
    .innerJoin(drafts, eq(metricSchedule.publicationKey, sql`'post:' || ${drafts.postId}`))
    .innerJoin(
      publicationTargets,
      and(eq(publicationTargets.publicationKey, metricSchedule.publicationKey), eq(publicationTargets.target, metricSchedule.target)),
    )
    .where(
      and(
        isNull(metricSchedule.frozenAt),
        eq(publicationTargets.status, "published"),
        inArray(metricSchedule.target, [...targets]),
        ...(config.ENABLE_X_METRICS ? [] : [notInArray(metricSchedule.target, [...PAID_METRIC_TARGETS])]),
        or(isNull(metricSchedule.nextCheckAt), lte(metricSchedule.nextCheckAt, now)),
        or(isNull(metricSchedule.lockedBy), isNull(metricSchedule.lockedAt), lt(metricSchedule.lockedAt, cutoff)),
      ),
    )
    // Oldest due work must win. Ordering by the post date starved historical
    // checkpoints indefinitely whenever newer posts kept becoming due.
    .orderBy(asc(metricSchedule.nextCheckAt), asc(metricSchedule.checkCount), asc(publicationTargets.publishedAt))
    .limit(MAX_METRIC_TASKS_PER_CYCLE)
    .all();
  const claimed: MetricTask[] = [];
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const row of rows) {
      const locked = tx
        .update(metricSchedule)
        .set({ lockedBy: worker, lockedAt: now, updatedAt: now })
        .where(
          and(
            eq(metricSchedule.publicationKey, row.publicationKey),
            eq(metricSchedule.target, row.target),
            or(isNull(metricSchedule.lockedBy), isNull(metricSchedule.lockedAt), lt(metricSchedule.lockedAt, cutoff)),
          ),
        )
        .returning({ publicationKey: metricSchedule.publicationKey })
        .get();
      if (!locked) continue;
      claimed.push({
        publicationKey: row.publicationKey,
        target: row.target,
        checkCount: row.checkCount,
        messageId: row.messageId,
        dateUtc: row.dateUtc,
        externalId: row.externalId,
        externalIds: row.externalIds ?? (row.externalId ? [row.externalId] : []),
        url: row.url,
        lockId: worker,
      });
    }
  });
  return claimed;
}

export function finishMetricTask(
  backendDb: BackendDb,
  task: MetricTask,
  error: string | null,
  terminal = false,
  db = unsafeDb(backendDb).db,
): void {
  const now = new Date();
  const nextIndex = error ? task.checkCount : task.checkCount + 1;
  const nextCheckpoint = terminal ? null : error ? new Date(now.getTime() + 15 * 60_000) : metricCheckpointAt(task.dateUtc, nextIndex, now);
  db.update(metricSchedule)
    .set({
      nextCheckAt: nextCheckpoint?.toISOString() ?? null,
      lastCheckedAt: now.toISOString(),
      checkCount: error ? task.checkCount : sql`${metricSchedule.checkCount} + 1`,
      frozenAt: nextCheckpoint == null ? now.toISOString() : null,
      lastError: error,
      lockedBy: null,
      lockedAt: null,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(metricSchedule.publicationKey, task.publicationKey),
        eq(metricSchedule.target, task.target),
        eq(metricSchedule.lockedBy, task.lockId),
      ),
    )
    .run();
}

/**
 * Retires schedules whose target no longer has a collector at all — targets removed
 * from the catalogue keep rows that can never be checked, and before they were frozen
 * they stayed permanently overdue and counted as backlog. Paid targets are exempt:
 * they are switched by `ENABLE_X_METRICS`, so freezing them here would retire a target
 * that is merely turned off today. Pass the statically supported set, never the
 * credential-dependent one, so a missing token cannot retire a live schedule.
 */
export function freezeUnsupportedMetricSchedules(backendDb: BackendDb, supported: readonly string[]): void {
  if (supported.length === 0) return;
  const now = new Date().toISOString();
  unsafeDb(backendDb)
    .db.update(metricSchedule)
    .set({ frozenAt: now, nextCheckAt: null, lastError: null, updatedAt: now })
    .where(and(isNull(metricSchedule.frozenAt), notInArray(metricSchedule.target, [...supported, ...PAID_METRIC_TARGETS])))
    .run();
}

export function freezeDisabledMetricSchedules(backendDb: BackendDb, targets: readonly string[]): void {
  if (targets.length === 0) return;
  const now = new Date().toISOString();
  unsafeDb(backendDb)
    .db.update(metricSchedule)
    .set({ frozenAt: now, nextCheckAt: null, lastError: null, updatedAt: now })
    .where(and(isNull(metricSchedule.frozenAt), inArray(metricSchedule.target, [...targets])))
    .run();
}

function parseDate(value: string | null): Date {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
