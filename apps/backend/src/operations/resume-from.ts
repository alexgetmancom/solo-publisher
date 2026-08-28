import { and, desc, eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { publishJobs } from "../db/schema.js";
import { refreshPublicationOwner } from "../publishing/publication-owner.js";
import { parsePayload, upsertPostTarget } from "../publishing/queue-state.js";
import { resumeState } from "../publishing/resume.js";
import type { ResolvedPublicationRef } from "./publication-ref.js";

type ResumeFromInput = {
  ref: ResolvedPublicationRef;
  target: string;
  /** The post the rest of the publication should be attached to. */
  externalId: string;
  apply: boolean;
  actorType: string;
};

/** Tells a half-published target which post it is continuing.
 *
 * A publication that goes out in more than one call carries the ids it already
 * published, and a retry writes the rest onto them. That is the whole recovery
 * path, and it has one blind spot: the ids can name a post that is no longer
 * the right one. A duplicate removed by hand is the case that happens --
 * whatever put a second copy there, someone deletes it, and the job is left
 * pointing at the deleted one, so the remainder would be written onto nothing.
 *
 * The operator can see which post survived; nothing in here can. So they name
 * it, the job is pointed at it, and the ordinary retry finishes the
 * publication. Aimed only at a target that already carries resume state: a
 * platform that publishes in one call has no chain to continue, and inventing
 * one for it would be this command guessing at delivery. */
export function resumeTargetFrom(backendDb: BackendDb, input: ResumeFromInput): Record<string, unknown> {
  const db = unsafeDb(backendDb).db;
  const job = db
    .select()
    .from(publishJobs)
    .where(and(eq(publishJobs.publicationKey, input.ref.publicationKey), eq(publishJobs.target, input.target)))
    .orderBy(desc(publishJobs.jobId))
    .get();
  if (!job) throw new Error(`${input.target} has no publish job on ${input.ref.publicationKey}`);
  const payload = parsePayload(job.payloadJson);
  const resume = resumeState(payload);
  const [resumeKey] = Object.keys(resume);
  if (!resumeKey)
    throw new Error(`${input.target} carries nothing it has already published; there is no unfinished publication to continue`);
  if (job.status === "publishing") throw new Error(`${input.target} is being delivered right now; read its state again`);

  const plan = {
    ok: true,
    action: "resume-from",
    publication_key: input.ref.publicationKey,
    target: input.target,
    job_id: job.jobId,
    resume_key: resumeKey,
    was: resume[resumeKey],
    now: [input.externalId],
  };
  if (!input.apply) return { ...plan, applied: false, hint: "re-run with apply to point it at this post and finish the publication" };

  const now = new Date().toISOString();
  const settled = db.transaction((tx) => {
    // Fenced on the status this decision was read from: a worker that claimed
    // the job in between owns the delivery, and its attempt is writing onto the
    // ids this would have replaced under it.
    const won = tx
      .update(publishJobs)
      .set({
        status: "queued",
        payloadJson: { ...payload, [resumeKey]: [input.externalId] },
        attemptCount: 0,
        publishAt: now,
        nextAttemptAt: null,
        lockedBy: null,
        lockedAt: null,
        currentPhase: null,
        lastError: null,
        updatedAt: now,
      })
      .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, job.status)))
      .returning({ jobId: publishJobs.jobId })
      .get();
    if (!won) return false;
    upsertPostTarget(tx, {
      publicationKey: input.ref.publicationKey,
      target: input.target,
      status: "queued",
      externalId: input.externalId,
      externalIdsJson: [input.externalId],
      error: null,
      updatedAt: now,
    });
    backendDb.events.record({
      ref: input.ref.publicationKey,
      target: input.target,
      type: "publish.target.resumed_from",
      severity: "warn",
      message: `${input.target} will finish its publication onto ${input.externalId}`,
      details: { job_id: job.jobId, resume_key: resumeKey, was: resume[resumeKey], now: [input.externalId], actor_type: input.actorType },
    });
    return true;
  });
  if (!settled) throw new Error(`${input.target} left ${job.status} before this could point it at a post; read its state again`);
  refreshPublicationOwner(backendDb, job.publicationKey);
  return { ...plan, applied: true };
}
