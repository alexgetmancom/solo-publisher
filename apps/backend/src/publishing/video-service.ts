import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { videoSourcePath } from "../content/video-assets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoDrafts, videoJobs, videoTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { instagramCredentialsForLocale } from "../foundation/external/instagram.js";
import { youtubeCredentials } from "../foundation/external/youtube.js";
import { probeMediaMetadata } from "../foundation/runtime/ffmpeg.js";
import { isZernioRouteReady, registeredVideoDeliveryRoute } from "./delivery-provider.js";
import { assertFutureSchedule } from "./schedule.js";
import { isAudienceMutationRetryable, isVideoTargetEditable, isVideoTargetMetadataEditable, isVideoTargetSchedulable } from "./state.js";
import { getVideoDraft, insertVideoJob, listVideoTargets, refreshVideoDraftStatus } from "./video-data.js";
import { assertVideoMetadata } from "./video-metadata-limits.js";
import type { VideoLocale, VideoMetadata, VideoTarget, VideoTechnicalCheck } from "./video-types.js";
import { VIDEO_TARGETS } from "./video-types.js";

/** Telegram refuses larger uploads, and the mounted media volume is sized
 * around this. */
const VIDEO_MAX_BYTES = 1_000_000_000;

export function createVideoDraft(
  backendDb: BackendDb,
  actorId: number,
  studioMediaAssetId: number,
  retentionHours: number,
  locale: VideoLocale = "ru",
): number {
  const now = new Date().toISOString();
  const retentionUntil = new Date(Date.now() + retentionHours * 60 * 60_000).toISOString();
  const row = unsafeDb(backendDb)
    .db.insert(videoDrafts)
    .values({
      actorId,
      locale,
      studioMediaAssetId,
      status: "editing",
      retentionUntil,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: videoDrafts.id })
    .get();
  if (!row) throw new Error("Could not create video draft.");
  return row.id;
}

export function updateVideoLabel(backendDb: BackendDb, id: number, label: string): void {
  const draft = getVideoDraft(backendDb, id);
  if (!["draft", "editing", "scheduled"].includes(draft.status)) throw new StudioError("err.video-draft-locked");
  unsafeDb(backendDb)
    .db.update(videoDrafts)
    .set({ label: label.trim(), updatedAt: new Date().toISOString() })
    .where(eq(videoDrafts.id, id))
    .run();
}

export function replaceVideoTargets(backendDb: BackendDb, videoDraftId: number, targets: VideoTarget[]): void {
  const allowed = targets.filter((target, index) => VIDEO_TARGETS.includes(target) && targets.indexOf(target) === index);
  if (allowed.length === 0) throw new StudioError("err.video-pick-platform");
  const now = new Date().toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
    const existingTargets = tx.select().from(videoTargets).where(eq(videoTargets.videoDraftId, videoDraftId)).all();
    if (existingTargets.some((target) => !isVideoTargetEditable(target.status))) throw new StudioError("err.video-targets-locked");
    // Foreign keys cascade (PRAGMA foreign_keys=ON): deleting the
    // target rows removes their comments, metric snapshots and schedules. Reminder
    // jobs carry a null target, so the draft's jobs are cleared explicitly.
    tx.delete(videoJobs).where(eq(videoJobs.videoDraftId, videoDraftId)).run();
    tx.delete(videoTargets).where(eq(videoTargets.videoDraftId, videoDraftId)).run();
    for (const target of allowed)
      tx.insert(videoTargets)
        .values({
          videoDraftId,
          target,
          metadataJson: {},
          status: "editing",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    tx.update(videoDrafts).set({ status: "editing", updatedAt: now }).where(eq(videoDrafts.id, videoDraftId)).run();
  });
}

/** Removes one editable target and every dependent job/metric row atomically. */
export function removeVideoTarget(backendDb: BackendDb, videoDraftId: number, targetName: VideoTarget, retentionHours: number): boolean {
  const target = unsafeDb(backendDb)
    .db.select()
    .from(videoTargets)
    .where(and(eq(videoTargets.videoDraftId, videoDraftId), eq(videoTargets.target, targetName)))
    .get();
  if (!target) throw new StudioError("err.video-target-missing");
  if (!isVideoTargetEditable(target.status)) throw new StudioError("err.video-target-locked");

  const now = new Date().toISOString();
  const remaining = unsafeDb(backendDb).db.transaction((tx) => {
    // FK cascade (see replaceVideoTargets): removing the target row deletes its
    // comments, metric snapshots, schedule and platform jobs.
    // Fenced on the status the editability check above read: a worker can
    // publish this target between that read and this delete, and deleting it
    // then would drop a live publication and its whole history.
    const deleted = tx
      .delete(videoTargets)
      .where(and(eq(videoTargets.id, target.id), eq(videoTargets.status, target.status)))
      .returning({ id: videoTargets.id })
      .get();
    if (!deleted) throw new StudioError("err.video-target-locked");
    const remainingTargets = tx.select({ id: videoTargets.id }).from(videoTargets).where(eq(videoTargets.videoDraftId, videoDraftId)).all();
    if (remainingTargets.length === 0)
      tx.update(videoDrafts)
        .set({
          status: "cancelled",
          retentionUntil: new Date(Date.now() + retentionHours * 60 * 60_000).toISOString(),
          updatedAt: now,
        })
        .where(eq(videoDrafts.id, videoDraftId))
        .run();
    return remainingTargets.length;
  });
  if (remaining > 0) refreshVideoDraftStatus(backendDb, videoDraftId, retentionHours);
  return remaining === 0;
}

export function saveVideoMetadata(backendDb: BackendDb, videoDraftId: number, target: VideoTarget, metadata: VideoMetadata): void {
  const draft = getVideoDraft(backendDb, videoDraftId);
  // A partial publication is not locked, it is half-finished: one platform took
  // it and another refused, and what a refused target usually needs before a
  // retry is exactly the details it was refused for. YouTube rejecting a tag
  // list left the target retryable and its metadata frozen — a retry that could
  // only reproduce the same rejection.
  if (!["draft", "editing", "scheduled", "partial"].includes(draft.status)) throw new StudioError("err.video-draft-locked");
  const existing = unsafeDb(backendDb)
    .db.select({ id: videoTargets.id, status: videoTargets.status })
    .from(videoTargets)
    .where(and(eq(videoTargets.videoDraftId, videoDraftId), eq(videoTargets.target, target)))
    .get();
  if (!existing) throw new StudioError("err.video-target-missing");
  // Every interface writes metadata through here, so this is where the
  // platform's limits are enforced rather than in each of them.
  assertVideoMetadata(target, metadata);
  if (!isVideoTargetMetadataEditable(existing.status)) throw new StudioError("err.video-metadata-locked");
  const runningJob = unsafeDb(backendDb)
    .db.select({ id: videoJobs.id })
    .from(videoJobs)
    .where(and(eq(videoJobs.videoTargetId, existing.id), eq(videoJobs.status, "running")))
    .get();
  if (runningJob) throw new StudioError("err.video-job-running");
  // Fenced on the status the editability and running-job checks above read: a
  // prepare job can claim this target in that window, and the platform would
  // then receive the old title while Studio shows the new one.
  const updated = unsafeDb(backendDb)
    .db.update(videoTargets)
    .set({
      metadataJson: metadata as Record<string, unknown>,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(videoTargets.id, existing.id), eq(videoTargets.status, existing.status)))
    .returning({ id: videoTargets.id })
    .get();
  if (!updated) throw new StudioError("err.video-metadata-locked");
}

/** The source file may still be swapped while every platform is only holding
 * metadata. Preparation is the line: from "prepared" on, a platform already has
 * the bytes, and replacing them here would leave the draft describing a file
 * nobody is going to publish. */
export function isVideoSourceReplaceable(draftStatus: string, targetStatuses: string[]): boolean {
  return ["draft", "editing", "scheduled"].includes(draftStatus) && targetStatuses.every(isVideoTargetMetadataEditable);
}

/** Points the draft at a different uploaded file. The probed duration travels
 * with it: it is recorded per target at scheduling time and describes the
 * source, so a stale one would misreport completion rates in analytics. */
export function replaceVideoSource(backendDb: BackendDb, videoDraftId: number, studioMediaAssetId: number, durationSeconds: number): void {
  const now = new Date().toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
    const draft = tx.select().from(videoDrafts).where(eq(videoDrafts.id, videoDraftId)).get();
    if (!draft) throw new Error("Video publication was not found.");
    const targets = tx.select().from(videoTargets).where(eq(videoTargets.videoDraftId, videoDraftId)).all();
    if (
      !isVideoSourceReplaceable(
        draft.status,
        targets.map((target) => target.status),
      )
    )
      throw new StudioError("err.video-source-locked");
    const runningJob = tx
      .select({ id: videoJobs.id })
      .from(videoJobs)
      .where(and(eq(videoJobs.videoDraftId, videoDraftId), eq(videoJobs.status, "running")))
      .get();
    if (runningJob) throw new StudioError("err.video-job-running");
    for (const target of targets) {
      const metadata = target.metadataJson as Record<string, unknown>;
      // Fenced on the status the replaceability check above read: a prepare job
      // can claim this target in that window and upload the old file, and the
      // draft would then point at a source that platform never received.
      const updated = tx
        .update(videoTargets)
        .set({
          metadataJson: durationSeconds > 0 ? { ...metadata, videoDurationMs: Math.round(durationSeconds * 1_000) } : metadata,
          updatedAt: now,
        })
        .where(and(eq(videoTargets.id, target.id), eq(videoTargets.status, target.status)))
        .returning({ id: videoTargets.id })
        .get();
      if (!updated) throw new StudioError("err.video-source-locked");
    }
    const replaced = tx
      .update(videoDrafts)
      // The new file is present, so the draft is no longer one whose source has
      // been reclaimed and the retention sweep has to see it again.
      .set({ studioMediaAssetId, sourcePrunedAt: null, updatedAt: now })
      .where(and(eq(videoDrafts.id, videoDraftId), eq(videoDrafts.status, draft.status)))
      .returning({ id: videoDrafts.id })
      .get();
    if (!replaced) throw new StudioError("err.video-source-locked");
  });
}

export function scheduleVideo(
  backendDb: BackendDb,
  videoDraftId: number,
  schedule: Partial<Record<VideoTarget, Date>>,
  timing: { prepareLeadMinutes: number },
  durationSeconds?: number,
): void {
  const now = new Date();
  const targets = listVideoTargets(backendDb, videoDraftId);
  if (targets.length === 0) throw new StudioError("err.video-choose-platforms");
  const selectedTargets = targets.filter((target) => schedule[target.target as VideoTarget] != null);
  if (selectedTargets.length === 0) throw new StudioError("err.video-pick-platform");
  for (const target of selectedTargets) {
    // The card already hides the time control for a settled target, but that is
    // a rendering decision: reaching this service another way (a stale keyboard,
    // MCP, a retry path) used to flip a published target back to "scheduled"
    // and arm a second prepare/publish pair for something already delivered.
    if (!isVideoTargetSchedulable(target.status)) throw new StudioError("err.video-target-not-schedulable");
    const date = schedule[target.target as VideoTarget];
    if (!date) throw new StudioError("err.schedule-time-past");
    assertFutureSchedule(date, now);
  }
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const target of selectedTargets) {
      const targetSchedule = schedule[target.target as VideoTarget];
      if (!targetSchedule) continue;
      const publishAt = targetSchedule.toISOString();
      const preparedAt = new Date(targetSchedule.getTime() - timing.prepareLeadMinutes * 60_000);
      const draft = getVideoDraft(backendDb, videoDraftId);
      const route = registeredVideoDeliveryRoute(backendDb, target.target as VideoTarget, draft.locale === "en" ? "en" : "ru");
      const metadata = target.metadataJson as Record<string, unknown>;
      const metadataJson =
        durationSeconds != null && durationSeconds > 0 && metadata.videoDurationMs == null
          ? { ...metadata, videoDurationMs: Math.round(durationSeconds * 1_000) }
          : metadata;
      // Fenced on the status `isVideoTargetSchedulable` was checked against.
      // That check happens before the transaction, and the comment above says
      // exactly what it exists to prevent — so the condition has to reach the
      // write, or a target published in that window is armed a second time.
      const scheduled = tx
        .update(videoTargets)
        .set({
          scheduledAt: publishAt,
          status: "scheduled",
          metadataJson,
          lastError: null,
          deliveryProvider: route.provider,
          providerAccountId: route.accountId ?? null,
          updatedAt: now.toISOString(),
        })
        .where(and(eq(videoTargets.id, target.id), eq(videoTargets.status, target.status)))
        .returning({ id: videoTargets.id })
        .get();
      if (!scheduled) throw new StudioError("err.video-target-not-schedulable");
      insertVideoJob(tx, videoDraftId, target.id, "prepare", preparedAt.toISOString());
      insertVideoJob(tx, videoDraftId, target.id, "publish", publishAt);
    }
    const activeSchedules = tx
      .select({ scheduledAt: videoTargets.scheduledAt })
      .from(videoTargets)
      .where(and(eq(videoTargets.videoDraftId, videoDraftId), ne(videoTargets.status, "published"), ne(videoTargets.status, "cancelled")))
      .all()
      .flatMap((target) => (target.scheduledAt ? [new Date(target.scheduledAt).getTime()] : []));
    const common = activeSchedules.length > 0 ? Math.min(...activeSchedules) : null;
    tx.update(videoDrafts)
      .set({
        status: "scheduled",
        scheduledAt: common == null ? null : new Date(common).toISOString(),
        retentionUntil: null,
        updatedAt: now.toISOString(),
      })
      .where(eq(videoDrafts.id, videoDraftId))
      .run();
  });
}

/** Requeues only an explicitly selected failed or externally verified platform;
 * the other platform and its media stay untouched. */
export function retryVideoTarget(backendDb: BackendDb, videoDraftId: number, targetName: VideoTarget): void {
  const target = unsafeDb(backendDb)
    .db.select()
    .from(videoTargets)
    .where(and(eq(videoTargets.videoDraftId, videoDraftId), eq(videoTargets.target, targetName)))
    .get();
  if (!target || !isAudienceMutationRetryable(target.status)) throw new StudioError("err.retry-only-failed");
  const now = new Date();
  const nowIso = now.toISOString();
  // The same distinction the publish queue draws by name: a delivery that
  // carries what it already put on the platform is continued, one that carries
  // nothing starts over. Video spells it for the single platform where it
  // happens -- a YouTube upload survives a failed publish and is the thing the
  // retry continues from -- but it is the same question, asked before the row
  // that holds the answer is overwritten.
  const continuesFromUpload = targetName === "youtube_shorts" && Boolean(target.externalId);
  unsafeDb(backendDb).db.transaction((tx) => {
    tx.update(videoTargets)
      .set({
        status: continuesFromUpload ? "prepared" : "scheduled",
        ...(continuesFromUpload ? {} : { externalId: null, externalUrl: null, preparedAt: null }),
        lastError: null,
        updatedAt: nowIso,
      })
      .where(eq(videoTargets.id, target.id))
      .run();
    if (!continuesFromUpload) insertVideoJob(tx, videoDraftId, target.id, "prepare", nowIso);
    insertVideoJob(tx, videoDraftId, target.id, "publish", new Date(now.getTime() + 60_000).toISOString());
    tx.update(videoDrafts)
      .set({ status: "scheduled", retentionUntil: null, updatedAt: nowIso })
      .where(eq(videoDrafts.id, videoDraftId))
      .run();
  });
  // The id this row named is now referenced by nothing: whatever it pointed at
  // on the platform, no command can reach it again. The post queue journals the
  // same loss for the same reason -- it is the only record that object ever
  // existed.
  if (!continuesFromUpload && target.externalId)
    backendDb.events.record({
      ref: publicationRef("video", videoDraftId),
      target: targetName,
      type: "publish.target.identity_dropped",
      severity: "warn",
      message: `${targetName} was retried while it still named a live upload; that upload is no longer referenced`,
      details: { external_id: target.externalId, url: target.externalUrl, provider_post_id: target.providerPostId },
    });
}

export async function validateVideoDraft(config: BackendConfig, backendDb: BackendDb, videoDraftId: number): Promise<VideoTechnicalCheck> {
  const draft = getVideoDraft(backendDb, videoDraftId);
  const locale = draft.locale === "en" ? "en" : "ru";
  const source = videoSourcePath(backendDb, draft);
  if (!source) throw new StudioError("err.source-missing");
  for (const target of listVideoTargets(backendDb, videoDraftId)) {
    if (target.target === "youtube_shorts") {
      const credentials = youtubeCredentials(config, locale);
      if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken)
        throw new StudioError("err.youtube-not-configured");
    }
    if (target.target === "instagram_reels") {
      const route = registeredVideoDeliveryRoute(backendDb, "instagram_reels", locale);
      if (!isZernioRouteReady(config, route) && route.provider === "zernio") throw new StudioError("err.instagram-not-configured");
      const instagramCredentials = instagramCredentialsForLocale(config, locale);
      if (route.provider === "native" && (!instagramCredentials.accessToken || !instagramCredentials.userId))
        throw new StudioError("err.instagram-not-configured");
    }
  }
  return validateVideoSource(source);
}

/** Everything the technical check can say about a file on its own, without a
 * draft: the same gate a replacement source has to pass before it is adopted. */
export async function validateVideoSource(source: string): Promise<VideoTechnicalCheck> {
  if (path.extname(source).toLowerCase() !== ".mp4") throw new StudioError("err.need-mp4");
  const size = (await fs.promises.stat(source)).size;
  if (size <= 0) throw new StudioError("err.video-empty");
  if (size > VIDEO_MAX_BYTES)
    throw new StudioError("err.video-too-big", {
      size: Math.ceil(size / 1024 / 1024),
      limit: Math.floor(VIDEO_MAX_BYTES / 1024 / 1024),
    });
  return probeVideo(source, size);
}

async function probeVideo(source: string, size: number): Promise<VideoTechnicalCheck> {
  let metadata: Awaited<ReturnType<typeof probeMediaMetadata>>;
  try {
    metadata = await probeMediaMetadata(source);
  } catch (error) {
    if (error instanceof Error && error.message.includes("did not find a video stream")) throw new StudioError("err.no-video-stream");
    throw new StudioError("err.ffprobe-failed");
  }
  return {
    width: metadata.width,
    height: metadata.height,
    seconds: Math.round(metadata.durationSeconds),
    videoCodec: metadata.videoCodec,
    audioCodec: metadata.audioCodec,
    fps: metadata.fps,
    sizeBytes: size,
    aspectOk: Math.abs(metadata.width / metadata.height - 9 / 16) <= 0.02,
  };
}

type VideoCancellation = {
  /** Already-public targets are deliberately not deleted by automation. */
  manualRemoval: Array<{ target: VideoTarget; url: string | null }>;
  /** Private scheduled uploads which can be safely kept private. */
  holdPrivateYouTubeIds: string[];
};

export function cancelVideo(backendDb: BackendDb, videoDraftId: number, retentionHours: number): VideoCancellation {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const targets = listVideoTargets(backendDb, videoDraftId);
  const manualRemoval = targets
    .filter((target) => target.status === "published")
    .map((target) => ({ target: target.target as VideoTarget, url: target.externalUrl }));
  const holdPrivateYouTubeIds = targets
    .filter(
      (target) =>
        target.target === "youtube_shorts" &&
        target.status !== "published" &&
        target.externalId != null &&
        target.scheduledAt != null &&
        new Date(target.scheduledAt).getTime() > nowMs,
    )
    .map((target) => target.externalId as string);
  unsafeDb(backendDb).db.transaction((tx) => {
    const activeDelivery = tx
      .select({ id: videoJobs.id })
      .from(videoJobs)
      .where(
        and(eq(videoJobs.videoDraftId, videoDraftId), inArray(videoJobs.kind, ["prepare", "publish"]), eq(videoJobs.status, "running")),
      )
      .get();
    if (activeDelivery) throw new StudioError("err.video-cancel-in-progress");
    tx.update(videoJobs)
      .set({ status: "cancelled", lockedAt: null, lockedBy: null, updatedAt: now })
      .where(and(eq(videoJobs.videoDraftId, videoDraftId), eq(videoJobs.status, "queued")))
      .run();
    tx.update(videoTargets)
      .set({ status: "cancelled", updatedAt: now })
      .where(and(eq(videoTargets.videoDraftId, videoDraftId), ne(videoTargets.status, "published")))
      .run();
    tx.update(videoDrafts)
      .set({
        status: "cancelled",
        retentionUntil: new Date(Date.now() + retentionHours * 60 * 60_000).toISOString(),
        updatedAt: now,
      })
      .where(eq(videoDrafts.id, videoDraftId))
      .run();
  });
  return { manualRemoval, holdPrivateYouTubeIds };
}
