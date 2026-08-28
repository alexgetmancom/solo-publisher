import crypto from "node:crypto";
import { and, asc, eq, exists, isNull, lte, or, sql } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { videoChannelIdentity } from "../channels/destinations.js";
import { videoPublicUrl, videoSourcePath } from "../content/video-assets.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { studioYoutubeSettings, videoJobs, videoTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { instagramCredentialsForLocale } from "../foundation/external/instagram.js";
import { withJobHeartbeat } from "../foundation/runtime/job-heartbeat.js";
import { isTargetAuthBlocked, recordAuthFailure, recordAuthSuccess } from "../observability/auth-circuit.js";
import { recordUsage } from "../observability/usage.js";
import { classifyPublishError } from "../publishing/errors.js";
import { failedJobTransition, videoStepMayHaveReachedAudience } from "../publishing/job-policy.js";
import { PUBLISH_CLAIM_LIMIT } from "../publishing/queue.js";
import { publishRetryPolicy } from "../publishing/queue-state.js";
import { isVideoTargetFinal } from "../publishing/state.js";
import { getVideoDraft, refreshVideoDraftStatus, type VideoJob } from "../publishing/video-data.js";
import type { InstagramMetadata, VideoMetadata, YouTubeMetadata } from "../publishing/video-types.js";
import { AmbiguousPublicationError, isAmbiguousPublicationError } from "./ambiguous-publication.js";
import { verifyInstagramPublication } from "./social/instagram.js";

const VIDEO_HEARTBEAT_INTERVAL_SECONDS = 30;

import { PUBLISH_MAX_ATTEMPTS } from "../foundation/config.js";
import { ALERT_COOLDOWN_SECONDS } from "../observability/alerts.js";
import { zernioPublishFence } from "../publishing/video-fence.js";
import {
  InstagramContainerInvalidError,
  InstagramContainerProcessingError,
  instagramContainerReady,
  keepYouTubeUploadPrivate,
  prepareInstagramReel,
  prepareYouTubeVideo,
  publishInstagramReel,
} from "./video-publishers.js";
import { pruneExpiredVideos } from "./video-retention.js";
import { publishZernioInstagramReel } from "./zernio.js";

/** Video jobs heartbeat at a tighter interval than the social pipeline, so
 * this only has to be a few missed heartbeats wide to detect a crash. */
const VIDEO_LOCK_TIMEOUT_SECONDS = 120;

export async function runVideoCycle(config: BackendConfig, backendDb: BackendDb): Promise<number> {
  recoverVideoLocks(backendDb, config);
  let claimed = 0;
  // Deliberately serial, unlike the social pipeline's per-target lanes
  // (delivery/publish-workflow.ts): every job here moves a video file of a few
  // hundred MB, and two concurrent uploads share one uplink, so they finish no
  // sooner together than one after the other — and risk timing each other out.
  // The trade-off is accepted: a target's publish can slip a few minutes past
  // its scheduled time while an upload ahead of it drains.
  while (claimed < PUBLISH_CLAIM_LIMIT) {
    // Claim only the job about to run. Claiming the whole serial batch made
    // untouched jobs look in-flight during a long upload; after a restart,
    // recovery then treated their publish calls as ambiguous even though they
    // had never started.
    const job = claimVideoJobs(backendDb, 1)[0];
    if (!job) break;
    claimed += 1;
    const credentialTarget = videoJobCredentialTarget(backendDb, job);
    if (credentialTarget && isTargetAuthBlocked(backendDb, credentialTarget)) {
      deferBlockedVideoJob(backendDb, job);
      continue;
    }
    const startedAt = Date.now();
    try {
      const settled = await withJobHeartbeat(
        VIDEO_HEARTBEAT_INTERVAL_SECONDS,
        () => {
          try {
            unsafeDb(backendDb).db.update(videoJobs).set({ lockedAt: new Date().toISOString() }).where(activeVideoJob(job)).run();
          } catch {
            // The shared heartbeat wrapper treats one missed beat as recoverable.
          }
        },
        () => executeVideoJob(config, backendDb, job),
      );
      if (settled || completeVideoJob(backendDb, job)) {
        if (credentialTarget) recordAuthSuccess(backendDb, credentialTarget);
        recordVideoProgressEvent(backendDb, job, "video.job.completed");
        recordVideoCompletionIfFinal(backendDb, job.videoDraftId);
      }
      recordUsage(backendDb, "publishing.video.job", true, Date.now() - startedAt);
    } catch (error) {
      const ambiguous = isAmbiguousPublicationError(error);
      const settled = ambiguous ? requireVideoVerification(backendDb, job, error, config) : failVideoJob(backendDb, job, error, config);
      // An upload the provider answered ambiguously and verification took over
      // is the pipeline doing its job, not a failed one. Counted as a failure,
      // it read as one video publish in four broken while every one of those
      // targets reconciled a minute later.
      recordUsage(backendDb, "publishing.video.job", ambiguous && settled, Date.now() - startedAt);
      if (settled) {
        if (credentialTarget && classifyPublishError(error) === "auth") recordAuthFailure(backendDb, credentialTarget);
        recordVideoProgressEvent(backendDb, job, "video.job.failed");
        recordVideoCompletionIfFinal(backendDb, job.videoDraftId);
      }
    }
  }
  pruneExpiredVideos(config, backendDb);
  return claimed;
}

function videoJobCredentialTarget(backendDb: BackendDb, job: VideoJob): string | null {
  if (!job.videoTargetId) return null;
  const target = unsafeDb(backendDb)
    .db.select({ target: videoTargets.target })
    .from(videoTargets)
    .where(eq(videoTargets.id, job.videoTargetId))
    .get();
  if (!target || (target.target !== "youtube_shorts" && target.target !== "instagram_reels")) return null;
  const locale = getVideoDraft(backendDb, job.videoDraftId).locale === "en" ? "en" : "ru";
  return videoChannelIdentity(backendDb, target.target, locale);
}

function deferBlockedVideoJob(backendDb: BackendDb, job: VideoJob): void {
  unsafeDb(backendDb)
    .db.update(videoJobs)
    .set({
      status: "queued",
      nextAttemptAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date().toISOString(),
    })
    .where(activeVideoJob(job))
    .run();
}

/** Keeps target state updates consistent across the prepare/publish/fail/recovery paths. */
function updateVideoTarget(db: UnsafeBackendDb["db"], targetId: number, patch: Partial<typeof videoTargets.$inferInsert>): void {
  db.update(videoTargets)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(videoTargets.id, targetId))
    .run();
}

export function recordVideoCompletionIfFinal(backendDb: BackendDb, videoDraftId: number, now = new Date()): void {
  const targets = unsafeDb(backendDb)
    .db.select({ status: videoTargets.status, providerPostId: videoTargets.providerPostId, updatedAt: videoTargets.updatedAt })
    .from(videoTargets)
    .where(eq(videoTargets.videoDraftId, videoDraftId))
    .all();
  if (!targets.length || !targets.every((target) => isVideoTargetFinal(target.status))) return;
  // A target the provider still owes an answer for is in flight, and saying how
  // the publication went before that answer arrives is how one Reel reported
  // itself as a failure and, a minute later, as published. Bounded, because a
  // provider that never answers must not turn into silence.
  if (targets.some((target) => awaitingProviderConfirmation(target, now))) return;
  const failed = targets.filter((target) => target.status === "failed" || target.status === "verification_required").length;
  backendDb.events.record({
    ref: publicationRef("video", videoDraftId),
    type: "delivery.video.completed",
    severity: failed ? "warn" : "info",
    message: failed ? `Video #${videoDraftId} completed with ${failed} failed target(s)` : `Video #${videoDraftId} published successfully`,
    details: { videoDraftId, total: targets.length, failed, published: targets.filter((target) => target.status === "published").length },
    cooldownSeconds: 60 * 60,
  });
}

/** How long the provider gets to confirm before the operator hears about it. */
export const PROVIDER_CONFIRMATION_GRACE_MS = 15 * 60 * 1000;

function awaitingProviderConfirmation(target: { status: string; providerPostId: string | null; updatedAt: string }, now: Date): boolean {
  if (target.status !== "verification_required" || !target.providerPostId) return false;
  return now.getTime() - new Date(target.updatedAt).getTime() < PROVIDER_CONFIRMATION_GRACE_MS;
}

function claimVideoJobs(backendDb: BackendDb, limit: number): VideoJob[] {
  const now = new Date().toISOString();
  const rows = unsafeDb(backendDb)
    .db.select()
    .from(videoJobs)
    .where(
      and(
        eq(videoJobs.status, "queued"),
        lte(videoJobs.runAt, now),
        or(isNull(videoJobs.nextAttemptAt), lte(videoJobs.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(videoJobs.runAt), asc(videoJobs.id))
    .limit(limit)
    .all();
  const claimed: VideoJob[] = [];
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const job of rows) {
      const updated = tx
        .update(videoJobs)
        .set({
          status: "running",
          lockedBy: `${process.pid}:${crypto.randomUUID()}`,
          lockedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(videoJobs.id, job.id),
            eq(videoJobs.status, "queued"),
            lte(videoJobs.runAt, now),
            or(isNull(videoJobs.nextAttemptAt), lte(videoJobs.nextAttemptAt, now)),
          ),
        )
        .returning()
        .get();
      if (updated) claimed.push(updated);
    }
  });
  return claimed;
}

async function executeVideoJob(config: BackendConfig, backendDb: BackendDb, job: VideoJob): Promise<boolean> {
  if (!job.videoTargetId) throw new Error("Video platform job has no target.");
  const target = unsafeDb(backendDb).db.select().from(videoTargets).where(eq(videoTargets.id, job.videoTargetId)).get();
  const draft = getVideoDraft(backendDb, job.videoDraftId);
  if (!target || target.status === "cancelled" || target.status === "published") return false;
  const filePath = videoSourcePath(backendDb, draft);
  if (!filePath) throw new Error("Video source was removed before publication completed.");
  const metadata = target.metadataJson as VideoMetadata;
  const locale = draft.locale === "en" ? "en" : "ru";
  const instagramCredentials = instagramCredentialsForLocale(config, locale);
  if (job.kind === "prepare") {
    if (target.target === "youtube_shorts") return prepareYouTube(config, backendDb, job, target, filePath, locale);
    if (target.deliveryProvider === "zernio") return prepareZernio(backendDb, job, target);
    return prepareInstagram(config, backendDb, job, target, draft, metadata, instagramCredentials);
  }
  const settled =
    target.target === "youtube_shorts"
      ? publishYouTube(backendDb, job, target)
      : target.deliveryProvider === "zernio"
        ? await publishZernio(config, backendDb, job, target, draft, metadata)
        : await publishInstagram(config, backendDb, job, target, instagramCredentials);
  if (settled) refreshVideoDraftStatus(backendDb, draft.id, config.VIDEO_MEDIA_RETENTION_HOURS);
  return settled;
}

type VideoTarget = typeof videoTargets.$inferSelect;
type VideoDraft = ReturnType<typeof getVideoDraft>;
type InstagramCredentials = ReturnType<typeof instagramCredentialsForLocale>;

async function prepareYouTube(
  config: BackendConfig,
  backendDb: BackendDb,
  job: VideoJob,
  target: VideoTarget,
  filePath: string,
  locale: "en" | "ru",
): Promise<boolean> {
  const metadata = target.metadataJson as YouTubeMetadata;
  const result = await prepareYouTubeVideo(
    config,
    filePath,
    { ...metadata, description: composeYouTubeDescription(backendDb, metadata) },
    target.scheduledAt ?? new Date().toISOString(),
    locale,
  );
  const settled = settleVideoTargetJob(backendDb, job, target.id, {
    status: "prepared",
    externalId: result.id,
    externalUrl: result.url,
    preparedAt: new Date().toISOString(),
    confirmationSource: "publish_response",
  });
  if (!settled) {
    // Cancellation can happen while the resumable upload is in flight. The
    // ID exists only in this response, so fence its future public release
    // before discarding it from local state.
    try {
      await keepYouTubeUploadPrivate(config, result.id, locale);
    } catch (error) {
      backendDb.events.record({
        ref: publicationRef("video", job.videoDraftId),
        type: "studio.notification.video_cancelled",
        severity: "warn",
        target: "youtube_shorts",
        message: "A cancelled YouTube upload could not be kept private; check it manually.",
        details: { videoDraftId: job.videoDraftId, videoId: result.id, error: error instanceof Error ? error.message : String(error) },
      });
    }
    return false;
  }
  return true;
}

function prepareZernio(backendDb: BackendDb, job: VideoJob, target: VideoTarget): boolean {
  // Zernio accepts the public video at its publish time, so prepare is a
  // local checkpoint only. Publishing early would violate the schedule.
  if (!target.providerAccountId) throw new Error("Zernio Instagram account is missing");
  return settleVideoTargetJob(backendDb, job, target.id, { status: "prepared", preparedAt: new Date().toISOString() });
}

async function prepareInstagram(
  config: BackendConfig,
  backendDb: BackendDb,
  job: VideoJob,
  target: VideoTarget,
  draft: VideoDraft,
  metadata: VideoMetadata,
  credentials: InstagramCredentials,
): Promise<boolean> {
  const result = await prepareInstagramReel(config, credentials, videoPublicUrl(backendDb, config, draft), metadata as InstagramMetadata);
  return settleVideoTargetJob(backendDb, job, target.id, {
    status: "prepared",
    externalId: result.id,
    preparedAt: new Date().toISOString(),
  });
}

function publishYouTube(backendDb: BackendDb, job: VideoJob, target: VideoTarget): boolean {
  if (!target.externalId) throw new Error("YouTube upload has not completed yet.");
  return settleVideoTargetJob(backendDb, job, target.id, {
    status: "published",
    publishedAt: new Date().toISOString(),
    confirmationSource: target.confirmationSource ?? "publish_response",
  });
}

async function publishZernio(
  config: BackendConfig,
  backendDb: BackendDb,
  job: VideoJob,
  target: VideoTarget,
  draft: VideoDraft,
  metadata: VideoMetadata,
): Promise<boolean> {
  const accountId = target.providerAccountId;
  if (!accountId) throw new Error("Zernio Instagram account is missing");
  const result = await publishZernioInstagramReel(config, {
    accountId,
    publicUrl: videoPublicUrl(backendDb, config, draft),
    metadata: metadata as InstagramMetadata,
    requestId: zernioPublishFence(job),
  });
  if (!ownsVideoJob(backendDb, job)) return false;
  // The provider takes a publication before the platform does, so a response
  // with no platform link is not a published Reel — it is one nobody has
  // confirmed. Recording it as published is how a card showed a live post the
  // account did not have, and it left the row outside the reconciliation
  // sweep, which is the only thing that could have filled the link in later.
  if (!result.externalId && !result.url) {
    if (!updateActiveVideoTarget(backendDb, job, target.id, { providerPostId: result.providerPostId })) return false;
    throw new AmbiguousPublicationError("zernio", new Error("the provider accepted the publication and the platform has not confirmed it"));
  }
  return settleVideoTargetJob(backendDb, job, target.id, {
    status: "published",
    providerPostId: result.providerPostId,
    externalId: result.externalId,
    externalUrl: result.url,
    publishedAt: new Date().toISOString(),
    confirmationSource: "provider_verify",
    verifiedAt: new Date().toISOString(),
  });
}

async function publishInstagram(
  config: BackendConfig,
  backendDb: BackendDb,
  job: VideoJob,
  target: VideoTarget,
  credentials: InstagramCredentials,
): Promise<boolean> {
  if (!target.externalId) throw new Error("Instagram upload has not completed yet.");
  await instagramContainerReady(config, credentials, target.externalId);
  if (!ownsVideoJob(backendDb, job)) return false;
  const result = await publishInstagramReel(config, credentials, target.externalId);
  if (!ownsVideoJob(backendDb, job)) return false;
  let externalUrl = result.url;
  let verifiedAt: string | null = null;
  try {
    externalUrl = (await verifyInstagramPublication(result.id, config, credentials)).url ?? externalUrl;
    verifiedAt = new Date().toISOString();
  } catch {
    // The publish response already returned the media ID. Verification
    // failure is diagnostic and must not replay media_publish.
  }
  return settleVideoTargetJob(backendDb, job, target.id, {
    status: "published",
    externalId: result.id,
    externalUrl,
    publishedAt: new Date().toISOString(),
    confirmationSource: verifiedAt ? "provider_verify" : "publish_response",
    verifiedAt,
  });
}

function settleVideoTargetJob(
  backendDb: BackendDb,
  job: VideoJob,
  targetId: number,
  patch: Partial<typeof videoTargets.$inferInsert>,
): boolean {
  return unsafeDb(backendDb).db.transaction((tx) => {
    const completed = tx
      .update(videoJobs)
      .set({
        status: "completed",
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date().toISOString(),
      })
      .where(activeVideoJob(job))
      .returning({ id: videoJobs.id })
      .get();
    if (!completed) return false;
    updateVideoTarget(tx, targetId, patch);
    return true;
  });
}

function updateActiveVideoTarget(
  backendDb: BackendDb,
  job: VideoJob,
  targetId: number,
  patch: Partial<typeof videoTargets.$inferInsert>,
): boolean {
  const db = unsafeDb(backendDb).db;
  return (
    db
      .update(videoTargets)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(and(eq(videoTargets.id, targetId), exists(db.select({ id: videoJobs.id }).from(videoJobs).where(activeVideoJob(job)))))
      .returning({ id: videoTargets.id })
      .get() != null
  );
}

function recordVideoProgressEvent(backendDb: BackendDb, job: VideoJob, type: string): void {
  backendDb.events.record({
    ref: publicationRef("video", job.videoDraftId),
    type,
    severity: "info",
    message: `Video job ${job.kind} settled for draft #${job.videoDraftId}`,
    details: { videoDraftId: job.videoDraftId, videoTargetId: job.videoTargetId, jobId: job.id, kind: job.kind },
  });
}

function completeVideoJob(backendDb: BackendDb, job: VideoJob): boolean {
  const completed = unsafeDb(backendDb)
    .db.update(videoJobs)
    .set({
      status: "completed",
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date().toISOString(),
    })
    .where(activeVideoJob(job))
    .returning({ id: videoJobs.id })
    .get();
  return completed != null;
}

function failVideoJob(backendDb: BackendDb, job: VideoJob, cause: unknown, config: BackendConfig): boolean {
  const error = cause instanceof Error ? cause.message : String(cause);
  const transition = failedJobTransition(cause, job.attemptCount, publishRetryPolicy());
  if (cause instanceof InstagramContainerProcessingError && transition.attempt < PUBLISH_MAX_ATTEMPTS) {
    const now = new Date().toISOString();
    let failed = false;
    unsafeDb(backendDb).db.transaction((tx) => {
      const updated = tx
        .update(videoJobs)
        .set({
          status: "queued",
          attemptCount: transition.attempt,
          nextAttemptAt: new Date(Date.now() + 30_000).toISOString(),
          lockedAt: null,
          lockedBy: null,
          lastError: error,
          updatedAt: now,
        })
        .where(activeVideoJob(job))
        .returning({ id: videoJobs.id })
        .get();
      if (!updated) return;
      failed = true;
      if (job.videoTargetId) updateVideoTarget(tx, job.videoTargetId, { status: "prepared", lastError: null });
    });
    return failed;
  }
  const retry = transition.status === "queued";
  const now = new Date().toISOString();
  let failed = false;
  unsafeDb(backendDb).db.transaction((tx) => {
    const updated = tx
      .update(videoJobs)
      .set({
        status: transition.status,
        attemptCount: transition.attempt,
        nextAttemptAt: transition.nextAttemptAt,
        lockedAt: null,
        lockedBy: null,
        lastError: error,
        updatedAt: now,
      })
      .where(activeVideoJob(job))
      .returning({ id: videoJobs.id })
      .get();
    if (!updated) return;
    failed = true;
    if (job.videoTargetId && cause instanceof InstagramContainerInvalidError && job.kind === "publish" && retry) {
      requeueInstagramPreparation(tx, job, error, now, transition.attempt);
    } else if (job.videoTargetId) {
      updateVideoTarget(tx, job.videoTargetId, { status: retry ? "scheduled" : "failed", lastError: error });
      // Preparation is what produces the thing publication sends. When it fails
      // for good, the publish job runs anyway and fails with "upload has not
      // completed yet" — a consequence that replaces the cause on the card and
      // sends the operator looking in the wrong place.
      if (job.kind === "prepare" && !retry) {
        tx.update(videoJobs)
          .set({ status: "cancelled", lastError: error, lockedAt: null, lockedBy: null, updatedAt: now })
          .where(and(eq(videoJobs.videoTargetId, job.videoTargetId), eq(videoJobs.kind, "publish"), eq(videoJobs.status, "queued")))
          .run();
      }
    }
  });
  if (!failed) return false;
  refreshVideoDraftStatus(backendDb, job.videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
  if (!retry) recordVideoTargetOutcome(backendDb, job, error, "failed", ALERT_COOLDOWN_SECONDS);
  return true;
}

function requireVideoVerification(backendDb: BackendDb, job: VideoJob, cause: unknown, config: BackendConfig): boolean {
  const error = cause instanceof Error ? cause.message : String(cause);
  const now = new Date().toISOString();
  let settled = false;
  unsafeDb(backendDb).db.transaction((tx) => {
    const updated = tx
      .update(videoJobs)
      .set({
        status: "verification_required",
        attemptCount: job.attemptCount + 1,
        nextAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        lastError: error,
        updatedAt: now,
      })
      .where(activeVideoJob(job))
      .returning({ id: videoJobs.id })
      .get();
    if (!updated) return;
    settled = true;
    if (job.videoTargetId) updateVideoTarget(tx, job.videoTargetId, { status: "verification_required", lastError: error });
  });
  if (!settled) return false;
  refreshVideoDraftStatus(backendDb, job.videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
  recordVideoTargetOutcome(backendDb, job, error, "verification_required", ALERT_COOLDOWN_SECONDS);
  return true;
}

/** Instagram containers can go stale between prepare and publish; re-run prepare
 * from scratch instead of retrying the publish call against a dead container. */
function requeueInstagramPreparation(tx: UnsafeBackendDb["db"], job: VideoJob, error: string, now: string, attempts: number): void {
  if (!job.videoTargetId) return;
  updateVideoTarget(tx, job.videoTargetId, {
    status: "scheduled",
    externalId: null,
    externalUrl: null,
    preparedAt: null,
    lastError: error,
  });
  tx.update(videoJobs)
    .set({
      status: "queued",
      runAt: now,
      attemptCount: 0,
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      updatedAt: now,
    })
    .where(and(eq(videoJobs.videoDraftId, job.videoDraftId), eq(videoJobs.videoTargetId, job.videoTargetId), eq(videoJobs.kind, "prepare")))
    .run();
  tx.update(videoJobs)
    .set({
      status: "queued",
      attemptCount: attempts,
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      lockedAt: null,
      lockedBy: null,
      lastError: error,
      updatedAt: now,
    })
    .where(eq(videoJobs.id, job.id))
    .run();
}

/** The signature belongs to the Studio's channel, not to whoever authored the
 * draft: read per author, videos from the second administrator went out to the
 * same channel unsigned. */
function composeYouTubeDescription(backendDb: BackendDb, metadata: YouTubeMetadata): string {
  const signature = unsafeDb(backendDb)
    .db.select({ value: studioYoutubeSettings.signature })
    .from(studioYoutubeSettings)
    .where(eq(studioYoutubeSettings.id, 1))
    .get()
    ?.value.trim();
  const gameLine = metadata.gameUrl ? `📀 Steam: ${metadata.gameUrl}` : "";
  return [metadata.description.trim(), gameLine, signature].filter(Boolean).join("\n\n");
}

/** Mirrors the social pipeline's recoverStalePublishJobs (publishing/queue.ts): a
 * crashed/killed worker's job re-enters the normal retry/backoff budget instead
 * of dead-ending in "failed" until an operator notices and retries by hand. The
 * "unknown" error class this produces gets exactly one safety-net retry, same
 * as the social pipeline, so a genuinely stuck target still terminates quickly. */
export function recoverVideoLocks(backendDb: BackendDb, config: BackendConfig): number {
  const cutoff = new Date(Date.now() - VIDEO_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const now = new Date().toISOString();
  const stale = unsafeDb(backendDb)
    .db.select()
    .from(videoJobs)
    .where(and(eq(videoJobs.status, "running"), lte(videoJobs.lockedAt, cutoff)))
    .all();
  let recovered = 0;
  const terminalFailures: Array<{ job: VideoJob; error: string; verificationRequired: boolean }> = [];
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const job of stale) {
      if (!job.lockedAt) continue;
      const error = "worker_lost: video lock expired before completion";
      const target = job.videoTargetId == null ? null : tx.select().from(videoTargets).where(eq(videoTargets.id, job.videoTargetId)).get();
      const ambiguous = videoStepMayHaveReachedAudience(job.kind, target?.target);
      const transition = failedJobTransition(new Error(error), job.attemptCount, publishRetryPolicy());
      const retry = !ambiguous && transition.status === "queued";
      const status = ambiguous ? "verification_required" : transition.status;
      const updated = tx
        .update(videoJobs)
        .set({
          status,
          attemptCount: transition.attempt,
          nextAttemptAt: transition.nextAttemptAt,
          lockedAt: null,
          lockedBy: null,
          lastError: error,
          updatedAt: now,
        })
        .where(and(eq(videoJobs.id, job.id), eq(videoJobs.status, "running"), eq(videoJobs.lockedAt, job.lockedAt)))
        .returning({ id: videoJobs.id })
        .get();
      if (!updated) continue;
      recovered += 1;
      if (job.videoTargetId)
        updateVideoTarget(tx, job.videoTargetId, {
          status: ambiguous ? "verification_required" : retry ? "scheduled" : "failed",
          lastError: error,
        });
      if (!retry) terminalFailures.push({ job, error, verificationRequired: ambiguous });
    }
  });
  for (const job of stale) refreshVideoDraftStatus(backendDb, job.videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
  for (const { job, error, verificationRequired } of terminalFailures) {
    recordVideoTargetOutcome(backendDb, job, error, verificationRequired ? "verification_required" : "failed", ALERT_COOLDOWN_SECONDS);
    recordVideoCompletionIfFinal(backendDb, job.videoDraftId);
  }
  return recovered;
}

function recordVideoTargetOutcome(
  backendDb: BackendDb,
  job: VideoJob,
  error: string,
  outcome: "failed" | "verification_required",
  cooldownSeconds: number,
): void {
  const target =
    job.videoTargetId == null
      ? null
      : unsafeDb(backendDb)
          .db.select({ target: videoTargets.target, providerPostId: videoTargets.providerPostId })
          .from(videoTargets)
          .where(eq(videoTargets.id, job.videoTargetId))
          .get();
  // A publication the provider already holds is waiting, not failing: the
  // provider takes it before the platform does, and the sweep answers within
  // the minute. Announcing that as an incident cried wolf on every Reel.
  const awaitingProvider = outcome === "verification_required" && Boolean(target?.providerPostId);
  backendDb.events.record({
    ref: publicationRef("video", job.videoDraftId),
    type: `video.target.${outcome}`,
    severity: outcome === "failed" ? "error" : awaitingProvider ? "info" : "warn",
    target: target?.target ?? "video",
    message: error,
    details: { videoDraftId: job.videoDraftId, videoTargetId: job.videoTargetId, jobId: job.id, kind: job.kind },
    cooldownSeconds,
  });
}

function ownsVideoJob(backendDb: BackendDb, job: VideoJob): boolean {
  return unsafeDb(backendDb).db.select({ id: videoJobs.id }).from(videoJobs).where(activeVideoJob(job)).get() != null;
}

function activeVideoJob(job: VideoJob) {
  return and(
    eq(videoJobs.id, job.id),
    eq(videoJobs.status, "running"),
    job.lockedBy == null ? sql`false` : eq(videoJobs.lockedBy, job.lockedBy),
  );
}
