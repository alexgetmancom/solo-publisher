import { type BackendDb, unsafeDb } from "../../db/client.js";
import { mergeVideoSnapshot, metricNumber } from "../snapshots/creator-store.js";
import {
  retentionAtSeconds,
  youtubeAnalyticsCompletedEnd,
  youtubeAnalyticsDate,
  youtubeAudienceRetention,
  youtubeTrafficSources,
} from "./youtube-analytics.js";

/** Ages at which a video is worth a per-video Analytics read. Traffic sources
 * and the retention curve cost one call each per video -- they cannot be
 * batched the way the plain metrics report can -- so they are taken twice in a
 * video's life rather than on every checkpoint: once the first day is complete,
 * and once the first week is. */
const DEEP_ANALYTICS_AGE_BUCKETS_HOURS = [24, 168] as const;

/** The seconds a Short is won or lost in. */
const RETENTION_SECONDS = [1, 3, 5];

export type DeepAnalyticsTarget = {
  videoTargetId: number;
  externalId: string;
  checkpointIndex: number;
  publishedAt: string;
  videoDurationMs: number | null;
};

/** The oldest bucket this video has reached, or null while it is too young for
 * the first one. */
export function deepAnalyticsBucketFor(publishedAt: string, now = new Date()): number | null {
  const published = new Date(publishedAt).getTime();
  if (Number.isNaN(published)) return null;
  const ageHours = (now.getTime() - published) / 3_600_000;
  let reached: number | null = null;
  for (const bucket of DEEP_ANALYTICS_AGE_BUCKETS_HOURS) if (ageHours >= bucket) reached = bucket;
  return reached;
}

/** Whether this video already carries a reading for that bucket. The marker
 * lives in the snapshot itself, so a redeploy, a re-lock or a backfill cannot
 * make the same paid call twice. */
export function hasDeepAnalytics(backendDb: BackendDb, videoTargetId: number, bucket: number): boolean {
  const row = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT 1 FROM video_metric_snapshots
        WHERE video_target_id = ? AND json_extract(metrics_json, '$.deepAnalyticsBucketHours') = ? LIMIT 1`,
    )
    .get(videoTargetId, bucket);
  return Boolean(row);
}

/** Reads where the views came from and how far into the video people stayed,
 * and merges both into the snapshot the checkpoint just wrote. */
export async function enrichYouTubeDeepAnalytics(
  backendDb: BackendDb,
  target: DeepAnalyticsTarget,
  bucket: number,
  token: string,
  fetchImpl: typeof fetch,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const completedEnd = youtubeAnalyticsCompletedEnd(now);
  const range = { startDate: youtubeAnalyticsDate(new Date(target.publishedAt)), endDate: youtubeAnalyticsDate(completedEnd) };
  if (range.startDate > range.endDate) return {};
  const [sources, curve] = await Promise.all([
    youtubeTrafficSources(fetchImpl, token, target.externalId, range),
    youtubeAudienceRetention(fetchImpl, token, target.externalId, range),
  ]);
  const enrichment = {
    deepAnalyticsBucketHours: bucket,
    deepAnalyticsAt: now.toISOString(),
    trafficSources: sources,
    // The three seconds a Short is won in, and the whole curve behind them.
    // Reading only the three points threw away the shape: where a video loses
    // people in the middle is a different lesson from how it opens, and the
    // curve is already in the answer that was paid for.
    retentionCurve: curve.map((point) => ({
      ratio: Math.round(point.ratio * 1000) / 1000,
      watchRatio: Math.round(point.watchRatio * 1000) / 10,
    })),
    ...retentionAtSeconds(curve, target.videoDurationMs, RETENTION_SECONDS),
  };
  mergeVideoSnapshot(backendDb, target.videoTargetId, "youtube_shorts", target.checkpointIndex, enrichment);
  return enrichment;
}

/** The duration a stored snapshot knows about, for a caller that has the row
 * rather than the task. */
export function snapshotDurationMs(metrics: Record<string, unknown>): number | null {
  const duration = metricNumber(metrics.videoDurationMs);
  return duration > 0 ? duration : null;
}
