import crypto from "node:crypto";
import os from "node:os";
import process from "node:process";
import { and, desc, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { recordPublishedXActivity } from "../analytics/x-activity-store.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { type JsonObject, publicationTargets, publishJobs } from "../db/schema.js";
import { PUBLISH_LOCK_TIMEOUT_SECONDS } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { ringWorker, ringWorkerAfter } from "../foundation/worker-signal.js";
import { recordAuthFailure, recordAuthSuccess } from "../observability/auth-circuit.js";
import { type DeliveryPayload, deferredDeliveryPayload, hasResumeState, resumedDeliveryPayload } from "./delivery-payload.js";
import { classifyPublishError, normalizePublishResult, type PublishResult } from "./errors.js";
import { failedJobTransition, mayHaveReachedAudience, partialPublicationTransition } from "./job-policy.js";
import { refreshPublicationOwner } from "./publication-owner.js";
import {
  deleteSupersededJobs,
  durationSince,
  externalIds,
  insertEvent,
  PublishLockLostError,
  parsePayload,
  partialRetryPolicy,
  publicationConfirmationSource,
  publishRetryPolicy,
  settleJob,
  upsertPostTarget,
  verificationStatus,
} from "./queue-state.js";

const insertPublishJobSchema = createInsertSchema(publishJobs);

export const PUBLISH_CLAIM_LIMIT = 20;

export type ClaimedPublishJob = {
  jobId: number;
  publicationKey: string;
  target: string;
  payload: JsonObject;
  attemptCount: number;
  lockId: string;
};
export type DuePublishJob = Pick<ClaimedPublishJob, "jobId" | "target">;

export function workerId(prefix = "backend"): string {
  return `${prefix}:${os.hostname()}:${process.pid}`;
}
export function claimDuePublishJobs(
  backendDb: BackendDb,
  limit: number,
  worker = `${workerId()}:${crypto.randomUUID()}`,
): ClaimedPublishJob[] {
  const due = duePublishJobs(backendDb, limit);
  return due.flatMap((job) => {
    const claimed = claimPublishJob(backendDb, job.jobId, worker);
    return claimed ? [claimed] : [];
  });
}

export function duePublishJobs(backendDb: BackendDb, limit: number): DuePublishJob[] {
  const now = new Date().toISOString();
  return unsafeDb(backendDb)
    .db.select({ jobId: publishJobs.jobId, target: publishJobs.target })
    .from(publishJobs)
    .where(
      and(
        eq(publishJobs.status, "queued"),
        or(isNull(publishJobs.publishAt), lte(publishJobs.publishAt, now)),
        or(isNull(publishJobs.nextAttemptAt), lte(publishJobs.nextAttemptAt, now)),
      ),
    )
    .orderBy(publishJobs.createdAt, publishJobs.jobId)
    .limit(limit)
    .all();
}

/** Claims one selected due job immediately before its target lane starts it. */
export function claimPublishJob(
  backendDb: BackendDb,
  jobId: number,
  worker = `${workerId()}:${crypto.randomUUID()}`,
): ClaimedPublishJob | null {
  const now = new Date().toISOString();
  return unsafeDb(backendDb).db.transaction((tx) => {
    const row = tx
      .select()
      .from(publishJobs)
      .where(
        and(
          eq(publishJobs.jobId, jobId),
          eq(publishJobs.status, "queued"),
          or(isNull(publishJobs.publishAt), lte(publishJobs.publishAt, now)),
          or(isNull(publishJobs.nextAttemptAt), lte(publishJobs.nextAttemptAt, now)),
        ),
      )
      .get();
    if (!row) return null;
    // The last gate before a delivery runs, and the only one no caller can go
    // around: whatever queued this job -- a retry, a replan, a repair, code not
    // written yet -- a job whose target already names a post on the platform,
    // and which carries nothing saying which part of it went out, cannot be
    // delivered. Publishing it is the duplicate; refusing it is a state a human
    // or the reconciliation sweep can still resolve.
    const delivered = tx
      .select({ externalId: publicationTargets.externalId })
      .from(publicationTargets)
      .where(and(eq(publicationTargets.publicationKey, row.publicationKey), eq(publicationTargets.target, row.target)))
      .get();
    if (delivered?.externalId && !hasResumeState(parsePayload(row.payloadJson))) {
      const error = `duplicate_refused: ${row.target} already published ${delivered.externalId} and this job carries nothing to continue from`;
      tx.update(publishJobs)
        .set({ status: "verification_required", nextAttemptAt: null, lockedBy: null, lockedAt: null, lastError: error, updatedAt: now })
        .where(and(eq(publishJobs.jobId, jobId), eq(publishJobs.status, "queued")))
        .run();
      upsertPostTarget(tx, {
        publicationKey: row.publicationKey,
        target: row.target,
        status: "verification_required",
        externalId: delivered.externalId,
        error,
        skipped: 0,
        updatedAt: now,
        rawJson: JSON.stringify({ job_id: row.jobId, duplicate_refused: true }),
      });
      insertEvent(
        tx,
        row.publicationKey,
        row.target,
        "publish.job.duplicate_refused",
        "error",
        error,
        { job_id: row.jobId, external_id: delivered.externalId },
        now,
      );
      return null;
    }
    const locked = tx
      .update(publishJobs)
      // currentPhase belongs to the attempt, not to the job: a new claim starts
      // without one so recoverStalePublishJobs can never read a phase left by
      // whoever last touched the row.
      .set({ status: "publishing", lockedBy: worker, lockedAt: now, currentPhase: null, updatedAt: now })
      .where(and(eq(publishJobs.jobId, jobId), eq(publishJobs.status, "queued")))
      .returning({ jobId: publishJobs.jobId })
      .get();
    if (!locked) return null;
    const publicationKey = row.publicationKey;
    upsertPostTarget(tx, {
      publicationKey,
      target: row.target,
      status: "publishing",
      error: null,
      skipped: 0,
      updatedAt: now,
      rawJson: JSON.stringify({ job_id: row.jobId, worker }),
    });
    insertEvent(
      tx,
      publicationKey,
      row.target,
      "publish.job.claimed",
      "info",
      `Publishing ${row.target}`,
      { job_id: row.jobId, worker },
      now,
    );
    return {
      jobId: row.jobId,
      publicationKey,
      target: row.target,
      payload: parsePayload(row.payloadJson),
      attemptCount: row.attemptCount,
      lockId: worker,
    };
  });
}

/** Runs a settlement transaction and reports whether it stuck. A settlement
 * fenced by a lease that has since been taken over rolls itself back rather
 * than overwriting the new owner's result, and that is a normal outcome of a
 * slow provider call, not an error for the worker loop to fail on. */
function withLease(backendDb: BackendDb, jobId: number, settle: (tx: UnsafeBackendDb["db"]) => void): boolean {
  try {
    unsafeDb(backendDb).db.transaction(settle);
    return true;
  } catch (error) {
    if (!(error instanceof PublishLockLostError)) throw error;
    log("warn", "publish settlement discarded: lock lost", { jobId });
    return false;
  }
}

export function recoverStalePublishJobs(backendDb: BackendDb, maxLockAgeSeconds = PUBLISH_LOCK_TIMEOUT_SECONDS): number {
  const cutoff = new Date(Date.now() - maxLockAgeSeconds * 1000).toISOString();
  const now = new Date().toISOString();
  const stale = unsafeDb(backendDb)
    .db.select()
    .from(publishJobs)
    .where(and(eq(publishJobs.status, "publishing"), lt(publishJobs.lockedAt, cutoff)))
    .all();
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const job of stale) {
      const lockedAt = job.lockedAt;
      if (!lockedAt) continue;
      const error = job.lastError || "worker_lost: publishing lock expired before completion";
      const publicMutationMayHaveRun = mayHaveReachedAudience(job.currentPhase);
      const recoveredStatus = publicMutationMayHaveRun ? "verification_required" : "queued";
      const updated = tx
        .update(publishJobs)
        .set({
          status: recoveredStatus,
          attemptCount: job.attemptCount + 1,
          lockedBy: null,
          lockedAt: null,
          nextAttemptAt: publicMutationMayHaveRun ? null : now,
          currentPhase: null,
          updatedAt: now,
          lastError: error,
        })
        .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "publishing"), eq(publishJobs.lockedAt, lockedAt)))
        .returning({ jobId: publishJobs.jobId })
        .get();
      // Another worker settled this job between the read and the write, so it
      // owns the outcome — and the rows superseded by *its* result, which is why
      // nothing is deleted until this update is known to have won.
      if (!updated) continue;
      deleteSupersededJobs(tx, job, job.jobId, job.publicationKey);
      const publicationKey = job.publicationKey;
      settleJob(
        tx,
        job.jobId,
        null,
        publicationKey,
        job.target,
        {
          status: recoveredStatus,
          error,
          skipped: 0,
          updatedAt: now,
          rawJson: JSON.stringify({ job_id: job.jobId, recovered_stale_lock: true, phase: job.currentPhase }),
        },
        {
          type: publicMutationMayHaveRun ? "publish.job.verification_required" : "publish.job.recovered",
          severity: "warn",
          message: error,
          details: {
            job_id: job.jobId,
            recovered_stale_lock: true,
            error_class: publicMutationMayHaveRun ? "ambiguous" : "interrupted",
            phase: job.currentPhase,
            attempt: job.attemptCount + 1,
            next_attempt_at: publicMutationMayHaveRun ? null : now,
          },
        },
      );
    }
  });
  for (const job of stale) refreshPublicationOwner(backendDb, job.publicationKey);
  return stale.length;
}

export function completePublishJob(
  backendDb: BackendDb,
  jobId: number,
  result: PublishResult,
  lockId: string,
  /** When this target's provider last answered anything, supplied by the caller
   * that already reads the credential breaker. Publishing does not reach into
   * another area's tables to learn it; it only decides what the fact means. */
  providerAnsweredAt: string | null = null,
): void {
  const now = new Date().toISOString();
  const job = unsafeDb(backendDb).db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
  if (job?.status !== "publishing" || job.lockedBy !== lockId) return;
  const publicationKey = job.publicationKey;
  if (result.deferred && typeof result.progressKey === "string" && result.progressValue !== undefined) {
    settleDeferredPublication(backendDb, job, result, now, lockId);
    return;
  }
  // A publication that got part of the way out comes back to finish it, from the
  // ids the adapter names on its own key: which platform publishes in more than
  // one call is the adapter's business and never the queue's.
  if (result.partial && typeof result.resumeKey === "string" && result.resumeKey.length > 0) {
    const ids = Array.isArray(result.ids) ? result.ids.map(String).filter(Boolean) : [];
    const retry = settlePartialPublication(
      backendDb,
      job,
      jobId,
      publicationKey,
      ids,
      result.resumeKey,
      result,
      now,
      lockId,
      providerAnsweredAt,
    );
    if (!retry) refreshPublicationOwner(backendDb, job.publicationKey);
    return;
  }
  // A retryable failure that nevertheless produced an external id is not a
  // delivery to run again: the id says something may already be live, and no
  // adapter can be asked to continue from it -- only to repeat it. This used to
  // be queued back under a `_reconcile_ids` key that nothing ever read, so the
  // next attempt published the whole thing a second time. It belongs to the
  // reconciliation sweep, which asks the provider instead of guessing.
  const reconciliationIds = externalIds(result);
  if (result.retryable && !result.ok && !result.skipped && reconciliationIds.length > 0) {
    settleForReconciliation(backendDb, job, jobId, publicationKey, reconciliationIds, result, now, lockId);
    return;
  }
  const normalized = normalizePublishResult(result);
  const settled = withLease(backendDb, jobId, (tx) => {
    const published = normalized.status === "published";
    // `publication_targets` is the canonical external-publication reference for every
    // platform. Legacy Telegram message columns remain readable for history,
    // but new delivery results never mutate the domain model for one platform.
    settleJob(
      tx,
      jobId,
      {
        patch: {
          status: normalized.status,
          currentPhase: null,
          lockedBy: null,
          lockedAt: null,
          lastError: normalized.error,
          updatedAt: now,
        },
        fence: lockId,
      },
      publicationKey,
      job.target,
      {
        status: normalized.status,
        externalId: published ? normalized.externalId : null,
        externalIdsJson: published && normalized.externalIds != null ? normalized.externalIds.map(String) : null,
        url: published ? normalized.url : null,
        error: normalized.error,
        skipped: normalized.skipped,
        // The per-target delivery time, not the post's creation time: analytics
        // reads this column to scope and order published targets.
        publishedAt: published ? now : null,
        confirmationSource: published ? publicationConfirmationSource(result) : null,
        verifiedAt: published && verificationStatus(result) === "verified" ? now : null,
        updatedAt: now,
        rawJson: normalized.rawJson,
      },
      {
        type: `publish.job.${normalized.status}`,
        severity: normalized.status === "failed" ? "error" : "info",
        message: `${job.target} ${normalized.status}`,
        details: {
          job_id: jobId,
          attempt: job.attemptCount,
          phase: "delivery.total",
          duration_ms: durationSince(job.lockedAt, now),
          result,
        },
      },
    );
    deleteSupersededJobs(tx, job, jobId, publicationKey);
  });
  if (!settled) return;
  if (normalized.status === "published") recordAuthSuccess(backendDb, job.target);
  else if (normalized.status === "failed" && classifyPublishError(normalized.error) === "auth") recordAuthFailure(backendDb, job.target);
  if (normalized.status === "published" && job.target === "x" && normalized.externalId)
    recordPublishedXActivity(backendDb, {
      publicationKey,
      xPostId: String(normalized.externalId),
      url: normalized.url,
      publishedAt: now,
    });
  refreshPublicationOwner(backendDb, job.publicationKey);
}

/** Persists an adapter's pre-publication state without spending a retry. A
 * container being processed is normal progress, not a failed attempt. */
function settleDeferredPublication(
  backendDb: BackendDb,
  job: typeof publishJobs.$inferSelect,
  result: PublishResult,
  now: string,
  lockId: string,
): void {
  const delayMs = Math.max(0, Math.min(60_000, Number(result.retryAfterMs) || 0));
  const nextAttemptAt = new Date(Date.parse(now) + delayMs).toISOString();
  const published =
    typeof result.resumeKey === "string" && result.resumeValue !== undefined
      ? { key: result.resumeKey, ids: result.resumeValue }
      : undefined;
  const payload = deferredDeliveryPayload(
    parsePayload(job.payloadJson),
    String(result.progressKey),
    result.progressValue ?? null,
    published,
  );
  const state = typeof result.state === "string" ? result.state : "processing";
  const settled = withLease(backendDb, job.jobId, (tx) =>
    settleJob(
      tx,
      job.jobId,
      {
        patch: {
          status: "queued",
          currentPhase: null,
          nextAttemptAt,
          lockedBy: null,
          lockedAt: null,
          payloadJson: payload,
          lastError: null,
          updatedAt: now,
        },
        fence: lockId,
      },
      job.publicationKey,
      job.target,
      { status: "queued", error: null, skipped: 0, updatedAt: now, rawJson: JSON.stringify(result) },
      {
        type: "publish.job.deferred",
        severity: "info",
        message: `${job.target} ${state}`,
        details: { job_id: job.jobId, state, next_attempt_at: nextAttemptAt },
      },
    ),
  );
  if (settled) ringWorkerAfter("publish", delayMs);
}

/** Hands an ambiguous outcome to the reconciliation sweep: the ids go on the
 * target so the sweep has something to ask the provider about, and the job
 * stops being a delivery. Nothing here re-enters the publish queue -- that is
 * the whole point. */
function settleForReconciliation(
  backendDb: BackendDb,
  job: typeof publishJobs.$inferSelect,
  jobId: number,
  publicationKey: string,
  ids: string[],
  result: PublishResult,
  now: string,
  lockId: string,
): void {
  const error = String(result.error ?? "external publication requires reconciliation");
  const settled = withLease(backendDb, jobId, (tx) => {
    deleteSupersededJobs(tx, job, jobId, publicationKey);
    settleJob(
      tx,
      jobId,
      {
        patch: {
          status: "verification_required",
          currentPhase: null,
          nextAttemptAt: null,
          lockedBy: null,
          lockedAt: null,
          lastError: error,
          updatedAt: now,
        },
        fence: lockId,
      },
      publicationKey,
      job.target,
      {
        status: "verification_required",
        externalId: ids[0] ?? null,
        externalIdsJson: ids,
        error,
        skipped: 0,
        updatedAt: now,
        rawJson: JSON.stringify(result),
      },
      {
        type: "publish.job.verification_required",
        severity: "warn",
        message: error,
        details: { job_id: jobId, ids, attempt: job.attemptCount, error_class: "ambiguous" },
      },
    );
  });
  if (settled) refreshPublicationOwner(backendDb, publicationKey);
}

/** Puts a half-finished publication back in the queue carrying what it already
 * published, and reports whether it is going to run again. */
function settlePartialPublication(
  backendDb: BackendDb,
  job: typeof publishJobs.$inferSelect,
  jobId: number,
  publicationKey: string,
  ids: string[],
  payloadKey: string,
  result: PublishResult,
  now: string,
  lockId: string,
  providerAnsweredAt: string | null,
): boolean {
  const transition = partialPublicationTransition(job.attemptCount, partialRetryPolicy());
  // The long budget a half-finished delivery gets is patience for a platform
  // that is down. It is not patience for a platform that is up and refusing
  // this one call: anything the platform answered since the last attempt says
  // the outage theory is wrong, and repeating an identical refusal for hours
  // only delays telling someone who can look at it.
  //
  // Another publication landing on the same target used to be the only
  // evidence accepted, so a Studio publishing one post at a time never
  // produced any: a Threads chain refused for a missing permission spent its
  // whole budget -- five and a half hours -- while the hourly credential probe
  // was talking to Threads the entire time. Any answer counts now.
  const providerAnsweredSince =
    publishedOnTargetSince(backendDb, job.target, job.updatedAt) ?? answeredSince(providerAnsweredAt, job.updatedAt);
  const attempt = transition.attempt;
  const retry = transition.status === "queued" && !providerAnsweredSince;
  const status = retry ? "queued" : "failed";
  const nextAttemptAt = retry ? transition.nextAttemptAt : null;
  const error = providerAnsweredSince
    ? `${String(result.error ?? `${job.target} partial publication`)} (stopped early: ${job.target} published something else at ${providerAnsweredSince}, so this is not the platform being down)`
    : String(result.error ?? `${job.target} partial publication`);
  const payload = resumedDeliveryPayload(parsePayload(job.payloadJson), payloadKey, ids);
  const settled = withLease(backendDb, jobId, (tx) => {
    // A queued row is unique per (publication_key, target); clear any competing one
    // before this job re-enters the queue, and clear superseded rows once this
    // one is terminal — exactly what failPublishJob does for the same states.
    deleteSupersededJobs(tx, job, jobId, publicationKey);
    settleJob(
      tx,
      jobId,
      {
        patch: {
          status,
          currentPhase: null,
          attemptCount: attempt,
          nextAttemptAt,
          lockedBy: null,
          lockedAt: null,
          payloadJson: payload,
          lastError: error,
          updatedAt: now,
        },
        fence: lockId,
      },
      publicationKey,
      job.target,
      { status, externalId: ids[0] ?? null, externalIdsJson: ids, error, skipped: 0, updatedAt: now, rawJson: JSON.stringify(result) },
      {
        type: retry ? "publish.job.partial" : "publish.job.failed",
        // The first one is news and the last one is the outcome; the ones in
        // between are a delivery doing what it said it would do. Alerts are
        // driven off severity, and a warning every backoff step for six hours
        // is how an operator learns to read past them.
        severity: retry ? (attempt <= 1 ? "warn" : "info") : "error",
        message: error,
        details: {
          job_id: jobId,
          ids,
          attempt,
          next_attempt_at: nextAttemptAt,
          ...(providerAnsweredSince ? { stopped_early: providerAnsweredSince } : {}),
        },
      },
    );
  });
  if (!settled) return false;
  if (!retry && classifyPublishError(error) === "auth") recordAuthFailure(backendDb, job.target);
  return retry;
}

/** When this target last put something in front of an audience after the given
 * moment. Evidence about the platform, not about this publication: it is how a
 * delivery tells "the platform is down" from "the platform will not take this
 * particular call". */
/** The provider's last answer, but only when it lands after this job's last
 * attempt: an older one says nothing about whether the platform is up now. */
function answeredSince(answeredAt: string | null, since: string | null): string | null {
  if (!answeredAt || !since) return null;
  return new Date(answeredAt).getTime() > new Date(since).getTime() ? answeredAt : null;
}

function publishedOnTargetSince(backendDb: BackendDb, target: string, since: string | null): string | null {
  if (!since) return null;
  const row = unsafeDb(backendDb)
    .db.select({ publishedAt: publicationTargets.publishedAt })
    .from(publicationTargets)
    .where(
      and(eq(publicationTargets.target, target), eq(publicationTargets.status, "published"), gt(publicationTargets.publishedAt, since)),
    )
    .orderBy(desc(publicationTargets.publishedAt))
    .get();
  return row?.publishedAt ?? null;
}

export function failPublishJob(backendDb: BackendDb, jobId: number, error: unknown, lockId: string): void {
  const now = new Date().toISOString();
  const job = unsafeDb(backendDb).db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
  if (job?.status !== "publishing" || job.lockedBy !== lockId) return;
  const publicationKey = job.publicationKey;
  const { attempt, errorClass, status, nextAttemptAt: nextAttempt } = failedJobTransition(error, job.attemptCount, publishRetryPolicy());
  const shouldRetry = status === "queued";
  const errorText = String(error instanceof Error ? error.message : error);
  const settled = withLease(backendDb, jobId, (tx) => {
    // Before this job re-enters the queue (or becomes the terminal record for
    // its target), no other queued/failed row for the same target may remain:
    // a queued row is unique per (publication_key, target).
    deleteSupersededJobs(tx, job, jobId, publicationKey);
    settleJob(
      tx,
      jobId,
      {
        patch: {
          status,
          currentPhase: null,
          attemptCount: attempt,
          nextAttemptAt: nextAttempt,
          lockedBy: null,
          lockedAt: null,
          lastError: errorText,
          updatedAt: now,
        },
        fence: lockId,
      },
      publicationKey,
      job.target,
      {
        status,
        error: errorText,
        skipped: 0,
        updatedAt: now,
        rawJson: JSON.stringify({ job_id: jobId, error_class: errorClass, attempt, next_attempt_at: nextAttempt }),
      },
      {
        type: shouldRetry ? "publish.job.retry" : "publish.job.failed",
        severity: shouldRetry ? "warn" : "error",
        message: errorText,
        details: {
          job_id: jobId,
          error_class: errorClass,
          attempt,
          next_attempt_at: nextAttempt,
          phase: "delivery.total",
          duration_ms: durationSince(job.lockedAt, now),
        },
      },
    );
  });
  if (!settled) return;
  if (errorClass === "auth") recordAuthFailure(backendDb, job.target);
  if (!shouldRetry) refreshPublicationOwner(backendDb, job.publicationKey);
}

export function requirePublishVerification(backendDb: BackendDb, jobId: number, error: unknown, lockId: string): boolean {
  const now = new Date().toISOString();
  const job = unsafeDb(backendDb).db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
  if (job?.status !== "publishing" || job.lockedBy !== lockId) return false;
  const publicationKey = job.publicationKey;
  const errorText = error instanceof Error ? error.message : String(error);
  let updated = false;
  withLease(backendDb, jobId, (tx) => {
    deleteSupersededJobs(tx, job, jobId, publicationKey);
    settleJob(
      tx,
      jobId,
      {
        patch: {
          status: "verification_required",
          attemptCount: job.attemptCount + 1,
          nextAttemptAt: null,
          currentPhase: null,
          lockedBy: null,
          lockedAt: null,
          lastError: errorText,
          updatedAt: now,
        },
        fence: lockId,
      },
      publicationKey,
      job.target,
      { status: "verification_required", error: errorText, skipped: 0, updatedAt: now },
      {
        type: "publish.job.verification_required",
        severity: "warn",
        message: errorText,
        details: {
          job_id: jobId,
          attempt: job.attemptCount + 1,
          phase: "provider.publish",
          duration_ms: durationSince(job.lockedAt, now),
        },
      },
    );
    updated = true;
  });
  if (updated) refreshPublicationOwner(backendDb, job.publicationKey);
  return updated;
}

/**
 * Last-resort settlement for an ambiguous worker failure. It intentionally
 * avoids the event journal because this path is used when normal settlement
 * itself failed; verification_required is safer than retrying an API mutation.
 */
export function forcePublishJobVerification(
  backendDb: BackendDb,
  jobId: number,
  error: unknown,
  lockId: string,
  result: PublishResult | null = null,
): boolean {
  const now = new Date().toISOString();
  const job = unsafeDb(backendDb).db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
  if (job?.status !== "publishing" || job.lockedBy !== lockId) return false;
  const publicationKey = job.publicationKey;
  const errorText = error instanceof Error ? error.message : String(error);
  const evidence = result ? normalizePublishResult(result) : null;
  const updated = unsafeDb(backendDb).db.transaction((tx) => {
    const row = tx
      .update(publishJobs)
      .set({
        status: "verification_required",
        attemptCount: job.attemptCount + 1,
        nextAttemptAt: null,
        currentPhase: null,
        lockedBy: null,
        lockedAt: null,
        lastError: errorText,
        updatedAt: now,
      })
      .where(and(eq(publishJobs.jobId, jobId), eq(publishJobs.status, "publishing"), eq(publishJobs.lockedBy, lockId)))
      .returning({ jobId: publishJobs.jobId })
      .get();
    if (!row) return false;
    upsertPostTarget(tx, {
      publicationKey,
      target: job.target,
      status: "verification_required",
      error: errorText,
      skipped: 0,
      updatedAt: now,
      rawJson: JSON.stringify({ job_id: jobId, emergency: true }),
      ...(evidence
        ? {
            externalId: evidence.externalId,
            externalIdsJson: evidence.externalIds == null ? null : evidence.externalIds.map((value) => String(value)),
            url: evidence.url,
          }
        : {}),
    });
    return true;
  });
  if (updated) refreshPublicationOwner(backendDb, job.publicationKey);
  return updated;
}

export function enqueuePublishJobTx(db: UnsafeBackendDb["db"], input: EnqueuePublishJobInput): number {
  const now = new Date().toISOString();
  const inputRecord = {
    publicationKey: input.publicationKey,
    target: input.target,
    status: "queued",
    publishAt: input.publishAt ?? null,
    payloadJson: input.payload,
    createdAt: now,
    updatedAt: now,
  } satisfies typeof publishJobs.$inferInsert;
  insertPublishJobSchema.parse(inputRecord);
  // Re-queueing the same target of the same post is a refresh, not a second
  // job: adopt the existing queued row and carry the new payload and time onto
  // it. Throwing here would abort the whole publication transaction.
  const inserted = db
    .insert(publishJobs)
    .values(inputRecord)
    .onConflictDoUpdate({
      target: [publishJobs.publicationKey, publishJobs.target, publishJobs.status],
      set: { publishAt: inputRecord.publishAt, payloadJson: inputRecord.payloadJson, updatedAt: now },
    })
    .returning({ jobId: publishJobs.jobId })
    .get();
  if (!inserted) throw new Error("publish job insert did not return an id");
  // One funnel, so no enqueue path can forget to ring; the ring itself waits for
  // this transaction to commit.
  ringWorker("publish");
  return inserted.jobId;
}

type EnqueuePublishJobInput = {
  target: string;
  /** Branded on purpose: a job may only be created with a payload whose author
   * has said what the delivery has already published. See delivery-payload.ts. */
  payload: DeliveryPayload;
  publicationKey: string;
  publishAt?: string | null;
};
