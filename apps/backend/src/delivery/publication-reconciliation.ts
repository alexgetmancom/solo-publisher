import crypto from "node:crypto";
import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { TARGET_GROUPS, targetInGroup } from "../botTargets.js";
import { videoChannelIdentity } from "../channels/destinations.js";
import { targetRouting } from "../channels/registry.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { publicationTargets, publishJobs, videoDrafts, videoJobs, videoTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { PUBLISH_BACKOFF_BASE_SECONDS, PUBLISH_BACKOFF_MAX_SECONDS, PUBLISH_LOCK_TIMEOUT_SECONDS } from "../foundation/config.js";
import { jsonObject } from "../json.js";
import { ALERT_COOLDOWN_SECONDS } from "../observability/alerts.js";
import { isTargetAuthBlocked, recordAuthFailure, recordAuthSuccess } from "../observability/auth-circuit.js";
import { classifyPublishError, nextRetryAt } from "../publishing/errors.js";
import { refreshPublicationOwner } from "../publishing/publication-owner.js";
import { PUBLISH_CLAIM_LIMIT, workerId } from "../publishing/queue.js";
import { refreshVideoDraftStatus } from "../publishing/video-data.js";
import { verifyPlatformPublication } from "./platform-adapters.js";
import { verifyYouTubeVideo } from "./video-publishers.js";
import { PROVIDER_CONFIRMATION_GRACE_MS, recordVideoCompletionIfFinal } from "./video-worker.js";
import { verifyZernioPost } from "./zernio.js";

/** How many times reconciliation may ask a provider whether an ambiguous
 * publication exists before it stops polling and waits for an operator. Higher
 * than the publish budget on purpose: these are reads, and a platform can take
 * a while to expose a freshly created object. */
export const RECONCILE_MAX_ATTEMPTS = 8;

type ReconciliationResult = { checked: number; resolved: number; unresolved: number; oldestAt: string | null };

/** Resolves only cases backed by a durable provider ID. A missing ID remains
 * visible for an operator; guessing by title or timestamp is not safe enough
 * for a reusable self-hosted default. */
export async function runPublicationReconciliation(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ReconciliationResult> {
  let checked = 0;
  let resolved = 0;
  const nowIso = new Date().toISOString();
  const reconciliationWorker = `${workerId("reconciliation")}:${crypto.randomUUID()}`;
  // This claims publish and video jobs, so it ages out on the publish lock —
  // the metrics timeout is a different worker's setting and tuning that one
  // silently moved when reconciliation may steal a claim.
  const staleBefore = new Date(Date.now() - PUBLISH_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const unansweredBefore = new Date(Date.now() - PROVIDER_CONFIRMATION_GRACE_MS).toISOString();
  const ordinary = unsafeDb(backendDb)
    .db.select({ job: publishJobs, target: publicationTargets })
    .from(publishJobs)
    .innerJoin(
      publicationTargets,
      and(eq(publicationTargets.publicationKey, publishJobs.publicationKey), eq(publicationTargets.target, publishJobs.target)),
    )
    .where(
      and(
        eq(publishJobs.status, "verification_required"),
        lt(publishJobs.reconcileAttemptCount, RECONCILE_MAX_ATTEMPTS),
        or(isNull(publishJobs.nextAttemptAt), lte(publishJobs.nextAttemptAt, nowIso)),
        or(isNull(publishJobs.lockedBy), isNull(publishJobs.lockedAt), lt(publishJobs.lockedAt, staleBefore)),
      ),
    )
    .limit(PUBLISH_CLAIM_LIMIT)
    .all();
  const routing = targetRouting(backendDb);
  for (const row of ordinary) {
    const claimed = unsafeDb(backendDb)
      .db.update(publishJobs)
      .set({ lockedBy: reconciliationWorker, lockedAt: nowIso, updatedAt: nowIso })
      .where(
        and(
          eq(publishJobs.jobId, row.job.jobId),
          eq(publishJobs.status, "verification_required"),
          or(isNull(publishJobs.lockedBy), isNull(publishJobs.lockedAt), lt(publishJobs.lockedAt, staleBefore)),
        ),
      )
      .returning({ jobId: publishJobs.jobId })
      .get();
    if (!claimed) continue;
    const job = { ...row.job, lockedBy: reconciliationWorker, lockedAt: nowIso };
    checked += 1;
    const externalId = row.target.externalId;
    if (!externalId || isTargetAuthBlocked(backendDb, row.job.target)) {
      deferOrdinaryReconciliation(backendDb, job, reconciliationWorker);
      continue;
    }
    let result: Awaited<ReturnType<typeof verifyPlatformPublication>>;
    try {
      const providerResult = jsonObject(row.target.rawJson);
      const providerPostId = typeof providerResult.providerPostId === "string" ? providerResult.providerPostId : null;
      const route = routing[row.job.target];
      const zernioPlatform = targetInGroup(TARGET_GROUPS.threads, row.job.target)
        ? "threads"
        : targetInGroup(TARGET_GROUPS.instagramStory, row.job.target)
          ? "instagram"
          : null;
      if (route?.provider === "zernio" && providerPostId && zernioPlatform) {
        const verified = await verifyZernioPost(config, providerPostId, zernioPlatform, fetchImpl);
        result = verified.externalId
          ? {
              ok: true,
              id: verified.externalId,
              url: verified.url ?? row.target.url,
              providerPostId,
              verification: { status: "verified", providerId: verified.externalId },
            }
          : {
              ok: true,
              id: externalId,
              url: row.target.url,
              providerPostId,
              verification: { status: "unavailable", error: `${zernioPlatform} publication is still pending at Zernio` },
            };
      } else {
        result = await verifyPlatformPublication(row.job.target, { ok: true, id: externalId, url: row.target.url }, config, fetchImpl);
      }
    } catch (error) {
      if (classifyPublishError(error) === "auth") recordAuthFailure(backendDb, row.job.target);
      deferOrdinaryReconciliation(backendDb, job, reconciliationWorker);
      continue;
    }
    const verification = result.verification as { status?: string } | undefined;
    const verificationError = (result.verification as { error?: string } | undefined)?.error;
    if (verification?.status === "unavailable" && classifyPublishError(verificationError) === "auth")
      recordAuthFailure(backendDb, row.job.target);
    if (verification?.status !== "verified") {
      deferOrdinaryReconciliation(backendDb, job, reconciliationWorker);
      continue;
    }
    recordAuthSuccess(backendDb, row.job.target);
    const now = new Date().toISOString();
    // The job update is fenced by this worker's claim, and the target write only
    // happens if that fence held: a reconciliation whose lock had been taken
    // over used to publish the target anyway, leaving a job someone else owned
    // beside a target this worker had already marked published.
    const confirmed = unsafeDb(backendDb).db.transaction((tx) => {
      const won = tx
        .update(publishJobs)
        .set({ status: "published", currentPhase: null, lockedBy: null, lockedAt: null, lastError: null, updatedAt: now })
        .where(
          and(
            eq(publishJobs.jobId, row.job.jobId),
            eq(publishJobs.status, "verification_required"),
            eq(publishJobs.lockedBy, reconciliationWorker),
          ),
        )
        .returning({ jobId: publishJobs.jobId })
        .get();
      if (!won) return false;
      tx.update(publicationTargets)
        .set({
          status: "published",
          externalId: result.id == null ? row.target.externalId : String(result.id),
          error: null,
          url: typeof result.url === "string" ? result.url : row.target.url,
          publishedAt: row.target.publishedAt ?? now,
          confirmationSource: "provider_verify",
          verifiedAt: now,
          updatedAt: now,
        })
        .where(and(eq(publicationTargets.publicationKey, row.target.publicationKey), eq(publicationTargets.target, row.target.target)))
        .run();
      return true;
    });
    if (!confirmed) continue;
    refreshPublicationOwner(backendDb, row.target.publicationKey);
    backendDb.events.record({
      ref: row.target.publicationKey,
      target: row.target.target,
      type: "publish.job.reconciled",
      severity: "info",
      message: `${row.target.target} publication was confirmed`,
      details: { job_id: row.job.jobId, external_id: externalId, confirmation_source: verification?.status ?? "stored_response" },
    });
    resolved += 1;
  }

  // A publication whose provider never answered stops being "in flight" at some
  // point, and the operator has to hear about it. Nothing else re-reads these
  // targets after the grace runs out: the outcome was withheld at publish time
  // and the sweep only speaks when it gets an answer, so silence was the third
  // possible ending. This is where it is broken.
  for (const stranded of unsafeDb(backendDb)
    .db.selectDistinct({ videoDraftId: videoTargets.videoDraftId })
    .from(videoTargets)
    .where(and(eq(videoTargets.status, "verification_required"), lt(videoTargets.updatedAt, unansweredBefore)))
    .all())
    recordVideoCompletionIfFinal(backendDb, stranded.videoDraftId);

  const videos = unsafeDb(backendDb)
    .db.select({ target: videoTargets, draft: videoDrafts, job: videoJobs })
    .from(videoTargets)
    .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
    .innerJoin(videoJobs, eq(videoJobs.videoTargetId, videoTargets.id))
    .where(
      and(
        eq(videoTargets.status, "verification_required"),
        eq(videoJobs.status, "verification_required"),
        lt(videoJobs.reconcileAttemptCount, RECONCILE_MAX_ATTEMPTS),
        or(isNull(videoJobs.nextAttemptAt), lte(videoJobs.nextAttemptAt, nowIso)),
        or(isNull(videoJobs.lockedBy), isNull(videoJobs.lockedAt), lt(videoJobs.lockedAt, staleBefore)),
      ),
    )
    .limit(PUBLISH_CLAIM_LIMIT)
    .all();
  for (const row of videos) {
    const claimed = unsafeDb(backendDb)
      .db.update(videoJobs)
      .set({ lockedBy: reconciliationWorker, lockedAt: nowIso, updatedAt: nowIso })
      .where(
        and(
          eq(videoJobs.id, row.job.id),
          eq(videoJobs.status, "verification_required"),
          or(isNull(videoJobs.lockedBy), isNull(videoJobs.lockedAt), lt(videoJobs.lockedAt, staleBefore)),
        ),
      )
      .returning({ id: videoJobs.id })
      .get();
    if (!claimed) continue;
    const job = { ...row.job, lockedBy: reconciliationWorker, lockedAt: nowIso };
    checked += 1;
    const locale = row.draft.locale === "en" ? "en" : "ru";
    const credentialTarget = videoChannelIdentity(backendDb, row.target.target as "youtube_shorts" | "instagram_reels", locale);
    if (isTargetAuthBlocked(backendDb, credentialTarget)) {
      deferVideoReconciliation(backendDb, job, reconciliationWorker);
      continue;
    }
    // Native Instagram Reels are deliberately absent below. Before media_publish
    // returns, the only durable handle on the target is a *container* ID, and
    // Graph offers no way to find the media a container became. Asking about the
    // container as if it were media would 404 at best. These close via operator.
    let confirmation: { externalId?: string | null; url?: string | null } | null = null;
    try {
      if (row.target.deliveryProvider === "zernio" && row.target.providerPostId) {
        const verified = await verifyZernioPost(config, row.target.providerPostId, "instagram", fetchImpl);
        confirmation = { externalId: verified.externalId, url: verified.url };
      } else if (row.target.target === "youtube_shorts" && row.target.externalId) {
        const verified = await verifyYouTubeVideo(config, row.target.externalId, locale, fetchImpl);
        if (row.job.kind === "prepare" || verified.privacyStatus === "public")
          confirmation = { externalId: verified.id, url: verified.url };
      }
    } catch (error) {
      if (classifyPublishError(error) === "auth") recordAuthFailure(backendDb, credentialTarget);
      deferVideoReconciliation(backendDb, job, reconciliationWorker);
      continue;
    }
    if (!confirmation) {
      deferVideoReconciliation(backendDb, job, reconciliationWorker);
      continue;
    }
    recordAuthSuccess(backendDb, credentialTarget);
    const now = new Date().toISOString();
    const prepared = row.job.kind === "prepare";
    // Same order as the social case above: win the job's fence first, and only
    // then apply the target state this job actually established.
    const confirmedVideo = unsafeDb(backendDb).db.transaction((tx) => {
      const won = tx
        .update(videoJobs)
        .set({ status: "completed", lastError: null, lockedAt: null, lockedBy: null, updatedAt: now })
        .where(
          and(
            eq(videoJobs.videoTargetId, row.target.id),
            eq(videoJobs.status, "verification_required"),
            eq(videoJobs.lockedBy, reconciliationWorker),
          ),
        )
        .returning({ id: videoJobs.id })
        .get();
      if (!won) return false;
      tx.update(videoTargets)
        .set({
          status: prepared ? "prepared" : "published",
          externalId: confirmation?.externalId ?? row.target.externalId,
          externalUrl: confirmation?.url ?? row.target.externalUrl,
          lastError: null,
          publishedAt: prepared ? row.target.publishedAt : (row.target.publishedAt ?? now),
          confirmationSource: "provider_verify",
          verifiedAt: prepared ? row.target.verifiedAt : now,
          updatedAt: now,
        })
        .where(and(eq(videoTargets.id, row.target.id), eq(videoTargets.status, "verification_required")))
        .run();
      return true;
    });
    if (!confirmedVideo) continue;
    refreshVideoDraftStatus(backendDb, row.target.videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
    // The publication held its outcome until this answer, so this is where the
    // operator finally hears it — once, and true.
    recordVideoCompletionIfFinal(backendDb, row.target.videoDraftId);
    backendDb.events.record({
      ref: publicationRef("video", row.target.videoDraftId),
      target: row.target.target,
      type: "video.target.reconciled",
      severity: "info",
      message: `${row.target.target} video publication was confirmed`,
      details: { videoTargetId: row.target.id, confirmation_source: "provider_verify" },
    });
    resolved += 1;
  }

  // Age is read from the *targets*, never from the jobs. Deferring a poll
  // touches the job row, so measuring there would reset the incident's age on
  // every tick and an inbox that never ages is an inbox nobody escalates.
  const unresolvedTimes = [
    ...unsafeDb(backendDb)
      .db.select({ updatedAt: publicationTargets.updatedAt })
      .from(publicationTargets)
      .where(eq(publicationTargets.status, "verification_required"))
      .all(),
    ...unsafeDb(backendDb)
      .db.select({ updatedAt: videoTargets.updatedAt })
      .from(videoTargets)
      .where(eq(videoTargets.status, "verification_required"))
      .all(),
  ]
    .map((row) => row.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  if (unresolvedTimes.length) {
    backendDb.events.record({
      type: "studio.notification.publication_verification_required",
      severity: "warn",
      message: `${unresolvedTimes.length} publication(s) still require verification; oldest since ${unresolvedTimes[0]}`,
      details: { count: unresolvedTimes.length, oldest_at: unresolvedTimes[0] },
      cooldownSeconds: ALERT_COOLDOWN_SECONDS,
    });
  }
  return { checked, resolved, unresolved: unresolvedTimes.length, oldestAt: unresolvedTimes[0] ?? null };
}

function deferOrdinaryReconciliation(backendDb: BackendDb, job: typeof publishJobs.$inferSelect, owner: string): void {
  const attempt = job.reconcileAttemptCount + 1;
  unsafeDb(backendDb)
    .db.update(publishJobs)
    .set({
      reconcileAttemptCount: attempt,
      nextAttemptAt: reconciliationNextAttempt(attempt),
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "verification_required"), eq(publishJobs.lockedBy, owner)))
    .run();
}

function deferVideoReconciliation(backendDb: BackendDb, job: typeof videoJobs.$inferSelect, owner: string): void {
  const attempt = job.reconcileAttemptCount + 1;
  unsafeDb(backendDb)
    .db.update(videoJobs)
    .set({
      reconcileAttemptCount: attempt,
      nextAttemptAt: reconciliationNextAttempt(attempt),
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(videoJobs.id, job.id), eq(videoJobs.status, "verification_required"), eq(videoJobs.lockedBy, owner)))
    .run();
}

function reconciliationNextAttempt(attempt: number): string | null {
  if (attempt >= RECONCILE_MAX_ATTEMPTS) return null;
  return nextRetryAt(attempt, PUBLISH_BACKOFF_BASE_SECONDS, PUBLISH_BACKOFF_MAX_SECONDS);
}
