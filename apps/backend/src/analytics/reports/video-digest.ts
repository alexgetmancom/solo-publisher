import { type BackendDb, unsafeDb } from "../../db/client.js";
import { metricNumber } from "../snapshots/creator-store.js";

/** How far above its platform's median a young video has to run before it is
 * worth interrupting someone about. Three times the median is not a good day;
 * it is a different distribution. */
const OUTLIER_MULTIPLE = 3;

/** The age at which a Short's fate is mostly decided, and the age the alert
 * is aimed at: early enough to act on, late enough to mean something. */
const OUTLIER_AGE_HOURS = 6;

/** A video younger than this has no reading worth judging. */
const MIN_OUTLIER_AGE_HOURS = 1;

const PLATFORMS = ["youtube_shorts", "instagram_reels"] as const;

type Row = {
  videoDraftId: number;
  videoTargetId: number;
  target: string;
  label: string | null;
  game: string | null;
  publishedAt: string;
  views: number;
  sampledAt: string;
};

/**
 * What changed since last week, in the order someone would want to hear it.
 *
 * Deliberately not the whole report: this answers "is there anything I should
 * know" for someone who did not ask a question, so it carries the week's shape,
 * the videos that broke out of it, and what is running hot right now.
 */
export function videoDigest(backendDb: BackendDb, options: { days: number; timeZone: string }): Record<string, unknown> {
  const now = new Date();
  const thisWindow = window(backendDb, options.days, now);
  const previousWindow = window(backendDb, options.days, new Date(now.getTime() - options.days * 86_400_000));
  return {
    window: { days: options.days, to: now.toISOString(), timeZone: options.timeZone },
    platforms: Object.fromEntries(
      PLATFORMS.map((platform) => {
        const current = thisWindow.filter((row) => row.target === platform);
        const previous = previousWindow.filter((row) => row.target === platform);
        const currentViews = current.reduce((sum, row) => sum + row.views, 0);
        const previousViews = previous.reduce((sum, row) => sum + row.views, 0);
        return [
          platform,
          {
            videos: current.length,
            views: currentViews,
            medianViews: median(current.map((row) => row.views)),
            previous: { videos: previous.length, views: previousViews },
            viewsChangePercent: previousViews ? Math.round(((currentViews - previousViews) / previousViews) * 1000) / 10 : null,
          },
        ];
      }),
    ),
    best: PLATFORMS.flatMap((platform) =>
      [...thisWindow.filter((row) => row.target === platform)]
        .sort((left, right) => right.views - left.views)
        .slice(0, 3)
        .map((row) => ({ ref: `video:${row.videoDraftId}`, platform, label: row.label, game: row.game, views: row.views })),
    ),
    breakingOut: outliers(backendDb, now),
    reading: [
      "Two windows of equal length, back to back: the comparison is week against week, not week against everything.",
      "`breakingOut` is about videos published in the last two days, judged against the median of the window at the same age — it is a signal to act on today, not a conclusion.",
      "A digest is a summary, not evidence: for a decision, read `video-report`, where every figure carries its sample size.",
    ],
  };
}

/**
 * Videos running far above the median for their age, right now.
 *
 * A video is compared with what a typical video of this Studio had at the same
 * number of hours old, so a hit is visible on the day it happens instead of a
 * week later when the totals are in.
 */
export function outliers(backendDb: BackendDb, now = new Date()): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const platform of PLATFORMS) {
    const baseline = median(readingsAtAge(backendDb, platform, OUTLIER_AGE_HOURS, 90).map((row) => row.views));
    if (!baseline) continue;
    for (const row of youngVideos(backendDb, platform, now)) {
      const ageHours = (now.getTime() - new Date(row.publishedAt).getTime()) / 3_600_000;
      if (ageHours < MIN_OUTLIER_AGE_HOURS) continue;
      // Compare like with like: a two-hour-old video is judged against what the
      // median video had at two hours, not against the six-hour baseline.
      const reference = median(readingsAtAge(backendDb, platform, ageHours, 90).map((entry) => entry.views)) || baseline;
      if (row.views < reference * OUTLIER_MULTIPLE) continue;
      found.push({
        ref: `video:${row.videoDraftId}`,
        platform,
        label: row.label,
        game: row.game,
        publishedAt: row.publishedAt,
        ageHours: Math.round(ageHours * 10) / 10,
        views: row.views,
        typicalAtThisAge: reference,
        times: Math.round((row.views / reference) * 10) / 10,
      });
    }
  }
  return found.sort((left, right) => Number(right.times) - Number(left.times));
}

/** Published videos in a window, with their latest reading. */
function window(backendDb: BackendDb, days: number, to: Date): Row[] {
  const from = new Date(to.getTime() - days * 86_400_000).toISOString();
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT t.video_draft_id AS videoDraftId, t.id AS videoTargetId, t.target AS target, d.label AS label, d.game AS game,
              t.published_at AS publishedAt, s.sampled_at AS sampledAt,
              CAST(COALESCE(json_extract(s.metrics_json, '$.views'), 0) AS INTEGER) AS views
         FROM video_targets t
         JOIN video_drafts d ON d.id = t.video_draft_id
         LEFT JOIN video_metric_snapshots s ON s.id = (SELECT MAX(id) FROM video_metric_snapshots WHERE video_target_id = t.id)
        WHERE t.status = 'published' AND t.published_at >= ? AND t.published_at < ?`,
    )
    .all(from, to.toISOString()) as Row[];
}

/** Videos published in the last two days, with the reading taken most recently. */
function youngVideos(backendDb: BackendDb, platform: string, now: Date): Row[] {
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT t.video_draft_id AS videoDraftId, t.id AS videoTargetId, t.target AS target, d.label AS label, d.game AS game,
              t.published_at AS publishedAt, s.sampled_at AS sampledAt,
              CAST(COALESCE(json_extract(s.metrics_json, '$.views'), 0) AS INTEGER) AS views
         FROM video_targets t
         JOIN video_drafts d ON d.id = t.video_draft_id
         JOIN video_metric_snapshots s ON s.id = (SELECT MAX(id) FROM video_metric_snapshots WHERE video_target_id = t.id)
        WHERE t.status = 'published' AND t.target = ? AND t.published_at >= ?`,
    )
    .all(platform, new Date(now.getTime() - 2 * 86_400_000).toISOString()) as Row[];
}

/** What videos of this platform had when they were this old, taken from the
 * reading closest to that age. */
function readingsAtAge(backendDb: BackendDb, platform: string, ageHours: number, days: number): Array<{ views: number }> {
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT CAST(COALESCE(json_extract(s.metrics_json, '$.views'), 0) AS INTEGER) AS views
         FROM video_targets t
         JOIN video_metric_snapshots s ON s.id = (
           SELECT id FROM video_metric_snapshots
            WHERE video_target_id = t.id
              AND (julianday(sampled_at) - julianday(t.published_at)) * 24 <= ?
            ORDER BY sampled_at DESC LIMIT 1)
        WHERE t.status = 'published' AND t.target = ?
          AND t.published_at >= date('now', ?)
          AND t.published_at <= datetime('now', ?)`,
    )
    .all(ageHours, platform, `-${days} days`, `-${Math.ceil(ageHours)} hours`) as Array<{ views: number }>;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return Math.round(metricNumber(value));
}
