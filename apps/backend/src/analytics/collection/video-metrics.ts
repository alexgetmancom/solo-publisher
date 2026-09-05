import crypto from "node:crypto";
import { and, asc, eq, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { publicationRef } from "../../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { videoDrafts, videoMetricSchedule, videoTargets } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { instagramCredentialsForLocale, instagramGraphHost } from "../../foundation/external/instagram.js";
import { youtubeAccessToken } from "../../foundation/external/youtube.js";
import { zernioRequest } from "../../foundation/external/zernio.js";
import { requestJson } from "../../foundation/http.js";
import { t } from "../../foundation/i18n/index.js";
import { log } from "../../foundation/logger.js";
import { markSynced, mergeVideoSnapshot, metricNumber, upsertComment, upsertVideoSnapshot } from "../snapshots/creator-store.js";
import { describeMetricFreeze, isTerminalMetricError, terminalIfMissingRemoteObject } from "./collectors/errors.js";
import { nextVideoMetricCheckAt, videoMetricCheckpointAt } from "./metric-checkpoints.js";
import { MAX_METRIC_TASKS_PER_CYCLE, METRIC_LOCK_TIMEOUT_SECONDS } from "./metric-schedule.js";
import { queryYouTubeAnalytics, youtubeAnalyticsCompletedEnd, youtubeAnalyticsDate } from "./youtube-analytics.js";

type VideoMetricTask = {
  id: number;
  videoDraftId: number;
  target: "youtube_shorts" | "instagram_reels";
  externalId: string;
  providerPostId: string | null;
  deliveryProvider: string;
  externalUrl: string | null;
  publishedAt: string;
  label: string | null;
  metadataJson: Record<string, unknown>;
  checkpointIndex: number;
  errorCount: number;
  locale: "ru" | "en";
  lockId: string;
};
type YouTubeVideo = {
  items?: Array<{
    snippet?: { title?: string; publishedAt?: string };
    statistics?: Record<string, string>;
    contentDetails?: { duration?: string };
  }>;
};
type YouTubeComments = {
  items?: Array<{
    id?: string;
    snippet?: {
      topLevelComment?: {
        snippet?: {
          textDisplay?: string;
          authorDisplayName?: string;
          publishedAt?: string;
          likeCount?: number;
        };
      };
    };
  }>;
};
type InstagramMedia = {
  like_count?: number;
  comments_count?: number;
  permalink?: string;
  timestamp?: string;
};
type InstagramInsights = { data?: Array<{ values?: Array<{ value?: number }> }> };
type InstagramComments = {
  data?: Array<{
    id?: string;
    text?: string;
    username?: string;
    timestamp?: string;
    like_count?: number;
  }>;
};
type ZernioPostAnalytics = {
  status?: string;
  publishedAt?: string;
  platformPostUrl?: string;
  analytics?: Record<string, number | string | null>;
  platforms?: Array<{
    platform?: string;
    platformPostId?: string;
    platformPostUrl?: string;
    analytics?: Record<string, number | string | null>;
  }>;
};

/** Uses the same fixed-from-publication checkpoints as text-post metrics. */
export async function runVideoMetricSchedule(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<number> {
  ensureVideoMetricSchedule(backendDb);
  const tasks = claimDueVideoMetricTasks(backendDb, MAX_METRIC_TASKS_PER_CYCLE);
  const youtubeTasks = tasks.filter((task) => task.target === "youtube_shorts");
  const youtubeTokens = new Map<"ru" | "en", string>();
  for (const locale of ["ru", "en"] as const) {
    const localizedTasks = youtubeTasks.filter((task) => task.locale === locale);
    if (!localizedTasks.length) continue;
    try {
      // One fresh access token is enough for every Data API request in this
      // cycle. Refreshing once per historical target turns a revoked token
      // into a noisy burst of identical OAuth failures.
      youtubeTokens.set(locale, await youtubeAccessToken(config, fetchImpl, locale));
    } catch (error) {
      const normalized = terminalIfMissingRemoteObject(error);
      const message = normalized instanceof Error ? normalized.message : String(normalized);
      const terminal = isTerminalMetricError(normalized);
      const frozen = localizedTasks.filter((task) => finishVideoMetricTask(backendDb, task, message, terminal));
      if (frozen.length)
        backendDb.events.record({
          ref: `analytics:youtube:${locale}`,
          target: "youtube_shorts",
          type: "analytics.video_metrics.frozen",
          severity: "warn",
          message: describeMetricFreeze(`${frozen.length} ${locale.toUpperCase()} videos`, "youtube_shorts", message),
          details: { video_target_ids: frozen.map((task) => task.id), reason: message },
          cooldownSeconds: 60 * 60,
        });
    }
  }
  for (const task of tasks) {
    try {
      if (task.target === "youtube_shorts") {
        const token = youtubeTokens.get(task.locale);
        if (!token) continue;
        await collectYouTubeVideoMetrics(backendDb, task, token, fetchImpl);
      } else if (task.deliveryProvider === "zernio") await collectZernioInstagramVideoMetrics(config, backendDb, task, fetchImpl);
      else await collectInstagramVideoMetrics(config, backendDb, task, fetchImpl);
      finishVideoMetricTask(backendDb, task, null);
    } catch (error) {
      const normalized = terminalIfMissingRemoteObject(error);
      const frozen = finishVideoMetricTask(
        backendDb,
        task,
        normalized instanceof Error ? normalized.message : String(normalized),
        isTerminalMetricError(normalized),
      );
      if (frozen) {
        const ref = publicationRef("video", task.videoDraftId);
        backendDb.events.record({
          ref,
          target: task.target,
          type: "analytics.video_metrics.frozen",
          severity: "warn",
          // The ref stays in the message: alerts are deduplicated by their
          // text, and a message naming only the platform would collapse two
          // different videos failing the same way into one alert.
          message: describeMetricFreeze(ref, task.target, normalized.message),
          details: { video_target_id: task.id, reason: normalized.message },
          cooldownSeconds: 60 * 60,
        });
      }
    }
  }
  for (const locale of ["ru", "en"] as const) {
    const localizedTasks = youtubeTasks.filter((task) => task.locale === locale);
    const token = youtubeTokens.get(locale);
    if (!localizedTasks.length || !token) continue;
    try {
      await collectYouTubeVideoAnalyticsBatch(backendDb, localizedTasks, token, fetchImpl);
      markSynced(backendDb, `youtube_video_analytics_${locale}`);
    } catch (error) {
      // Data API snapshots remain authoritative for the checkpoint. Analytics
      // enrichment is retried on the next video checkpoint and never freezes a
      // healthy publication just because the report endpoint is delayed.
      markSynced(backendDb, `youtube_video_analytics_${locale}`, error instanceof Error ? error.message : String(error));
    }
  }
  return tasks.length;
}

/** Only published targets that don't have a schedule row yet are new; the left
 * join keeps this cheap regardless of how much publish history has piled up. */
function ensureVideoMetricSchedule(backendDb: BackendDb): void {
  const now = new Date().toISOString();
  const targets = unsafeDb(backendDb)
    .db.select({ id: videoTargets.id, publishedAt: videoTargets.publishedAt })
    .from(videoTargets)
    .leftJoin(videoMetricSchedule, eq(videoMetricSchedule.videoTargetId, videoTargets.id))
    .where(
      and(
        eq(videoTargets.status, "published"),
        or(eq(videoTargets.target, "youtube_shorts"), eq(videoTargets.target, "instagram_reels")),
        isNull(videoMetricSchedule.videoTargetId),
      ),
    )
    .all();
  for (const target of targets) {
    const publishedAt = new Date(target.publishedAt ?? now);
    unsafeDb(backendDb)
      .db.insert(videoMetricSchedule)
      .values({
        videoTargetId: target.id,
        checkpointIndex: 0,
        nextCheckAt: videoMetricCheckpointAt(publishedAt.toISOString(), publishedAt).toISOString(),
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
  // Existing publications used the former sparse (1/3/6/12/24h) cadence.
  // Bring them onto the new video-only cadence from their last observation,
  // without backfilling missed calls or touching text-post schedules.
  //
  // The new cadence never schedules further than 7 days past the last check, so
  // any row inside that window is already converged. Expressing that bound in
  // SQL is what makes the pass free once the correction has run its course:
  // otherwise it re-reads 500 rows on every collection cycle forever. It is a
  // deliberately coarse superset — the exact per-row decision below still
  // belongs to nextVideoMetricCheckAt.
  const scheduled = unsafeDb(backendDb)
    .db.select({
      id: videoTargets.id,
      publishedAt: videoTargets.publishedAt,
      lastCheckedAt: videoMetricSchedule.lastCheckedAt,
      nextCheckAt: videoMetricSchedule.nextCheckAt,
    })
    .from(videoMetricSchedule)
    .innerJoin(videoTargets, eq(videoTargets.id, videoMetricSchedule.videoTargetId))
    .where(
      and(
        eq(videoTargets.status, "published"),
        or(eq(videoTargets.target, "youtube_shorts"), eq(videoTargets.target, "instagram_reels")),
        isNotNull(videoMetricSchedule.lastCheckedAt),
        isNull(videoMetricSchedule.frozenAt),
        sql`julianday(${videoMetricSchedule.nextCheckAt}) > julianday(${videoMetricSchedule.lastCheckedAt}) + 7`,
      ),
    )
    .limit(500)
    .all();
  for (const task of scheduled) {
    if (!task.lastCheckedAt) continue;
    const desired = nextVideoMetricCheckAt(task.publishedAt, new Date(task.lastCheckedAt)).toISOString();
    if (!task.nextCheckAt || task.nextCheckAt > desired)
      unsafeDb(backendDb)
        .db.update(videoMetricSchedule)
        .set({ nextCheckAt: desired, updatedAt: now })
        .where(eq(videoMetricSchedule.videoTargetId, task.id))
        .run();
  }
}

function claimDueVideoMetricTasks(backendDb: BackendDb, limit: number, worker = `video-metrics:${crypto.randomUUID()}`): VideoMetricTask[] {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - METRIC_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const rows = unsafeDb(backendDb)
    .db.select({
      id: videoTargets.id,
      videoDraftId: videoTargets.videoDraftId,
      target: videoTargets.target,
      externalId: videoTargets.externalId,
      providerPostId: videoTargets.providerPostId,
      deliveryProvider: videoTargets.deliveryProvider,
      externalUrl: videoTargets.externalUrl,
      publishedAt: videoTargets.publishedAt,
      label: videoDrafts.label,
      metadataJson: videoTargets.metadataJson,
      checkpointIndex: videoMetricSchedule.checkpointIndex,
      errorCount: videoMetricSchedule.errorCount,
      locale: videoDrafts.locale,
      lockedBy: videoMetricSchedule.lockedBy,
      lockedAt: videoMetricSchedule.lockedAt,
    })
    .from(videoMetricSchedule)
    .innerJoin(videoTargets, eq(videoTargets.id, videoMetricSchedule.videoTargetId))
    .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
    .where(
      and(
        eq(videoTargets.status, "published"),
        isNull(videoMetricSchedule.frozenAt),
        lte(videoMetricSchedule.nextCheckAt, now),
        or(eq(videoTargets.target, "youtube_shorts"), eq(videoTargets.target, "instagram_reels")),
        or(isNull(videoMetricSchedule.lockedBy), isNull(videoMetricSchedule.lockedAt), lt(videoMetricSchedule.lockedAt, cutoff)),
      ),
    )
    .orderBy(asc(videoMetricSchedule.nextCheckAt))
    .limit(limit)
    .all()
    .filter((task) => Boolean((task.deliveryProvider === "zernio" ? task.providerPostId : task.externalId) && task.publishedAt));
  const claimed: VideoMetricTask[] = [];
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const task of rows) {
      const locked = tx
        .update(videoMetricSchedule)
        .set({ lockedBy: worker, lockedAt: now, updatedAt: now })
        .where(
          and(
            eq(videoMetricSchedule.videoTargetId, task.id),
            or(isNull(videoMetricSchedule.lockedBy), isNull(videoMetricSchedule.lockedAt), lt(videoMetricSchedule.lockedAt, cutoff)),
          ),
        )
        .returning({ videoTargetId: videoMetricSchedule.videoTargetId })
        .get();
      if (locked) claimed.push({ ...task, lockId: worker } as VideoMetricTask);
    }
  });
  return claimed;
}

async function collectZernioInstagramVideoMetrics(
  config: BackendConfig,
  backendDb: BackendDb,
  target: VideoMetricTask,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!target.providerPostId) throw new Error("Zernio analytics post ID is missing");
  const data = await zernioRequest<ZernioPostAnalytics>(
    config,
    `analytics?${new URLSearchParams({ postId: target.providerPostId })}`,
    fetchImpl,
  );
  const platform = data.platforms?.find((item) => item.platform === "instagram");
  const metrics = platform?.analytics ?? data.analytics ?? {};
  const follows = optionalProviderMetric(metrics.follows);
  const views = metricNumber(metrics.views);
  const averageWatchTimeMs = firstMetric(metrics, ["igReelsAvgWatchTime", "averageWatchTimeMs", "averageWatchTime"]);
  const totalWatchTimeMs = firstMetric(metrics, ["igReelsVideoViewTotalTime", "totalWatchTimeMs", "totalWatchTime"]);
  const videoDurationMs = analyticsVideoDurationMs(metrics) ?? targetVideoDurationMs(target);
  const completionRate =
    providerCompletionRate(metrics) ?? derivedCompletionRate(views, averageWatchTimeMs, totalWatchTimeMs, videoDurationMs);
  upsertVideoSnapshot(backendDb, target.id, "instagram_reels", target.checkpointIndex, {
    title: target.label ?? t(target.locale, "common.untitled"),
    url: platform?.platformPostUrl ?? data.platformPostUrl ?? target.externalUrl,
    publishedAt: data.publishedAt ?? target.publishedAt,
    views,
    likes: metricNumber(metrics.likes),
    comments: metricNumber(metrics.comments),
    reach: metricNumber(metrics.reach),
    impressions: metricNumber(metrics.impressions),
    shares: metricNumber(metrics.shares),
    saves: metricNumber(metrics.saves),
    ...(follows === null ? {} : { follows }),
    engagementRate: metricNumber(metrics.engagementRate),
    ...(averageWatchTimeMs === null ? {} : { averageWatchTimeMs }),
    ...(totalWatchTimeMs === null ? {} : { totalWatchTimeMs }),
    ...(videoDurationMs === null ? {} : { videoDurationMs }),
    ...(completionRate === null ? {} : { completionRate }),
  });
}

function targetVideoDurationMs(target: VideoMetricTask): number | null {
  const milliseconds = firstMetric(target.metadataJson, ["videoDurationMs", "durationMs"]);
  if (milliseconds !== null && milliseconds > 0) return milliseconds;
  const seconds = firstMetric(target.metadataJson, ["videoDuration", "duration"]);
  return seconds !== null && seconds > 0 ? seconds * 1_000 : null;
}

function providerCompletionRate(metrics: Record<string, number | string | null>): number | null {
  const value = firstMetric(metrics, [
    "completionRate",
    "completion_rate",
    "completionPercentage",
    "completion_percentage",
    "averageViewPercentage",
    "igReelsCompletionRate",
    "igReelsAverageViewPercentage",
  ]);
  return value === null ? null : clampPercentage(value);
}

function derivedCompletionRate(
  views: number,
  averageWatchTimeMs: number | null,
  totalWatchTimeMs: number | null,
  videoDurationMs: number | null,
): number | null {
  if (videoDurationMs === null || videoDurationMs <= 0) return null;
  if (totalWatchTimeMs !== null && views > 0) return clampPercentage((totalWatchTimeMs / (views * videoDurationMs)) * 100);
  if (averageWatchTimeMs !== null && averageWatchTimeMs > 0) return clampPercentage((averageWatchTimeMs / videoDurationMs) * 100);
  return null;
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** A non-terminal error (e.g. a transient timeout) retries every 15 minutes;
 * this caps how many times that can happen before the row freezes like a
 * terminal failure, so an error class isTerminalMetricError doesn't recognize
 * can't retry forever. */
const MAX_METRIC_ERROR_RETRIES = 20;

/** Returns whether the row was frozen (terminal error or retry budget exhausted). */
function finishVideoMetricTask(backendDb: BackendDb, task: VideoMetricTask, error: string | null, terminal = false): boolean {
  const now = new Date();
  const nextIndex = error ? task.checkpointIndex : task.checkpointIndex + 1;
  const errorCount = error ? task.errorCount + 1 : 0;
  const exhausted = error != null && errorCount >= MAX_METRIC_ERROR_RETRIES;
  const nextCheckAt =
    terminal || exhausted ? null : error ? new Date(now.getTime() + 15 * 60_000) : nextVideoMetricCheckAt(task.publishedAt, now);
  unsafeDb(backendDb)
    .db.update(videoMetricSchedule)
    .set({
      checkpointIndex: nextIndex,
      errorCount,
      // The schedule row keeps a non-null timestamp for legacy SQLite schema;
      // frozenAt is the authoritative terminal-state flag.
      nextCheckAt: (nextCheckAt ?? now).toISOString(),
      lastCheckedAt: now.toISOString(),
      lastError: error,
      frozenAt: nextCheckAt == null ? now.toISOString() : null,
      lockedBy: null,
      lockedAt: null,
      updatedAt: now.toISOString(),
    })
    .where(and(eq(videoMetricSchedule.videoTargetId, task.id), eq(videoMetricSchedule.lockedBy, task.lockId)))
    .run();
  return nextCheckAt == null;
}

async function collectYouTubeVideoMetrics(
  backendDb: BackendDb,
  target: VideoMetricTask,
  token: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const auth = { Authorization: `Bearer ${token}` };
  const video = await requestJson<YouTubeVideo>(
    fetchImpl,
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${encodeURIComponent(target.externalId)}`,
    { headers: auth },
  );
  const item = video.items?.[0];
  upsertVideoSnapshot(backendDb, target.id, "youtube_shorts", target.checkpointIndex, {
    title: item?.snippet?.title ?? target.label ?? t(target.locale, "common.untitled"),
    url: target.externalUrl,
    publishedAt: item?.snippet?.publishedAt ?? target.publishedAt,
    views: metricNumber(item?.statistics?.viewCount),
    likes: metricNumber(item?.statistics?.likeCount),
    comments: metricNumber(item?.statistics?.commentCount),
    videoDurationMs: parseYouTubeDurationMs(item?.contentDetails?.duration),
  });
  // The basic video read works with the publishing token. Comment threads
  // additionally require youtube.force-ssl; comments are enrichment and must
  // never make the entire video metrics checkpoint fail or retry noisily.
  let comments: YouTubeComments | null = null;
  try {
    comments = await requestJson<YouTubeComments>(
      fetchImpl,
      `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(target.externalId)}&maxResults=50&order=time`,
      { headers: auth },
    );
  } catch (error) {
    // Comments are optional enrichment. A token without youtube.force-ssl,
    // a disabled comments endpoint, or a deleted video must not discard the
    // Data API snapshot that was already collected above. It is logged rather
    // than swallowed: a snapshot that keeps counting comments while storing
    // none of them is otherwise indistinguishable from a video nobody wrote on.
    if (!isOptionalYouTubeCommentError(error)) throw error;
    log("warn", "youtube comment threads unavailable", { videoTargetId: target.id, externalId: target.externalId, error });
  }
  for (const comment of comments?.items ?? []) {
    const details = comment.snippet?.topLevelComment?.snippet;
    if (comment.id && details?.textDisplay)
      upsertComment(
        backendDb,
        "youtube",
        comment.id,
        target.id,
        details.textDisplay,
        details.authorDisplayName,
        metricNumber(details.likeCount),
        details.publishedAt,
      );
  }
}

/** Enriches the Data API snapshot with one batched owner Analytics report. */
async function collectYouTubeVideoAnalyticsBatch(
  backendDb: BackendDb,
  tasks: VideoMetricTask[],
  token: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const completedEnd = youtubeAnalyticsCompletedEnd();
  const eligible = tasks.filter((task) => new Date(task.publishedAt).getTime() <= completedEnd.getTime());
  if (!eligible.length) return;
  const startDate = eligible.reduce(
    (earliest, task) => {
      const publishedAt = new Date(task.publishedAt);
      return publishedAt < earliest ? publishedAt : earliest;
    },
    new Date(eligible[0]?.publishedAt ?? completedEnd),
  );
  const range = {
    startDate: youtubeAnalyticsDate(startDate),
    endDate: completedEnd.toISOString().slice(0, 10),
  };
  if (range.startDate > range.endDate) return;
  const tasksByVideo = new Map(eligible.map((task) => [task.externalId, task]));
  const videoIds = [...tasksByVideo.keys()];
  for (let offset = 0; offset < videoIds.length; offset += 500) {
    const batch = videoIds.slice(offset, offset + 500);
    const report = await queryYouTubeAnalytics(fetchImpl, token, {
      ...range,
      metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost",
      dimensions: "video",
      filters: `video==${batch.join(",")}`,
      maxResults: 500,
    });
    const headers = (report.columnHeaders ?? []).map((header, index) => header.name ?? `metric_${index}`);
    for (const row of report.rows ?? []) {
      const values = Object.fromEntries(headers.map((header, index) => [header, row[index]]));
      const videoId = typeof values.video === "string" ? values.video : null;
      const task = videoId ? tasksByVideo.get(videoId) : undefined;
      if (!task) continue;
      const averageViewDuration = optionalProviderMetric(values.averageViewDuration);
      const averageViewPercentage = optionalProviderMetric(values.averageViewPercentage);
      const estimatedMinutesWatched = optionalProviderMetric(values.estimatedMinutesWatched);
      const gained = optionalProviderMetric(values.subscribersGained);
      const lost = optionalProviderMetric(values.subscribersLost);
      const enrichment: Record<string, unknown> = {
        analyticsSource: "youtube_analytics_api",
        ...(averageViewDuration === null ? {} : { averageWatchTimeMs: averageViewDuration * 1_000 }),
        ...(averageViewPercentage === null ? {} : { completionRate: clampPercentage(averageViewPercentage) }),
        ...(estimatedMinutesWatched === null ? {} : { totalWatchTimeMs: estimatedMinutesWatched * 60_000 }),
        ...(gained === null ? {} : { subscribersGained: gained }),
        ...(lost === null ? {} : { subscribersLost: lost }),
        ...(gained === null && lost === null ? {} : { follows: (gained ?? 0) - (lost ?? 0) }),
      };
      if (Object.keys(enrichment).length > 1) mergeVideoSnapshot(backendDb, task.id, "youtube_shorts", task.checkpointIndex, enrichment);
    }
  }
}

function analyticsVideoDurationMs(metrics: Record<string, number | string | null>): number | null {
  const milliseconds = firstMetric(metrics, ["videoDurationMs", "durationMs", "igReelsVideoDurationMs"]);
  if (milliseconds !== null && milliseconds > 0) return milliseconds;
  const seconds = firstMetric(metrics, ["videoDuration", "duration", "igReelsVideoDuration"]);
  return seconds !== null && seconds > 0 ? seconds * 1_000 : null;
}

function firstMetric(metrics: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = metrics[key];
    const parsed = optionalProviderMetric(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function optionalProviderMetric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseYouTubeDurationMs(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const totalSeconds = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  return Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.round(totalSeconds * 1_000) : null;
}

async function collectInstagramVideoMetrics(
  config: BackendConfig,
  backendDb: BackendDb,
  target: VideoMetricTask,
  fetchImpl: typeof fetch,
): Promise<void> {
  const { accessToken: token } = instagramCredentialsForLocale(config, target.locale);
  if (!token) throw new Error("Instagram credentials are missing");
  const host = instagramGraphHost(token);
  const base = `https://${host}/${config.INSTAGRAM_GRAPH_API_VERSION}/${target.externalId}`;
  const media = await requestJson<InstagramMedia>(
    fetchImpl,
    `${base}?fields=like_count,comments_count,permalink,timestamp,caption&access_token=${encodeURIComponent(token)}`,
  );
  const views = await instagramReelViews(fetchImpl, base, token);
  const videoDurationMs = targetVideoDurationMs(target);
  upsertVideoSnapshot(backendDb, target.id, "instagram_reels", target.checkpointIndex, {
    title: target.label ?? t(target.locale, "common.untitled"),
    url: media.permalink ?? target.externalUrl,
    publishedAt: media.timestamp ?? target.publishedAt,
    views,
    likes: metricNumber(media.like_count),
    comments: metricNumber(media.comments_count),
    ...(videoDurationMs === null ? {} : { videoDurationMs }),
  });
  let comments: InstagramComments | null = null;
  try {
    comments = await requestJson<InstagramComments>(
      fetchImpl,
      `${base}/comments?fields=id,text,username,timestamp,like_count&limit=50&access_token=${encodeURIComponent(token)}`,
    );
  } catch (error) {
    // Comment access is optional enrichment just like the Reels play insight.
    // A connected publishing account may publish video without comment-read
    // access, and that must not poison its metrics schedule. Logged for the
    // same reason the YouTube one is: a silent gap reads as an empty audience.
    log("warn", "instagram comments unavailable", { videoTargetId: target.id, externalId: target.externalId, error });
  }
  for (const comment of comments?.data ?? [])
    if (comment.id && comment.text)
      upsertComment(
        backendDb,
        "instagram",
        comment.id,
        target.id,
        comment.text,
        comment.username,
        metricNumber(comment.like_count),
        comment.timestamp,
      );
}

async function instagramReelViews(fetchImpl: typeof fetch, base: string, token: string): Promise<number> {
  try {
    const insights = await requestJson<InstagramInsights>(
      fetchImpl,
      `${base}/insights?metric=plays&access_token=${encodeURIComponent(token)}`,
    );
    return metricNumber(insights.data?.[0]?.values?.[0]?.value);
  } catch {
    // Plays are an optional Reels insight and are not a field on the media
    // object in Graph API v23. Keep likes/comments collection healthy when a
    // connected account does not grant this insight.
    return 0;
  }
}

function isOptionalYouTubeCommentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /(?:commentThreads|comment thread)/i.test(message) &&
    (/(?:\b403\b|\b404\b)/.test(message) ||
      /insufficient(?: authentication)? permissions?|insufficientpermissions|access_token_scope_insufficient/i.test(message))
  );
}
