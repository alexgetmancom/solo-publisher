import { analyticsDataVersion } from "../../../analytics/data-version.js";
import { audienceGrowthByPlatform } from "../../../analytics/metric-deltas.js";
import {
  calendarDays,
  type DailyReach,
  dailyReach,
  emptyDailyReach,
  latestAtOrBefore,
  type PeriodDay,
  periodReach,
} from "../../../analytics/reach/daily-reach.js";
import { metricNumber } from "../../../analytics/snapshots/creator-store.js";
import { publicationRef } from "../../../application/publication-ref.js";
import { videoDestinations } from "../../../channels/destinations.js";
import { type BackendDb, unsafeDb } from "../../../db/client.js";
import { creatorProfiles } from "../../../db/schema.js";
import { isCurrentCalendarDay } from "../../../foundation/time.js";
import {
  VIDEO_TARGETS,
  type VideoDestination,
  type VideoLocale,
  videoDestination,
  videoTargetLabel,
} from "../../../publishing/video-types.js";
import { periodSubscriberDelta, type VideoSnapshot, videoReachSeries } from "./video-overview-calendar.js";

/**
 * Read model behind the video half of the unified overview.
 *
 * The Video tab reads the same tables per draft, one row per (draft, target).
 * This module answers a different question — "what did video do in this
 * period" — in the vocabulary the text side already speaks: totals, per
 * platform figures, content rows, and raw view samples for the chart. Keeping
 * that translation here is what lets combined-section.ts stay unaware of
 * video_targets and of the fact that a video "reaction" is a like and a video
 * "reply" is a comment.
 */

/** One published clip, wherever it went. The unit is the draft, exactly as the
 * text side's unit is the post: one clip on YouTube and on Reels is one row
 * carrying two destinations, not two rows. */
export type VideoContentItem = {
  key: string;
  /** Every destination this clip reached, largest first. */
  destinations: VideoItemDestination[];
  title: string;
  /** The best-performing destination's permalink. */
  url: string | null;
  publishedAt: string | null;
  /** Views gained during the selected period, not the current lifetime total. */
  views: number;
  reactions: number;
  replies: number;
  /** Current lifetime views which arrived after the selected period ended. */
  afterPeriodViews: number;
  lifetimeViews: number;
  /** Net subscribers/follows attributed to this publication during the period. */
  subscribers: number | null;
};

type VideoItemDestination = {
  target: string;
  label: string;
  locale: string | null;
  providerAccountId: string | null;
  url: string | null;
  views: number;
  reactions: number;
  replies: number;
};

/**
 * One row of the platform panel: a destination, not a platform.
 *
 * `locale` is declared by the channel registry rather than inferred from the
 * clips of this period — a Russian channel is Russian on a week it published
 * nothing — and `followers` come from that destination's own profile key, so
 * the RU and EN channels stop sharing one legacy count.
 */
type VideoPlatformTotal = {
  target: string;
  label: string;
  locales: string[];
  views: number;
  followers: number | null;
};

/** A raw metric observation, before it is folded into a cumulative curve. */
type MetricEvent = { at: Date; key: string; value: number };

type VideoSummaryMetrics = {
  /** A provider-native completion percentage, when a collector supplies one. */
  completionRate: number | null;
  /** Weighted average watch duration across the available video sources. */
  averageWatchTimeMs: number | null;
  /** Net subscribers/follows attributed to the selected video period. */
  subscribers: number | null;
};

export type VideoOverview = {
  items: VideoContentItem[];
  totals: { views: number; reactions: number; replies: number; posts: number };
  summary: VideoSummaryMetrics;
  platforms: VideoPlatformTotal[];
  /** Period increments keyed by the studio calendar date. */
  dailyByDay: Record<string, DailyVideoMetrics>;
  viewEvents: MetricEvent[];
};

/** Request-scoped cache shared by the period comparisons on one dashboard. */
export type VideoOverviewCache = {
  rangeStart: Date | null;
  rangeEnd: Date | null;
  sampleBucketSeconds: number;
  bundleKey: string | null;
  bundle: VideoAnalyticsBundle | null;
  audienceGrowth: Map<string, Map<string, number>>;
  audienceGrowthByDay: Map<string, Map<string, Map<string, number>>>;
  profileSummaries: Map<string, ProfileSummaryMetrics>;
};

export function createVideoOverviewCache(sampleBucketSeconds = 60 * 60): VideoOverviewCache {
  return {
    rangeStart: null,
    rangeEnd: null,
    sampleBucketSeconds,
    bundleKey: null,
    bundle: null,
    audienceGrowth: new Map(),
    audienceGrowthByDay: new Map(),
    profileSummaries: new Map(),
  };
}

/** Sets the one bounded history window shared by all period comparisons in a render. */
export function setVideoOverviewCacheRange(cache: VideoOverviewCache, start: Date, end: Date, sampleBucketSeconds?: number): void {
  if (
    cache.rangeStart?.getTime() !== start.getTime() ||
    cache.rangeEnd?.getTime() !== end.getTime() ||
    (sampleBucketSeconds !== undefined && cache.sampleBucketSeconds !== sampleBucketSeconds)
  ) {
    cache.bundleKey = null;
    cache.bundle = null;
    cache.audienceGrowth.clear();
    cache.audienceGrowthByDay.clear();
    cache.profileSummaries.clear();
  }
  cache.rangeStart = start;
  cache.rangeEnd = end;
  if (sampleBucketSeconds !== undefined) cache.sampleBucketSeconds = sampleBucketSeconds;
}

export type TargetRow = {
  id: number;
  videoDraftId: number;
  target: string;
  providerAccountId: string | null;
  label: string;
  locale: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  metadataJson: string | null;
};

/**
 * `views` is the reach the whole catalogue gained on that calendar day;
 * `freshViews` is the part of it produced by clips published that same day.
 * The two are a partition of one number, never two populations added together —
 * drawing a clip's later growth on the day it was published would count the
 * same view twice, once on its publication day and once on the day it happened.
 */
type DailyVideoMetrics = DailyReach & { subscribers: number | null };
type VideoAnalyticsBundle = {
  catalogue: readonly VideoDestination[];
  rows: TargetRow[];
  snapshots: Map<number, VideoSnapshot[]>;
  historicalDestinations: Set<string>;
  followers: Map<string, number>;
  /** The window the snapshots were loaded over; everything derived is cut from it. */
  range: { start: Date; end: Date };
  /** Everything derived from the snapshots above, filled on first use and
   * carried with them: a day's reach and a day's subscriber delta are functions
   * of this bundle and the time zone, so a second render over the same range
   * must not pay for them again. */
  derived: {
    timeZone: string;
    days: PeriodDay[];
    dayKeys: Set<string>;
    dailyReachByRow: Map<number, Record<string, DailyReach>>;
    subscriberDeltaByRow: Map<number, Map<string, number | null>>;
  } | null;
};

const MAX_SHARED_VIDEO_BUNDLES = 6;
const sharedVideoBundles = new WeakMap<BackendDb, Map<string, VideoAnalyticsBundle>>();

export function emptyVideoOverview(): VideoOverview {
  return {
    items: [],
    totals: { views: 0, reactions: 0, replies: 0, posts: 0 },
    summary: { completionRate: null, averageWatchTimeMs: null, subscribers: null },
    platforms: [],
    dailyByDay: {},
    viewEvents: [],
  };
}
export function videoAnalyticsBundle(backendDb: BackendDb, start: Date, end: Date, cache?: VideoOverviewCache): VideoAnalyticsBundle {
  const rangeStart = cache?.rangeStart ?? start;
  const rangeEnd = cache?.rangeEnd ?? end;
  const bucketSeconds = cache?.sampleBucketSeconds ?? (end.getTime() - start.getTime() > 7 * 86_400_000 ? 86_400 : 3_600);
  const key = `${rangeStart.toISOString()}|${rangeEnd.toISOString()}|${bucketSeconds}|${analyticsDataVersion(backendDb)}`;
  if (cache?.bundleKey === key && cache.bundle) return cache.bundle;

  const shared = sharedVideoBundles.get(backendDb);
  const sharedEntry = shared?.get(key);
  if (sharedEntry) {
    if (cache) {
      cache.bundleKey = key;
      cache.bundle = sharedEntry;
    }
    return sharedEntry;
  }

  const catalogue = videoDestinations(backendDb);
  const rows = publishedTargets(backendDb, rangeStart.toISOString(), rangeEnd.toISOString());
  fillMissingVideoUrls(backendDb, rows);
  const snapshots = videoSnapshots(backendDb, rows, rangeStart, rangeEnd, bucketSeconds);
  const bundle: VideoAnalyticsBundle = {
    catalogue,
    rows,
    snapshots,
    historicalDestinations: publishedDestinationKeys(backendDb, catalogue),
    followers: followerCounts(backendDb),
    range: { start: rangeStart, end: rangeEnd },
    derived: null,
  };

  const entries = shared ?? new Map<string, VideoAnalyticsBundle>();
  entries.set(key, bundle);
  while (entries.size > MAX_SHARED_VIDEO_BUNDLES) {
    const oldest = entries.keys().next().value;
    if (typeof oldest !== "string") break;
    entries.delete(oldest);
  }
  sharedVideoBundles.set(backendDb, entries);
  if (cache) {
    cache.bundleKey = key;
    cache.bundle = bundle;
  }
  return bundle;
}

/**
 * What each clip earned in one window, cut from history rather than recomputed.
 *
 * A render asks five windows of the same clips -- the period, the history
 * behind it, the previous period, yesterday and the 30-day median. Measured in
 * production, the whole window breaks down into thirds: loading the bundle,
 * this pass, and the per-clip totals. Each was being paid per window; each is a
 * function of the bundle and the time zone alone, so each is paid once and
 * sliced. This is the shape the text half already uses, where `pipelineForDates`
 * slices one preloaded history the same way.
 *
 * A day's figures do not depend on which other days were asked for: every
 * interval between two readings is normalised by its own span before being
 * spread, and a subscriber delta is bounded by the day it falls in.
 */
export function periodReachByRow(
  bundle: VideoAnalyticsBundle,
  rows: readonly TargetRow[],
  snapshots: ReadonlyMap<number, VideoSnapshot[]>,
  days: readonly PeriodDay[],
  timeZone: string,
): Map<number, DailyReach> {
  const derived = derivedHistory(bundle, rows, snapshots, timeZone);
  const totals = new Map<number, DailyReach>();
  // Every window a render asks for is cut from the same union the bundle was
  // loaded over, so this holds. It is checked rather than assumed because the
  // failure is silent: an uncovered day reads as a day that earned nothing.
  const covered = days.every((day) => derived.dayKeys.has(day.key));
  for (const row of rows) {
    if (!covered) {
      totals.set(row.id, periodReach(videoReachSeries(row.publishedAt, row.target, snapshots.get(row.id) ?? []), days, timeZone));
      continue;
    }
    const daily = derived.dailyReachByRow.get(row.id);
    const total = emptyDailyReach();
    for (const day of days) {
      const bucket = daily?.[day.key];
      if (!bucket) continue;
      total.views += bucket.views;
      total.freshViews += bucket.freshViews;
      total.reactions += bucket.reactions;
      total.replies += bucket.replies;
      total.reposts += bucket.reposts;
    }
    totals.set(row.id, total);
  }
  return totals;
}

/**
 * What each clip's audience did in one window, cut from the same history.
 *
 * This was the last per-window recompute and the largest one left: production
 * spent 503 ms of a 624 ms window here at two years, walking every clip against
 * every day of the window. A day's delta is bounded by that day, so the days
 * sum.
 */
export function periodSubscribersByRow(
  bundle: VideoAnalyticsBundle,
  rows: readonly TargetRow[],
  snapshots: ReadonlyMap<number, VideoSnapshot[]>,
  days: readonly PeriodDay[],
  timeZone: string,
): Map<number, number | null> {
  const derived = derivedHistory(bundle, rows, snapshots, timeZone);
  const covered = days.every((day) => derived.dayKeys.has(day.key));
  const totals = new Map<number, number | null>();
  for (const row of rows) {
    if (!covered) {
      totals.set(row.id, periodSubscriberDelta(snapshots.get(row.id) ?? [], [...days]));
      continue;
    }
    const byDay = derived.subscriberDeltaByRow.get(row.id);
    let total = 0;
    let observed = false;
    for (const day of days) {
      const delta = byDay?.get(day.key);
      if (delta === undefined || delta === null) continue;
      observed = true;
      total += delta;
    }
    totals.set(row.id, observed ? total : null);
  }
  return totals;
}

/** The chart's bars for one window, summed from the same history the per-clip
 * totals are cut from, so the two can no longer disagree by a rounding step. */
function dailyReachForWindow(
  bundle: VideoAnalyticsBundle,
  rows: readonly TargetRow[],
  snapshots: ReadonlyMap<number, VideoSnapshot[]>,
  days: readonly PeriodDay[],
  timeZone: string,
): Record<string, DailyReach> {
  const derived = derivedHistory(bundle, rows, snapshots, timeZone);
  const covered = days.every((day) => derived.dayKeys.has(day.key));
  if (!covered)
    return dailyReach(
      rows.map((row) => videoReachSeries(row.publishedAt, row.target, snapshots.get(row.id) ?? [])),
      days,
      timeZone,
    );
  const result: Record<string, DailyReach> = {};
  for (const day of days) result[day.key] = emptyDailyReach();
  for (const row of rows) {
    const daily = derived.dailyReachByRow.get(row.id);
    if (!daily) continue;
    for (const day of days) {
      const bucket = daily[day.key];
      const target = result[day.key];
      if (!bucket || !target) continue;
      target.views += bucket.views;
      target.freshViews += bucket.freshViews;
      target.reactions += bucket.reactions;
      target.replies += bucket.replies;
      target.reposts += bucket.reposts;
    }
  }
  return result;
}

/** One day-by-day pass per clip over the bundle's whole range, carried on the
 * bundle so a second render over the same range does not repeat it. */
function derivedHistory(
  bundle: VideoAnalyticsBundle,
  rows: readonly TargetRow[],
  snapshots: ReadonlyMap<number, VideoSnapshot[]>,
  timeZone: string,
): NonNullable<VideoAnalyticsBundle["derived"]> {
  if (!bundle.derived || bundle.derived.timeZone !== timeZone) {
    const days = calendarDays(bundle.range.start, bundle.range.end, timeZone);
    bundle.derived = {
      timeZone,
      days,
      dayKeys: new Set(days.map((day) => day.key)),
      dailyReachByRow: new Map(),
      subscriberDeltaByRow: new Map(),
    };
  }
  const derived = bundle.derived;
  for (const row of rows) {
    if (derived.dailyReachByRow.has(row.id)) continue;
    const history = snapshots.get(row.id) ?? [];
    derived.dailyReachByRow.set(row.id, dailyReach([videoReachSeries(row.publishedAt, row.target, history)], derived.days, timeZone));
    derived.subscriberDeltaByRow.set(row.id, subscriberDeltaByDay(history, derived.days));
  }
  return derived;
}

/** A day's subscriber movement, kept per day so any window can sum its own. */
function subscriberDeltaByDay(history: readonly VideoSnapshot[], days: readonly PeriodDay[]): Map<string, number | null> {
  const byDay = new Map<string, number | null>();
  for (const day of days) {
    const before = latestAtOrBefore(history, day.start)?.metrics;
    const atEnd = latestAtOrBefore(history, day.end)?.metrics ?? before;
    if (!before && !atEnd) {
      byDay.set(day.key, null);
      continue;
    }
    if ((before?.follows ?? null) === null && (atEnd?.follows ?? null) === null) {
      byDay.set(day.key, null);
      continue;
    }
    byDay.set(day.key, (atEnd?.follows ?? before?.follows ?? 0) - (before?.follows ?? 0));
  }
  return byDay;
}

function publishedTargets(backendDb: BackendDb, startIso: string, endIso: string): TargetRow[] {
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT t.id AS id, t.video_draft_id AS videoDraftId, t.target AS target, COALESCE(d.label, '') AS label, d.locale AS locale, t.published_at AS publishedAt,
              t.provider_account_id AS providerAccountId, t.external_url AS externalUrl, t.metadata_json AS metadataJson
         FROM video_targets t
         JOIN video_drafts d ON d.id = t.video_draft_id
        WHERE t.status = 'published' AND t.published_at IS NOT NULL AND t.published_at >= ? AND t.published_at <= ?
        ORDER BY t.published_at DESC`,
    )
    .all(startIso, endIso) as TargetRow[];
}

function fillMissingVideoUrls(backendDb: BackendDb, rows: TargetRow[]): void {
  const missingIds = rows.filter((row) => !row.externalUrl).map((row) => row.id);
  if (!missingIds.length) return;
  const placeholders = missingIds.map(() => "?").join(",");
  const snapshots = unsafeDb(backendDb)
    .sqlite.prepare(
      `WITH candidates AS (
         SELECT video_target_id AS videoTargetId,
                json_extract(metrics_json, '$.url') AS url,
                ROW_NUMBER() OVER (
                  PARTITION BY video_target_id
                  ORDER BY sampled_at DESC, id DESC
                ) AS rowNumber
           FROM video_metric_snapshots
          WHERE video_target_id IN (${placeholders})
            AND json_type(metrics_json, '$.url') = 'text'
            AND (json_extract(metrics_json, '$.url') LIKE 'http://%' OR json_extract(metrics_json, '$.url') LIKE 'https://%')
       )
       SELECT videoTargetId, url
         FROM candidates
        WHERE rowNumber = 1`,
    )
    .all(...missingIds) as Array<{ videoTargetId: number; url: unknown }>;
  const urls = new Map<number, string>();
  for (const snapshot of snapshots) {
    if (urls.has(snapshot.videoTargetId)) continue;
    const url = snapshotUrl(snapshot.url);
    if (url) urls.set(snapshot.videoTargetId, url);
  }
  for (const row of rows) row.externalUrl ??= urls.get(row.id) ?? null;
}

function snapshotUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : null;
}

function videoSnapshots(
  backendDb: BackendDb,
  rows: TargetRow[],
  start: Date,
  end: Date,
  bucketSeconds: number,
): Map<number, VideoSnapshot[]> {
  const snapshots = new Map<number, VideoSnapshot[]>();
  if (!rows.length) return snapshots;
  const bucketFactor = 86_400 / bucketSeconds;
  // The range is the only part that needs bucketing. Baseline and lifetime
  // latest are point lookups against (video_target_id, sampled_at); including
  // their entire pre-range history in a materialized CTE made a 30-day chart
  // pay for every old snapshot on every render.
  const samples = unsafeDb(backendDb)
    .sqlite.prepare(
      `WITH targetIds(targetId) AS (VALUES ${rows.map(() => "(?)").join(",")}),
         rangeSamples AS (
           SELECT sample.id, sample.video_target_id AS targetId, sample.sampled_at AS sampledAt,
                  CAST((julianday(sample.sampled_at) - julianday(?)) * ? AS INTEGER) AS bucket
             FROM video_metric_snapshots AS sample
               JOIN targetIds AS target ON target.targetId = sample.video_target_id
            WHERE sample.sampled_at >= ? AND sample.sampled_at <= ?
         ),
         rangeTimes AS (
           SELECT targetId, bucket, MAX(sampledAt) AS sampledAt
             FROM rangeSamples
            GROUP BY targetId, bucket
         ),
         rangeIds AS (
           SELECT MAX(candidate.id) AS id
             FROM rangeSamples AS candidate
             JOIN rangeTimes AS range
               ON range.targetId = candidate.targetId
              AND range.bucket = candidate.bucket
              AND range.sampledAt = candidate.sampledAt
            GROUP BY range.targetId, range.bucket
         ),
         baselineIds AS (
           SELECT (
             SELECT sample.id
               FROM video_metric_snapshots AS sample
              WHERE sample.video_target_id = target.targetId AND sample.sampled_at < ?
              ORDER BY sample.sampled_at DESC, sample.id DESC
              LIMIT 1
           ) AS id
             FROM targetIds AS target
         ),
         latestIds AS (
           SELECT (
             SELECT sample.id
               FROM video_metric_snapshots AS sample
              WHERE sample.video_target_id = target.targetId
              ORDER BY sample.sampled_at DESC, sample.id DESC
              LIMIT 1
           ) AS id
             FROM targetIds AS target
         ),
         wanted AS (
           SELECT id FROM rangeIds WHERE id IS NOT NULL
           UNION SELECT id FROM baselineIds WHERE id IS NOT NULL
           UNION SELECT id FROM latestIds WHERE id IS NOT NULL
         )
         SELECT video_target_id AS targetId,
                sampled_at AS sampledAt,
                CAST(COALESCE(json_extract(metrics_json, '$.views'), 0) AS REAL) AS views,
                CAST(COALESCE(json_extract(metrics_json, '$.likes'), 0) AS REAL) AS likes,
                CAST(COALESCE(json_extract(metrics_json, '$.comments'), 0) AS REAL) AS comments,
                COALESCE(json_extract(metrics_json, '$.averageWatchTimeMs'), json_extract(metrics_json, '$.averageWatchTime')) AS averageWatchTimeMs,
                COALESCE(json_extract(metrics_json, '$.totalWatchTimeMs'), json_extract(metrics_json, '$.totalWatchTime')) AS totalWatchTimeMs,
                COALESCE(json_extract(metrics_json, '$.follows'), json_extract(metrics_json, '$.subscribersGained')) AS follows,
                COALESCE(json_extract(metrics_json, '$.completionRate'), json_extract(metrics_json, '$.completion_rate'), json_extract(metrics_json, '$.completionPercentage'), json_extract(metrics_json, '$.completion_percentage')) AS completionRate,
                COALESCE(json_extract(metrics_json, '$.videoDurationMs'), json_extract(metrics_json, '$.durationMs')) AS videoDurationMs
           FROM video_metric_snapshots AS sample
          WHERE id IN (SELECT id FROM wanted)
          ORDER BY targetId ASC, sampledAt ASC, id ASC`,
    )
    .all(
      ...rows.map((row) => row.id),
      start.toISOString(),
      bucketFactor,
      start.toISOString(),
      end.toISOString(),
      start.toISOString(),
    ) as Array<{
    targetId: number;
    sampledAt: string;
    views: number;
    likes: number;
    comments: number;
    averageWatchTimeMs: unknown;
    totalWatchTimeMs: unknown;
    follows: unknown;
    completionRate: unknown;
    videoDurationMs: unknown;
  }>;
  for (const sample of samples) {
    const at = new Date(sample.sampledAt);
    if (Number.isNaN(at.getTime())) continue;
    const list = snapshots.get(sample.targetId) ?? [];
    list.push({
      at,
      metrics: {
        views: metricNumber(sample.views),
        likes: metricNumber(sample.likes),
        comments: metricNumber(sample.comments),
        averageWatchTimeMs: optionalMetric(sample.averageWatchTimeMs),
        totalWatchTimeMs: optionalMetric(sample.totalWatchTimeMs),
        follows: optionalMetric(sample.follows),
        completionRate: optionalMetric(sample.completionRate),
        videoDurationMs: optionalMetric(sample.videoDurationMs),
      },
    });
    snapshots.set(sample.targetId, list);
  }
  for (const row of rows) {
    const history = snapshots.get(row.id) ?? [];
    snapshots.set(row.id, history);
  }
  return snapshots;
}

function publishedDestinationKeys(backendDb: BackendDb, catalogue: readonly VideoDestination[]): Set<string> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT t.target AS target, d.locale AS locale
         FROM video_targets t
         JOIN video_drafts d ON d.id = t.video_draft_id
        WHERE t.status = 'published'`,
    )
    .all() as Array<{ target: string; locale: string | null }>;
  return new Set(
    rows
      .map((row) => destinationFor(catalogue, row))
      .filter((destination): destination is VideoDestination => destination !== null)
      .map(destinationKey),
  );
}

/** Samples for the clips of this period, converted to cumulative period deltas. */
/**
 * The chart's raw points for one window.
 *
 * Five windows per render allocated one object per snapshot in range and sorted
 * the result each time -- the same shape as every other per-window pass that has
 * come out of this file. The snapshots of one clip are already sorted, so a
 * window is a slice of them found by binary search, and the per-clip slices are
 * merged rather than concatenated and re-sorted.
 */
export function viewEvents(rows: TargetRow[], snapshots: Map<number, VideoSnapshot[]>, start: Date, end: Date): MetricEvent[] {
  if (!rows.length) return [];
  const perRow: MetricEvent[][] = [];
  for (const row of rows) {
    const history = snapshots.get(row.id) ?? [];
    if (!history.length) continue;
    const baseline = latestAtOrBefore(history, start)?.metrics.views ?? 0;
    // latestAtOrBefore lands on the last sample at or before `start`; the window
    // opens at the one after it.
    const before = latestAtOrBefore(history, new Date(start.getTime() - 1));
    let index = before ? history.indexOf(before) + 1 : 0;
    const events: MetricEvent[] = [];
    for (; index < history.length; index += 1) {
      const sample = history[index];
      if (!sample || sample.at > end) break;
      events.push({ at: sample.at, key: publicationRef("video", row.id), value: Math.max(0, sample.metrics.views - baseline) });
    }
    if (events.length) perRow.push(events);
  }
  return mergeByTime(perRow);
}

/** Merges lists that are each already in time order. */
function mergeByTime(lists: MetricEvent[][]): MetricEvent[] {
  if (lists.length <= 1) return lists[0] ?? [];
  const cursors = lists.map(() => 0);
  const merged: MetricEvent[] = [];
  for (;;) {
    let pick = -1;
    let pickAt = Number.POSITIVE_INFINITY;
    for (let list = 0; list < lists.length; list += 1) {
      const event = lists[list]?.[cursors[list] ?? 0];
      if (!event) continue;
      const at = event.at.getTime();
      if (at < pickAt) {
        pickAt = at;
        pick = list;
      }
    }
    if (pick < 0) return merged;
    const list = lists[pick];
    const cursor = cursors[pick] ?? 0;
    const event = list?.[cursor];
    if (!event) return merged;
    merged.push(event);
    cursors[pick] = cursor + 1;
  }
}

export function aggregateDailyMetrics(
  backendDb: BackendDb,
  bundle: VideoAnalyticsBundle,
  rows: TargetRow[],
  snapshots: Map<number, VideoSnapshot[]>,
  days: PeriodDay[],
  timeZone: string,
  cache: VideoOverviewCache,
): Record<string, DailyVideoMetrics> {
  const daily = dailyReachForWindow(bundle, rows, snapshots, days, timeZone);
  const result: Record<string, DailyVideoMetrics> = {};
  for (const day of days) result[day.key] = { ...(daily[day.key] ?? emptyDailyReach()), subscribers: null };
  const profileKeys = new Set(rows.map(profileKeyForRow).filter((key): key is string => key !== null));
  const growthKey = `${days.map((day) => `${day.start.toISOString()}|${day.end.toISOString()}`).join(",")}|${[...profileKeys].sort().join(",")}`;
  const growthByDay = cache.audienceGrowthByDay.get(growthKey) ?? audienceGrowthByDay(backendDb, days, profileKeys);
  cache.audienceGrowthByDay.set(growthKey, growthByDay);
  for (const day of days) {
    const growth = growthByDay.get(day.key);
    const values = [...profileKeys].filter((key) => growth?.has(key)).map((key) => growth?.get(key) ?? 0);
    const bucket = result[day.key];
    if (bucket) bucket.subscribers = values.length ? values.reduce((total, value) => total + value, 0) : null;
  }
  return result;
}

/** Loads audience history once for the whole chart instead of rerunning the
 * same window query once per calendar day. */
function audienceGrowthByDay(backendDb: BackendDb, days: PeriodDay[], profileKeys: Set<string>): Map<string, Map<string, number>> {
  const lastDay = days.at(-1);
  if (!days.length || !lastDay || profileKeys.size === 0) return new Map();

  const platformNames = [...profileKeys];
  const placeholders = platformNames.map(() => "?").join(",");
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT platform, account, sampled_at AS sampledAt,
              CAST(COALESCE(json_extract(metrics_json, '$.subscriberCount'), json_extract(metrics_json, '$.followersCount'), 0) AS INTEGER) AS value
         FROM creator_profile_snapshots
        WHERE platform IN (${placeholders}) AND sampled_at <= ?
        ORDER BY platform ASC, account ASC, sampled_at ASC, id ASC`,
    )
    .all(...platformNames, lastDay.end.toISOString()) as Array<{
    platform: string;
    account: string;
    sampledAt: string;
    value: number;
  }>;
  const histories = new Map<string, Array<{ sampledAt: string; value: number }>>();
  for (const row of rows) {
    const key = `${row.platform}\u0000${row.account}`;
    const history = histories.get(key) ?? [];
    history.push({ sampledAt: row.sampledAt, value: row.value });
    histories.set(key, history);
  }

  const totals = new Map<string, Map<string, number>>();
  for (const [accountKey, history] of histories) {
    const separator = accountKey.indexOf("\u0000");
    const platform = separator < 0 ? accountKey : accountKey.slice(0, separator);
    let cursor = 0;
    let baseline: { sampledAt: string; value: number } | undefined;
    for (const day of days) {
      while (cursor < history.length && (history[cursor]?.sampledAt ?? "") <= day.start.toISOString()) {
        baseline = history[cursor];
        cursor += 1;
      }
      let current = baseline;
      while (cursor < history.length && (history[cursor]?.sampledAt ?? "") <= day.end.toISOString()) {
        current = history[cursor];
        cursor += 1;
      }
      if (!baseline || !current) continue;
      const dayTotals = totals.get(day.key) ?? new Map<string, number>();
      dayTotals.set(platform, (dayTotals.get(platform) ?? 0) + current.value - baseline.value);
      totals.set(day.key, dayTotals);
    }
  }
  return totals;
}

function followerCounts(backendDb: BackendDb): Map<string, number> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT platform,
              CAST(COALESCE(json_extract(metrics_json, '$.subscriberCount'), json_extract(metrics_json, '$.followersCount'), 0) AS INTEGER) AS value
         FROM creator_profile_snapshots
        WHERE id IN (SELECT MAX(id) FROM creator_profile_snapshots GROUP BY platform, account)`,
    )
    .all() as Array<{ platform: string; value: number }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    // Snapshots exist per (platform, account); the overview panel is per
    // platform, so the accounts publishing through one platform are summed.
    counts.set(row.platform, (counts.get(row.platform) ?? 0) + metricNumber(row.value));
  }
  return counts;
}

export function destinationFor(
  catalogue: readonly VideoDestination[],
  row: { target: string; locale: string | null },
): VideoDestination | null {
  const locale = videoLocale(row.locale);
  return locale ? videoDestination(catalogue, row.target, locale) : null;
}

export function destinationKey(destination: VideoDestination): string {
  return `${destination.target}:${destination.locale}`;
}

function videoLocale(value: string | null): VideoLocale | null {
  return value === "ru" || value === "en" ? value : null;
}

export function videoSummaryMetrics(
  backendDb: BackendDb,
  rows: TargetRow[],
  snapshots: Map<number, VideoSnapshot[]>,
  periodTotals: ReadonlyMap<number, DailyReach>,
  periodDays: PeriodDay[],
  end: Date,
  timeZone: string,
  cache?: VideoOverviewCache,
): VideoSummaryMetrics {
  const watchSamples: Array<{ value: number; weight: number }> = [];
  const completionSamples: Array<{ value: number; weight: number }> = [];
  let attributedSubscribers = 0;
  let hasAttributedSubscribers = false;

  for (const row of rows) {
    const history = snapshots.get(row.id) ?? [];
    const latest = latestAtOrBefore(history, end)?.metrics;
    if (!latest) continue;
    const weight = Math.max(1, periodTotals.get(row.id)?.views || latest.views);
    if (latest.averageWatchTimeMs !== null && latest.averageWatchTimeMs > 0)
      watchSamples.push({ value: latest.averageWatchTimeMs, weight });
    if (latest.completionRate !== null && latest.completionRate >= 0) completionSamples.push({ value: latest.completionRate, weight });
    const durationMs = latest.videoDurationMs !== null && latest.videoDurationMs > 0 ? latest.videoDurationMs : targetDurationMs(row);
    if (latest.totalWatchTimeMs !== null && latest.views > 0 && durationMs !== null && durationMs > 0) {
      completionSamples.push({
        value: Math.min(100, (latest.totalWatchTimeMs / (latest.views * durationMs)) * 100),
        weight,
      });
    }
  }

  // Account reports are the fallback for subscriber attribution. They are only
  // valid for the current calendar day; reusing today's 1d/7d report for a
  // historical dashboard window would make an old date move when the account
  // sync runs again.
  const reportDays = reportPeriodDays(periodDays.length);
  let profileSubscribers = 0;
  let hasProfileSubscribers = false;
  let accountProfileKeys = new Set<string>();
  if (isCurrentCalendarDay(end, timeZone) && reportDays !== null) {
    const profileKey = `${reportDays}|${[...new Set(rows.map(profileKeyForRow).filter((key): key is string => key !== null))].sort().join(",")}`;
    const profileMetrics = cache?.profileSummaries.get(profileKey) ?? profileSummaryMetrics(backendDb, rows, reportDays);
    cache?.profileSummaries.set(profileKey, profileMetrics);
    if (profileMetrics.averageWatchTimeMs !== null)
      watchSamples.push({ value: profileMetrics.averageWatchTimeMs, weight: Math.max(1, profileMetrics.views) });
    if (profileMetrics.completionRate !== null)
      completionSamples.push({ value: profileMetrics.completionRate, weight: Math.max(1, profileMetrics.views) });
    profileSubscribers = profileMetrics.subscribers;
    hasProfileSubscribers = profileMetrics.hasSubscribers;
    accountProfileKeys = profileMetrics.accountProfileKeys;
  }

  const audienceDays = reportDays ?? periodDays.length;
  const audienceStart = periodDays[0]?.start.toISOString() ?? end.toISOString();
  const useCurrentProviderReports = isCurrentCalendarDay(end, timeZone) && reportDays !== null;
  const audienceKey = `${audienceStart}|${audienceDays}|${end.toISOString()}|${useCurrentProviderReports ? "provider" : "history"}`;
  const audienceGrowth =
    cache?.audienceGrowth.get(audienceKey) ??
    audienceGrowthByPlatform(backendDb, audienceStart, audienceDays, end.toISOString(), useCurrentProviderReports);
  cache?.audienceGrowth.set(audienceKey, audienceGrowth);
  for (const row of rows) {
    const profileKey = profileKeyForRow(row);
    if (profileKey === null || accountProfileKeys.has(profileKey) || !audienceGrowth.has(profileKey)) continue;
    profileSubscribers += audienceGrowth.get(profileKey) ?? 0;
    hasProfileSubscribers = true;
    accountProfileKeys.add(profileKey);
  }

  // Do not add a per-video number for a channel whose account report already
  // covers it — that would double-count the same subscriber change.
  for (const row of rows) {
    const profileKey = profileKeyForRow(row);
    if (profileKey !== null && accountProfileKeys.has(profileKey)) continue;
    const latest = latestAtOrBefore(snapshots.get(row.id) ?? [], end)?.metrics;
    if (latest?.follows !== null && latest?.follows !== undefined && latest.follows !== 0) {
      attributedSubscribers += latest.follows;
      hasAttributedSubscribers = true;
    }
  }

  return {
    completionRate: weightedAverage(completionSamples),
    averageWatchTimeMs: weightedAverage(watchSamples),
    subscribers: hasProfileSubscribers || hasAttributedSubscribers ? profileSubscribers + attributedSubscribers : null,
  };
}

function reportPeriodDays(days: number): 1 | 7 | 30 | null {
  return days === 1 || days === 7 || days === 30 ? days : null;
}

type ProfileSummaryMetrics = {
  averageWatchTimeMs: number | null;
  completionRate: number | null;
  subscribers: number;
  hasSubscribers: boolean;
  accountProfileKeys: Set<string>;
  views: number;
};

function profileSummaryMetrics(backendDb: BackendDb, rows: TargetRow[], days: number): ProfileSummaryMetrics {
  const reportDays = days === 1 ? 1 : days === 7 ? 7 : 30;
  const suffix = reportDays === 30 ? "" : `${reportDays}d`;
  const accountKeys = new Set(rows.map(profileKeyForRow).filter((key): key is string => key !== null));
  let averageWatchTotal = 0;
  let averageWatchWeight = 0;
  let completionTotal = 0;
  let completionWeight = 0;
  let subscribers = 0;
  let hasSubscribers = false;
  let views = 0;
  const accountProfileKeys = new Set<string>();
  for (const profile of unsafeDb(backendDb).db.select().from(creatorProfiles).all()) {
    if (!accountKeys.has(profile.platform)) continue;
    const data = profile.dataJson as Record<string, unknown>;
    const periodViews = optionalMetric(data[`views${suffix}`] ?? data.views ?? data.viewCount) ?? 0;
    if (profile.platform.startsWith("youtube")) {
      const gained = optionalMetric(data[`subscribersGained${suffix}`] ?? data.subscribersGained);
      const lost = optionalMetric(data[`subscribersLost${suffix}`] ?? data.subscribersLost);
      const reportHasData = periodViews > 0 || (gained !== null && gained !== 0) || (lost !== null && lost !== 0);
      if (!reportHasData) continue;
      const averageViewDuration = optionalMetric(data[`averageViewDuration${suffix}`] ?? data.averageViewDuration);
      if (averageViewDuration !== null && averageViewDuration > 0) {
        const weight = Math.max(1, periodViews);
        averageWatchTotal += averageViewDuration * 1_000 * weight;
        averageWatchWeight += weight;
      }
      const averageViewPercentage = optionalMetric(data[`averageViewPercentage${suffix}`] ?? data.averageViewPercentage);
      if (averageViewPercentage !== null && averageViewPercentage >= 0) {
        const weight = Math.max(1, periodViews);
        completionTotal += averageViewPercentage * weight;
        completionWeight += weight;
      }
      if (gained !== null || lost !== null) {
        subscribers += (gained ?? 0) - (lost ?? 0);
        hasSubscribers = true;
        accountProfileKeys.add(profile.platform);
      }
    } else if (profile.platform.startsWith("instagram")) {
      const gained = optionalMetric(data.followersGained30d ?? data.followersGained);
      const lost = optionalMetric(data.followersLost30d ?? data.followersLost);
      if (reportDays !== 30 || (gained === null && lost === null)) continue;
      subscribers += (gained ?? 0) - (lost ?? 0);
      hasSubscribers = true;
      accountProfileKeys.add(profile.platform);
    }
    views += periodViews;
  }
  return {
    averageWatchTimeMs: averageWatchWeight > 0 ? averageWatchTotal / averageWatchWeight : null,
    completionRate: completionWeight > 0 ? completionTotal / completionWeight : null,
    subscribers,
    hasSubscribers,
    accountProfileKeys,
    views,
  };
}

function profileKeyForRow(row: TargetRow): string | null {
  if (row.target !== "youtube_shorts" && row.target !== "instagram_reels") return null;
  if (row.locale !== "ru" && row.locale !== "en") return null;
  return `${row.target === "youtube_shorts" ? "youtube" : "instagram"}_${row.locale}`;
}

function targetDurationMs(row: TargetRow): number | null {
  const metadata = parseJson(row.metadataJson);
  const milliseconds = optionalMetric(metadata.videoDurationMs ?? metadata.durationMs);
  if (milliseconds !== null && milliseconds > 0) return milliseconds;
  const seconds = optionalMetric(metadata.videoDuration ?? metadata.duration);
  return seconds !== null && seconds > 0 ? seconds * 1_000 : null;
}

function optionalMetric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function weightedAverage(samples: Array<{ value: number; weight: number }>): number | null {
  if (!samples.length) return null;
  const weight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  return weight > 0 ? samples.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / weight : null;
}

function parseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function videoLabel(target: string): string {
  const known = VIDEO_TARGETS.find((candidate) => candidate === target);
  return known ? videoTargetLabel(known) : target;
}
