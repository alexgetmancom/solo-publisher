import { and, eq, inArray, sql } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { drafts, publicationCancellations, publicationTargets, publishJobs, siteJobs } from "../db/schema.js";
import { hasResumeState } from "./delivery-payload.js";
import { insertEvent, parsePayload } from "./queue-state.js";

/** What cancelling the rest of a publication did, in the operator's terms:
 * which targets will not be delivered, and which were already far enough along
 * that they are being finished instead. */
export type CancellationReport = { stopped: string[]; finishing: string[] };

type AnyDb = UnsafeBackendDb["db"];

/** A target still to be delivered, and whether cancelling would stop it. A
 * delivery that has already published part of itself -- a thread mid-chain --
 * is listed as one that will be finished. */
export type PendingTarget = { target: string; started: boolean };

export function pendingDeliveryTargets(backendDb: BackendDb, draftId: number): PendingTarget[] {
  const postId = publicationId(unsafeDb(backendDb).db, draftId);
  if (postId == null) return [];
  const publicationKey = publicationRef("post", postId);
  const social = unsafeDb(backendDb)
    .db.select({ target: publishJobs.target, status: publishJobs.status, payloadJson: publishJobs.payloadJson })
    .from(publishJobs)
    .where(and(eq(publishJobs.publicationKey, publicationKey), inArray(publishJobs.status, ["queued", "publishing"])))
    .all()
    .map((job) => ({ target: job.target, started: job.status === "publishing" || hasResumeState(parsePayload(job.payloadJson)) }));
  const site = unsafeDb(backendDb)
    .db.select({ target: siteJobs.reason })
    .from(siteJobs)
    .where(and(eq(siteJobs.publicationKey, publicationKey), inArray(siteJobs.status, ["queued", "rendering"])))
    .all()
    .map((job) => ({ target: job.target, started: false }));
  return [...social, ...site];
}

/**
 * Declares the rest of a publication cancelled.
 *
 * The declaration is a row of its own, and it outlives this call: a worker that
 * had already claimed a target checks for it in the `WHERE` of the write that
 * would start the next delivery, so cancelling no longer depends on catching
 * the queue at the right instant. Queued work that has published nothing stops
 * here; anything already part-way to a platform is left to finish.
 */
export function cancelRemainingDelivery(backendDb: BackendDb, draftId: number, actorId: number): CancellationReport {
  const now = backendDb.clock.now().toISOString();
  const postId = publicationId(unsafeDb(backendDb).db, draftId);
  if (postId == null) return { stopped: [], finishing: [] };
  const publicationKey = publicationRef("post", postId);
  const report = unsafeDb(backendDb).db.transaction((tx) => {
    tx.insert(publicationCancellations).values({ publicationKey, actorId, requestedAt: now }).onConflictDoNothing().run();
    const finishing: string[] = [];
    const stopped: string[] = [];
    const social = tx
      .select({ jobId: publishJobs.jobId, target: publishJobs.target, status: publishJobs.status, payloadJson: publishJobs.payloadJson })
      .from(publishJobs)
      .where(and(eq(publishJobs.publicationKey, publicationKey), inArray(publishJobs.status, ["queued", "publishing", "failed"])))
      .all();
    for (const job of social) {
      // A claimed job and a job carrying what it already published are the same
      // case: something of this target may be live, and the queue is the only
      // thing that can end it without severing it.
      if (job.status === "publishing" || hasResumeState(parsePayload(job.payloadJson))) {
        finishing.push(job.target);
        continue;
      }
      const cancelled = tx
        .update(publishJobs)
        .set({ status: "cancelled", nextAttemptAt: null, lockedBy: null, lockedAt: null, currentPhase: null, updatedAt: now })
        .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, job.status)))
        .returning({ jobId: publishJobs.jobId })
        .get();
      if (!cancelled) {
        finishing.push(job.target);
        continue;
      }
      stopped.push(job.target);
      markTargetCancelled(tx, publicationKey, job.target, now);
    }
    const site = tx
      .select({ jobId: siteJobs.jobId, target: siteJobs.reason, status: siteJobs.status })
      .from(siteJobs)
      .where(and(eq(siteJobs.publicationKey, publicationKey), inArray(siteJobs.status, ["queued", "failed"])))
      .all();
    for (const job of site) {
      const cancelled = tx
        .update(siteJobs)
        .set({ status: "cancelled", nextAttemptAt: null, lockedBy: null, lockedAt: null, updatedAt: now })
        .where(and(eq(siteJobs.jobId, job.jobId), eq(siteJobs.status, job.status)))
        .returning({ jobId: siteJobs.jobId })
        .get();
      if (!cancelled) continue;
      stopped.push(job.target);
      markTargetCancelled(tx, publicationKey, job.target, now);
    }
    insertEvent(
      tx,
      publicationKey,
      null,
      "publish.remaining.cancelled",
      "warn",
      `Remaining delivery cancelled: ${stopped.join(", ") || "nothing left to stop"}${finishing.length ? `; finishing ${finishing.join(", ")}` : ""}`,
      { actor_id: actorId, stopped, finishing },
      now,
    );
    return { stopped, finishing } satisfies CancellationReport;
  });
  return report;
}

/** Whether the declaration exists, for the one caller that has already lost a
 * write to it and has to say why. Deciding to deliver is never taken from this
 * read: that condition travels in the delivery write's own `WHERE`. */
export function isCancellationDeclared(tx: AnyDb, publicationKey: string): boolean {
  return Boolean(
    tx
      .select({ publicationKey: publicationCancellations.publicationKey })
      .from(publicationCancellations)
      .where(eq(publicationCancellations.publicationKey, publicationKey))
      .get(),
  );
}

/** The condition a delivery write carries so it cannot start work the operator
 * has already cancelled: no cancellation row for this publication. */
export function deliveryNotCancelled(publicationKey: string) {
  return sql`not exists (select 1 from ${publicationCancellations} where ${publicationCancellations.publicationKey} = ${publicationKey})`;
}

/** A publication being planned again is not the cancelled one: the declaration
 * is cleared when new work is deliberately queued for it. */
export function clearDeliveryCancellation(tx: AnyDb, publicationKey: string): void {
  tx.delete(publicationCancellations).where(eq(publicationCancellations.publicationKey, publicationKey)).run();
}

function markTargetCancelled(tx: AnyDb, publicationKey: string, target: string, now: string): void {
  tx.update(publicationTargets)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(publicationTargets.publicationKey, publicationKey), eq(publicationTargets.target, target)))
    .run();
}

function publicationId(db: AnyDb, draftId: number): number | null {
  return db.select({ postId: drafts.postId }).from(drafts).where(eq(drafts.id, draftId)).get()?.postId ?? null;
}
