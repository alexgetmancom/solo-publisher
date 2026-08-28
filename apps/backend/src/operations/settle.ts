import { and, desc, eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { publicationTargets, publishJobs } from "../db/schema.js";
import { refreshPublicationOwner } from "../publishing/publication-owner.js";
import type { ResolvedPublicationRef } from "./publication-ref.js";

type SettleInput = {
  ref: ResolvedPublicationRef;
  target: string;
  /** The id the operator read off the platform, or nothing if it is not there. */
  externalId?: string | undefined;
  url?: string | undefined;
  apply: boolean;
  actorType: string;
};

/** Settles a target that reconciliation cannot settle by itself.
 *
 * A worker lost between calling the platform and recording the answer leaves
 * `verification_required` and no external id — and reconciliation resolves an
 * ambiguous target by asking the platform about that id, so with no id it has
 * nothing to ask. `retry` deliberately refuses the state as well, since
 * republishing something that may already be live is the outcome the state
 * exists to prevent. That left the only way out as manual SQL.
 *
 * So the operator looks, and reports what they saw. Naming the id is evidence
 * the post is live: it is recorded and the target is published. Reporting it
 * absent puts the job back in the queue, and that is a publication, so it is
 * gated behind `--apply` like every other command that reaches an audience. */
export function settleAmbiguousTarget(backendDb: BackendDb, input: SettleInput): Record<string, unknown> {
  const db = unsafeDb(backendDb).db;
  const job = db
    .select()
    .from(publishJobs)
    .where(and(eq(publishJobs.publicationKey, input.ref.publicationKey), eq(publishJobs.target, input.target)))
    .orderBy(desc(publishJobs.jobId))
    .get();
  if (!job) throw new Error(`${input.target} has no publish job on ${input.ref.publicationKey}`);
  if (job.status !== "verification_required")
    throw new Error(`${input.target} is ${job.status}, not verification_required; settle only answers an ambiguous target`);
  const found = input.externalId !== undefined;
  const plan = {
    ok: true,
    action: "settle",
    publication_key: input.ref.publicationKey,
    target: input.target,
    job_id: job.jobId,
    outcome: found ? "published" : "requeued",
    ...(found ? { external_id: input.externalId } : {}),
  };
  if (!input.apply) return { ...plan, applied: false, hint: "re-run with apply to record it" };

  const now = new Date().toISOString();
  const settled = db.transaction((tx) => {
    // Fenced on the state this decision was made from: reconciliation may have
    // resolved the target between the operator looking and answering, and its
    // answer came from the platform rather than from memory.
    const won = tx
      .update(publishJobs)
      .set({
        status: found ? "published" : "queued",
        attemptCount: 0,
        nextAttemptAt: null,
        lockedBy: null,
        lockedAt: null,
        currentPhase: null,
        lastError: null,
        updatedAt: now,
      })
      .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "verification_required")))
      .returning({ jobId: publishJobs.jobId })
      .get();
    if (!won) return false;
    tx.update(publicationTargets)
      .set({
        status: found ? "published" : "queued",
        externalId: input.externalId ?? null,
        externalIdsJson: found && input.externalId ? [input.externalId] : null,
        url: input.url ?? null,
        error: null,
        publishedAt: found ? now : null,
        confirmationSource: found ? "operator" : null,
        verifiedAt: null,
        updatedAt: now,
      })
      .where(and(eq(publicationTargets.publicationKey, input.ref.publicationKey), eq(publicationTargets.target, input.target)))
      .run();
    backendDb.events.record({
      ref: input.ref.publicationKey,
      target: input.target,
      type: found ? "publish.job.settled_published" : "publish.job.settled_absent",
      severity: "info",
      message: found ? `${input.target} was confirmed live by the operator` : `${input.target} was reported absent and requeued`,
      details: { job_id: job.jobId, external_id: input.externalId ?? null, actor_type: input.actorType },
    });
    return true;
  });
  if (!settled) throw new Error(`${input.target} left verification_required before this could settle it; read its state again`);
  refreshPublicationOwner(backendDb, job.publicationKey);
  return { ...plan, applied: true };
}
