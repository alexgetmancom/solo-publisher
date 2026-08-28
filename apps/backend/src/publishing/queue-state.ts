import { and, eq, inArray, ne } from "drizzle-orm";
import * as z from "zod";
import type { UnsafeBackendDb } from "../db/client.js";
import type { JsonObject } from "../db/schema.js";
import { publicationEvents, publicationTargets, publishJobs } from "../db/schema.js";
import {
  PUBLISH_BACKOFF_BASE_SECONDS,
  PUBLISH_BACKOFF_MAX_SECONDS,
  PUBLISH_MAX_ATTEMPTS,
  PUBLISH_PARTIAL_MAX_ATTEMPTS,
} from "../foundation/config.js";
import type { PublishResult } from "./errors.js";

export function publicationConfirmationSource(result: PublishResult): string {
  if (verificationStatus(result) === "verified") return "provider_verify";
  const raw = result.raw && typeof result.raw === "object" ? (result.raw as Record<string, unknown>) : null;
  if (raw && "existingPost" in raw) return "idempotency_replay";
  return "publish_response";
}

export function verificationStatus(result: PublishResult): string | null {
  const verification = result.verification;
  if (!verification || typeof verification !== "object") return null;
  const status = (verification as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}

export function durationSince(startedAt: string | null, finishedAt: string): number | null {
  if (!startedAt) return null;
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function publishRetryPolicy() {
  return {
    maxAttempts: PUBLISH_MAX_ATTEMPTS,
    backoffBaseSeconds: PUBLISH_BACKOFF_BASE_SECONDS,
    backoffMaxSeconds: PUBLISH_BACKOFF_MAX_SECONDS,
  };
}

/** The publish retry policy, widened to the partial budget: only how many
 * attempts there are differs, because the curve and its ceiling are about being
 * polite to the platform and that does not change with the reason. */
export function partialRetryPolicy() {
  return { ...publishRetryPolicy(), maxAttempts: PUBLISH_PARTIAL_MAX_ATTEMPTS };
}

export function deleteSupersededJobs(
  tx: UnsafeBackendDb["db"],
  job: typeof publishJobs.$inferSelect,
  jobId: number,
  publicationKey: string,
): void {
  tx.delete(publishJobs)
    .where(
      and(
        eq(publishJobs.target, job.target),
        ne(publishJobs.jobId, jobId),
        inArray(publishJobs.status, ["queued", "failed", "verification_required"]),
        eq(publishJobs.publicationKey, publicationKey),
      ),
    )
    .run();
}

export function parsePayload(value: JsonObject | null): JsonObject {
  const parsed = z.record(z.string(), z.json()).safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function externalIds(result: PublishResult): string[] {
  const ids = Array.isArray(result.ids) ? result.ids.map(String).filter(Boolean) : [];
  if (ids.length > 0) return [...new Set(ids)];
  return result.id == null ? [] : [String(result.id)];
}

/** Keeps target state updates consistent across claim, completion, and recovery paths. */
export function upsertPostTarget(db: UnsafeBackendDb["db"], value: typeof publicationTargets.$inferInsert): void {
  const { publicationKey, target, ...patch } = value;
  db.insert(publicationTargets)
    .values(value)
    .onConflictDoUpdate({ target: [publicationTargets.publicationKey, publicationTargets.target], set: patch })
    .run();
}

export function insertEvent(
  tx: UnsafeBackendDb["db"],
  publicationKey: string | null,
  target: string | null,
  eventType: string,
  severity: string,
  message: string,
  details: Record<string, unknown>,
  createdAt: string,
): void {
  tx.insert(publicationEvents)
    .values({ publicationKey, eventType, severity, target, message, detailsJson: JSON.stringify(details), createdAt })
    .run();
}

/** Raised when the lease a settlement was fenced by is no longer held, which
 * rolls the whole settlement back: the job belongs to another worker now, and
 * its target row and journal entry must not be written by the previous one. */
export class PublishLockLostError extends Error {
  constructor(readonly jobId: number) {
    super(`publish_job_lock_lost:${jobId}`);
  }
}

/** A settlement updates the job, mirrors target state, and journals the event
 * atomically. `fence` is the lease the caller checked before it called the
 * provider: that check is minutes old by the time a settlement lands, and
 * without carrying it into the write a timed-out worker overwrote the result
 * its replacement had already recorded.
 *
 * The fence travels with the patch rather than beside it, so there is no way to
 * ask for a job update without saying which lease earns it. It used to be a
 * separate optional argument, which made an unfenced write one forgotten
 * parameter away -- and the only caller that ever forgot it was a test.
 * `null` is the stale-lock recovery path, which already won the job row on its
 * own `lockedAt` fence and has only the target and the journal left to write. */
export function settleJob(
  tx: UnsafeBackendDb["db"],
  jobId: number,
  job: { patch: Partial<typeof publishJobs.$inferInsert>; fence: string } | null,
  publicationKey: string,
  target: string,
  targetPatch: Omit<typeof publicationTargets.$inferInsert, "publicationKey" | "target"> & { updatedAt: string },
  event: { type: string; severity: string; message: string; details: Record<string, unknown> },
): void {
  if (job) {
    const updated = tx
      .update(publishJobs)
      .set(job.patch)
      .where(and(eq(publishJobs.jobId, jobId), eq(publishJobs.lockedBy, job.fence)))
      .returning({ jobId: publishJobs.jobId })
      .get();
    if (!updated) throw new PublishLockLostError(jobId);
  }
  upsertPostTarget(tx, { publicationKey, target, ...targetPatch });
  insertEvent(tx, publicationKey, target, event.type, event.severity, event.message, event.details, targetPatch.updatedAt);
}
