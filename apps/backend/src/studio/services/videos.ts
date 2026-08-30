import type { Issue, PublicationPipeline, PublicationSchedule } from "../../application/publication-pipeline.js";
import { publicationRef } from "../../application/publication-ref.js";
import { requireStudioMediaAssets } from "../../content/assets.js";
import type { BackendDb } from "../../db/client.js";
import { keepYouTubeUploadPrivate } from "../../delivery/video-publishers.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { cancelScheduledNotifications, scheduleReminder } from "../../notifications/jobs.js";
import { trackUsageAsync, trackUsageSync } from "../../observability/usage.js";
import { immediateScheduleTime, isImmediateSchedule, parseManualSchedule, publicationSlotTime } from "../../publishing/schedule.js";
import { isVideoTargetMetadataEditable } from "../../publishing/state.js";
import {
  cancelVideo,
  createVideoDraft,
  isVideoSourceReplaceable,
  removeVideoTarget,
  replaceVideoSource,
  replaceVideoTargets,
  retryVideoTarget,
  saveVideoMetadata,
  scheduleVideo,
  updateVideoLabel,
  validateVideoDraft,
  validateVideoSource,
} from "../../publishing/video-service.js";
import { settleVideoTarget } from "../../publishing/video-settle.js";
import type { VideoLocale, VideoMetadata, VideoTarget, VideoTechnicalCheck } from "../../publishing/video-types.js";
import { accessibleStudioActorIds } from "../access.js";
import { videoDeliveryProjections } from "../projections.js";
import type { VideoWizardStep } from "../video-fsm.js";
import { requireOwnedPublication } from "./publication-access.js";
import { settingsService } from "./settings.js";

/** Video publication command boundary for Telegram Studio, Web Studio and MCP. */
export function videoService(backendDb: BackendDb, config: BackendConfig) {
  const service = {
    kind: "video" as const,
    capabilities: { scheduleAxis: "target" as const },
    create(actorId: number, studioMediaAssetId: number, locale: VideoLocale = "ru"): number {
      return trackUsageSync(backendDb, "studio.video.create", () => {
        videoAssetPath(backendDb, config, actorId, studioMediaAssetId);
        return createVideoDraft(backendDb, actorId, studioMediaAssetId, config.VIDEO_MEDIA_RETENTION_HOURS, locale);
      });
    },
    get(actorId: number, publicationId: number) {
      const draft = requireOwnedVideo(backendDb, config, actorId, publicationId);
      return { id: draft.id, status: draft.status, draft, targets: backendDb.studioVideos.targets(publicationId) };
    },
    /** Swaps the uploaded file behind an unprepared draft, for the case the
     * operator attached the wrong one. The new file passes the same technical
     * gate as the original before the draft points at it. */
    async replaceSource(actorId: number, publicationId: number, studioMediaAssetId: number) {
      return trackUsageAsync(backendDb, "studio.video.edit", async () => {
        requireOwnedVideo(backendDb, config, actorId, publicationId);
        const technical = await validateVideoSource(videoAssetPath(backendDb, config, actorId, studioMediaAssetId));
        replaceVideoSource(backendDb, publicationId, studioMediaAssetId, technical.seconds);
        return technical;
      });
    },
    /** The same technical check, run on an uploaded file before any draft
     * points at it: what the file is decides whether a draft is worth creating. */
    assetTechnicalCheck(actorId: number, studioMediaAssetId: number): Promise<VideoTechnicalCheck> {
      return validateVideoSource(videoAssetPath(backendDb, config, actorId, studioMediaAssetId));
    },
    sourceReplaceable(actorId: number, publicationId: number): boolean {
      const draft = requireOwnedVideo(backendDb, config, actorId, publicationId);
      const targets = backendDb.studioVideos.targets(publicationId);
      return (
        targets.length > 0 &&
        isVideoSourceReplaceable(
          draft.status,
          targets.map((target) => target.status),
        )
      );
    },
    metadataEditableTargets(actorId: number, publicationId: number): VideoTarget[] {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      return backendDb.studioVideos
        .targets(publicationId)
        .filter((target) => isVideoTargetMetadataEditable(target.status))
        .map((target) => target.target as VideoTarget);
    },
    list(actorId: number, limit = 50) {
      return backendDb.studioVideos.list(accessibleStudioActorIds(config, actorId), limit);
    },
    async schedule(actorId: number, publicationId: number, schedule: Partial<Record<VideoTarget, Date>> | PublicationSchedule) {
      return trackUsageAsync(backendDb, "studio.video.schedule", () =>
        scheduleOwnedVideo(backendDb, config, actorId, publicationId, toVideoScheduleInput(schedule)),
      );
    },
    async validate(actorId: number, publicationId: number): Promise<Issue[]> {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      await validateVideoDraft(config, backendDb, publicationId);
      return [];
    },
    async technicalCheck(actorId: number, publicationId: number) {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      return validateVideoDraft(config, backendDb, publicationId);
    },
    async publish(actorId: number, publicationId: number) {
      return trackUsageAsync(backendDb, "studio.video.publish", async () => {
        // Access first: otherwise an outsider's draft answers "choose platforms"
        // instead of "not yours", which leaks whether it exists and how it looks.
        requireOwnedVideo(backendDb, config, actorId, publicationId);
        const targets = backendDb.studioVideos.targets(publicationId).map((row) => row.target as VideoTarget);
        if (!targets.length) throw new StudioError("err.video-choose-platforms");
        const schedule = Object.fromEntries(targets.map((target) => [target, immediateScheduleTime(backendDb.clock.now())])) as Partial<
          Record<VideoTarget, Date>
        >;
        return scheduleOwnedVideo(backendDb, config, actorId, publicationId, schedule);
      });
    },
    /** Answers a provider-delivered target that lost its worker, by asking the
     * provider with the request id that already fences the publication. */
    settleTarget(actorId: number, publicationId: number, target: VideoTarget) {
      return trackUsageAsync(backendDb, "studio.video.settle", async () => {
        requireOwnedVideo(backendDb, config, actorId, publicationId);
        return settleVideoTarget(config, backendDb, { videoDraftId: publicationId, target, apply: true });
      });
    },
    retryTarget(actorId: number, publicationId: number, target: VideoTarget) {
      return trackUsageSync(backendDb, "studio.video.retry", () => {
        requireOwnedVideo(backendDb, config, actorId, publicationId);
        retryVideoTarget(backendDb, publicationId, target);
        return { requeued: 1, alreadyQueued: 0 };
      });
    },
    async cancel(actorId: number, publicationId: number) {
      return trackUsageAsync(backendDb, "studio.video.cancel", async () => {
        const draft = requireOwnedVideo(backendDb, config, actorId, publicationId);
        const cancellation = cancelVideo(backendDb, publicationId, config.VIDEO_MEDIA_RETENTION_HOURS);
        cancelScheduledNotifications(backendDb, publicationRef("video", publicationId));
        const heldPrivateYouTubeIds: string[] = [];
        const holdFailures: string[] = [];
        for (const videoId of cancellation.holdPrivateYouTubeIds) {
          try {
            await keepYouTubeUploadPrivate(config, videoId, draft.locale === "en" ? "en" : "ru");
            heldPrivateYouTubeIds.push(videoId);
          } catch (error) {
            holdFailures.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (cancellation.manualRemoval.length || holdFailures.length) {
          backendDb.events.record({
            ref: publicationRef("video", publicationId),
            type: "studio.notification.video_cancelled",
            severity: holdFailures.length ? "warn" : "info",
            message: cancellation.manualRemoval.length
              ? `Video #${publicationId} was cancelled locally; published targets require manual removal.`
              : `Video #${publicationId} was cancelled locally; YouTube schedule needs attention.`,
            details: {
              manual_removal: cancellation.manualRemoval,
              held_private_youtube_ids: heldPrivateYouTubeIds,
              hold_failures: holdFailures,
            },
          });
        }
        return { ...cancellation, heldPrivateYouTubeIds, holdFailures };
      });
    },
    preview(actorId: number, publicationId: number) {
      const draft = requireOwnedVideo(backendDb, config, actorId, publicationId);
      return {
        id: draft.id,
        status: draft.status,
        issues: [],
        draft,
        targets: backendDb.studioVideos.targets(publicationId),
        delivery: videoDeliveryProjections(backendDb, publicationId),
      };
    },
    status(actorId: number, publicationId: number) {
      const draft = requireOwnedVideo(backendDb, config, actorId, publicationId);
      return {
        draft,
        targets: backendDb.studioVideos.targets(publicationId),
        jobs: backendDb.studioVideos.jobs(publicationId),
      };
    },
    history(actorId: number, publicationId: number, limit = 50) {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      return backendDb.studioVideos.history(publicationRef("video", publicationId), limit);
    },
    updateMetadata(actorId: number, publicationId: number, target: VideoTarget, metadata: VideoMetadata): void {
      trackUsageSync(backendDb, "studio.video.edit", () => {
        requireOwnedVideo(backendDb, config, actorId, publicationId);
        saveVideoMetadata(backendDb, publicationId, target, metadata);
      });
    },
    editMetadataField(actorId: number, publicationId: number, field: VideoWizardStep, value: unknown): void {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      const target = field === "instagram_caption" ? "instagram_reels" : "youtube_shorts";
      const row = backendDb.studioVideos.targets(publicationId).find((item) => item.target === target);
      const metadata = { ...(row?.metadataJson as Record<string, unknown> | undefined) };
      if (field === "youtube_title") metadata.title = value;
      if (field === "youtube_description") metadata.description = value;
      if (field === "youtube_game_url") metadata.gameUrl = value || undefined;
      if (field === "youtube_tags") metadata.tags = value;
      if (field === "instagram_caption") {
        metadata.caption = value;
        delete metadata.hashtags;
      }
      saveVideoMetadata(backendDb, publicationId, target, metadata as VideoMetadata);
      if (field === "youtube_title") updateVideoLabel(backendDb, publicationId, String(value || "YouTube Shorts"));
    },
    /** Persists everything a metadata wizard collected for one platform and
     * titles the draft after it. Which fields a platform stores, and which of
     * several platforms gets to name the draft, are publication decisions — a
     * dialog only forwards what the operator typed. */
    completeWizardTarget(
      actorId: number,
      publicationId: number,
      target: VideoTarget,
      collected: Record<string, unknown>,
      selected: VideoTarget[],
    ): void {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      const metadata = wizardMetadata(target, collected);
      saveVideoMetadata(backendDb, publicationId, target, metadata);
      if (target === labellingVideoTarget(selected)) updateVideoLabel(backendDb, publicationId, wizardLabel(metadata));
    },
    rename(actorId: number, publicationId: number, label: string): void {
      trackUsageSync(backendDb, "studio.video.edit", () => {
        requireOwnedVideo(backendDb, config, actorId, publicationId);
        updateVideoLabel(backendDb, publicationId, label);
      });
    },
    replaceTargets(actorId: number, publicationId: number, targets: VideoTarget[]): void {
      trackUsageSync(backendDb, "studio.video.edit", () => {
        requireOwnedVideo(backendDb, config, actorId, publicationId);
        replaceVideoTargets(backendDb, publicationId, targets);
      });
    },
    removeTarget(actorId: number, publicationId: number, target: VideoTarget): { cancelled: boolean } {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      return { cancelled: removeVideoTarget(backendDb, publicationId, target, config.VIDEO_MEDIA_RETENTION_HOURS) };
    },
    toggleTarget(actorId: number, publicationId: number, target: string): void {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      const current = backendDb.studioVideos.targets(publicationId).map((item) => item.target as VideoTarget);
      const videoTarget = target as VideoTarget;
      if (current.includes(videoTarget)) {
        removeVideoTarget(backendDb, publicationId, videoTarget, config.VIDEO_MEDIA_RETENTION_HOURS);
        return;
      }
      replaceVideoTargets(backendDb, publicationId, [...current, videoTarget]);
    },
    manualSchedule(actorId: number, publicationId: number, value: string): Date {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      const timeConfig = settingsService(backendDb).timeConfig(actorId, config);
      return parseManualSchedule(value, timeConfig.TIMEZONE, backendDb.clock.now());
    },
    /** The time "send now" means, and reading one back as immediate. Delivery
     * runs off the schedule, so this is a timestamp like any other and the
     * transport never invents its own. */
    immediateTime(): Date {
      return immediateScheduleTime(backendDb.clock.now());
    },
    isImmediate(value: Date): boolean {
      return isImmediateSchedule(value, backendDb.clock.now());
    },
    /** Resolves a slot-button clock (`HH:MM` in the configured Studio zone) to its next occurrence. */
    slotTime(actorId: number, clock: string): Date {
      const timeConfig = settingsService(backendDb).timeConfig(actorId, config);
      return publicationSlotTime(clock, timeConfig.TIMEZONE, backendDb.clock.now());
    },
  };
  service satisfies PublicationPipeline;
  return service;
}

/** YouTube titles the draft whenever it is one of the destinations: it is the
 * only platform with a real title field, so falling back to a caption there
 * would rename an already correctly named draft. */
function labellingVideoTarget(selected: VideoTarget[]): VideoTarget {
  return selected.includes("youtube_shorts") ? "youtube_shorts" : "instagram_reels";
}

function wizardMetadata(target: VideoTarget, collected: Record<string, unknown>): VideoMetadata {
  if (target === "instagram_reels") return { caption: wizardText(collected.instagram_caption) };
  const gameUrl = wizardText(collected.youtube_game_url);
  return {
    title: wizardText(collected.youtube_title),
    description: wizardText(collected.youtube_description),
    tags: Array.isArray(collected.youtube_tags) ? (collected.youtube_tags as string[]) : [],
    ...(gameUrl ? { gameUrl } : {}),
  };
}

function wizardLabel(metadata: VideoMetadata): string {
  if ("title" in metadata) return metadata.title || "YouTube Shorts";
  return metadata.caption || "Instagram Reels";
}

function wizardText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toVideoScheduleInput(input: Partial<Record<VideoTarget, Date>> | PublicationSchedule): Partial<Record<VideoTarget, Date>> {
  if (!("values" in input)) return input;
  return Object.fromEntries(
    Object.entries(input.values).filter(([target]) => ["youtube_shorts", "instagram_reels"].includes(target)),
  ) as Partial<Record<VideoTarget, Date>>;
}

/** Shared by `schedule` (explicit times) and `publish` (schedule ~now): both
 * validate the source, write the schedule and arm reminders identically. */
async function scheduleOwnedVideo(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  publicationId: number,
  schedule: Partial<Record<VideoTarget, Date>>,
) {
  const draft = requireOwnedVideo(backendDb, config, actorId, publicationId);
  const technical = await validateVideoDraft(config, backendDb, publicationId);
  scheduleVideo(backendDb, publicationId, schedule, { prepareLeadMinutes: config.VIDEO_PREPARE_LEAD_MINUTES }, technical.seconds);
  scheduleVideoReminders(backendDb, draft.actorId, publicationId, draft.label);
  return technical;
}

function scheduleVideoReminders(backendDb: BackendDb, ownerId: number, publicationId: number, label: string): void {
  cancelScheduledNotifications(backendDb, publicationRef("video", publicationId));
  const notifications = settingsService(backendDb).notifications(ownerId);
  const reminders = { enabled: notifications.videoRemindersEnabled, minutes: notifications.reminderMinutes };
  const grouped = new Map<string, VideoTarget[]>();
  for (const target of backendDb.studioVideos.targets(publicationId)) {
    if (!target.scheduledAt || ["published", "cancelled", "failed", "verification_required"].includes(target.status)) continue;
    const targets = grouped.get(target.scheduledAt) ?? [];
    targets.push(target.target as VideoTarget);
    grouped.set(target.scheduledAt, targets);
  }
  for (const [publishAt, targets] of grouped) {
    scheduleReminder(backendDb, {
      actorId: ownerId,
      ref: publicationRef("video", publicationId),
      kind: `video.${publishAt}`,
      publishAt: new Date(publishAt),
      title: label || `Video #${publicationId}`,
      targets,
      reminders,
    });
  }
}

function requireOwnedVideo(backendDb: BackendDb, config: BackendConfig, actorId: number, publicationId: number) {
  return requireOwnedPublication(
    backendDb.studioVideos.get(publicationId),
    config,
    actorId,
    "Video publication was not found.",
    "err.video-not-yours",
  );
}

/** The stored file behind an accessible video asset. Every path that reads the
 * source goes through here, so "is it mine and is it a video" is one answer. */
function videoAssetPath(backendDb: BackendDb, config: BackendConfig, actorId: number, studioMediaAssetId: number): string {
  const [asset] = requireStudioMediaAssets(backendDb, actorId, [studioMediaAssetId], accessibleStudioActorIds(config, actorId));
  if (asset?.kind !== "video") throw new StudioError("err.video-needs-asset");
  return asset.localPath;
}
