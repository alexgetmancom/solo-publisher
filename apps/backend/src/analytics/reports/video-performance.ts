import type { BackendDb } from "../../db/client.js";
import { unsafeDb } from "../../db/client.js";
import { metricNumber } from "../snapshots/creator-store.js";

/** Ages, in hours since publication, a video is compared at. They mirror the
 * collection cadence in metric-checkpoints.ts: hourly for the first two days,
 * so 1, 2, 6, 24 and 48 are real readings rather than interpolations, while
 * 168 lands on the six-hourly stretch and is reported with the age it actually
 * came from. */
const AGE_BUCKETS_HOURS = [0.25, 0.5, 1, 2, 6, 24, 48, 168] as const;

/** Below this a per-hour recommendation is arithmetic, not evidence. Every
 * bucket carries its own sample size as well; this only decides the label. */
const CONFIDENT_SAMPLE = 5;
const WEAK_SAMPLE = 3;

/** A slot whose views come mostly from one video describes that video, not the
 * slot. The agent is told rather than left to notice. */
const DOMINANCE_SHARE = 0.6;

const PLATFORMS = ["youtube_shorts", "instagram_reels"] as const;

type Metrics = Record<string, unknown>;

type TargetRow = {
  id: number;
  video_draft_id: number;
  target: string;
  published_at: string | null;
  external_url: string | null;
  label: string | null;
  locale: string;
  frozen_at: string | null;
  last_error: string | null;
  last_checked_at: string | null;
  checkpoint_index: number | null;
};

type SnapshotRow = { video_target_id: number; checkpoint_index: number | null; sampled_at: string; metrics_json: string | null };

type Reading = { ageHours: number; sampledAt: string; metrics: Metrics };

type TargetSeries = TargetRow & { readings: Reading[]; comments: number };

export type VideoReportOptions = { days: number; timeZone: string; limit: number };

/** Everything one analysis pass needs about published videos, in one read:
 * what was published, how each platform's copy performed, when in the local
 * week it went out, and how far the numbers can be trusted. */
export function videoPerformanceReport(backendDb: BackendDb, options: VideoReportOptions): Record<string, unknown> {
  const now = new Date();
  const from = new Date(now.getTime() - options.days * 86_400_000);
  const series = loadSeries(backendDb, from.toISOString());
  const byDraft = new Map<number, TargetSeries[]>();
  for (const target of series) byDraft.set(target.video_draft_id, [...(byDraft.get(target.video_draft_id) ?? []), target]);
  return {
    window: { days: options.days, from: from.toISOString(), to: now.toISOString(), timeZone: options.timeZone },
    coverage: coverage(series, byDraft),
    totals: totals(series),
    publishHours: publishHours(series, options.timeZone),
    ageCurve: ageCurve(series),
    videos: videoList(byDraft, options.timeZone, options.limit),
    collection: collectionHealth(series),
    reading: readingNotes(),
  };
}

/** One video across both platforms, with every reading it has and what changed
 * between them. This is the drill-down `video-report` points at. */
export function videoPerformanceDetail(backendDb: BackendDb, videoDraftId: number, timeZone: string): Record<string, unknown> {
  const draft = unsafeDb(backendDb).sqlite.prepare("SELECT id, label, locale, status FROM video_drafts WHERE id=?").get(videoDraftId) as
    | { id: number; label: string | null; locale: string; status: string }
    | undefined;
  if (!draft) throw new Error(`No video draft ${videoDraftId}. Run \`video-report\` for the videos this Studio has.`);
  const series = loadSeries(backendDb, null, videoDraftId);
  return {
    ref: `video:${videoDraftId}`,
    label: draft.label || null,
    locale: draft.locale,
    status: draft.status,
    targets: series.map((target) => ({
      platform: target.target,
      url: target.external_url,
      publishedAt: target.published_at,
      publishedLocal: target.published_at ? localParts(target.published_at, timeZone) : null,
      comments: target.comments,
      collection: {
        frozen: Boolean(target.frozen_at),
        checkpointIndex: target.checkpoint_index,
        lastCheckedAt: target.last_checked_at,
        lastError: target.last_error,
      },
      history: history(target),
      atAges: atAges(target),
    })),
    comments: recentComments(
      backendDb,
      series.map((target) => target.id),
    ),
    reading: readingNotes(),
  };
}

function loadSeries(backendDb: BackendDb, publishedFrom: string | null, videoDraftId?: number): TargetSeries[] {
  const sqlite = unsafeDb(backendDb).sqlite;
  const where = videoDraftId ? "t.video_draft_id = ?" : "t.published_at >= ?";
  const targets = sqlite
    .prepare(
      `SELECT t.id, t.video_draft_id, t.target, t.published_at, t.external_url, d.label, d.locale,
              s.frozen_at, s.last_error, s.last_checked_at, s.checkpoint_index
         FROM video_targets t
         JOIN video_drafts d ON d.id = t.video_draft_id
         LEFT JOIN video_metric_schedule s ON s.video_target_id = t.id
        WHERE t.status = 'published' AND ${where}
        ORDER BY t.published_at DESC, t.id`,
    )
    .all(videoDraftId ?? publishedFrom) as TargetRow[];
  if (!targets.length) return [];
  const ids = targets.map((target) => target.id);
  const placeholders = ids.map(() => "?").join(",");
  const snapshots = sqlite
    .prepare(
      `SELECT video_target_id, checkpoint_index, sampled_at, metrics_json
         FROM video_metric_snapshots WHERE video_target_id IN (${placeholders}) ORDER BY sampled_at`,
    )
    .all(...ids) as SnapshotRow[];
  const commentCounts = sqlite
    .prepare(`SELECT video_target_id, COUNT(*) AS count FROM social_comments WHERE video_target_id IN (${placeholders}) GROUP BY 1`)
    .all(...ids) as Array<{ video_target_id: number; count: number }>;
  const comments = new Map(commentCounts.map((row) => [row.video_target_id, row.count]));
  const readings = new Map<number, Reading[]>();
  for (const snapshot of snapshots) {
    const target = targets.find((row) => row.id === snapshot.video_target_id);
    if (!target) continue;
    readings.set(snapshot.video_target_id, [
      ...(readings.get(snapshot.video_target_id) ?? []),
      {
        ageHours: ageHours(target.published_at, snapshot.sampled_at),
        sampledAt: snapshot.sampled_at,
        metrics: snapshot.metrics_json ? (JSON.parse(snapshot.metrics_json) as Metrics) : {},
      },
    ]);
  }
  return targets.map((target) => ({ ...target, readings: readings.get(target.id) ?? [], comments: comments.get(target.id) ?? 0 }));
}

function ageHours(publishedAt: string | null, sampledAt: string): number {
  if (!publishedAt) return 0;
  const published = new Date(publishedAt).getTime();
  const sampled = new Date(sampledAt).getTime();
  if (Number.isNaN(published) || Number.isNaN(sampled)) return 0;
  return Math.round(((sampled - published) / 3_600_000) * 10) / 10;
}

function latest(target: TargetSeries): Reading | null {
  return target.readings.at(-1) ?? null;
}

/** The last reading taken at or before an age. Its real age travels with the
 * value: a bucket filled from a reading six hours late is not the same claim. */
function readingAt(target: TargetSeries, bucketHours: number): Reading | null {
  let found: Reading | null = null;
  for (const reading of target.readings) if (reading.ageHours <= bucketHours) found = reading;
  return found;
}

function coverage(series: TargetSeries[], byDraft: Map<number, TargetSeries[]>): Record<string, unknown> {
  const perPlatform = Object.fromEntries(
    PLATFORMS.map((platform) => {
      const rows = series.filter((target) => target.target === platform);
      return [
        platform,
        {
          published: rows.length,
          withMetrics: rows.filter((target) => target.readings.length > 0).length,
          medianReadings: median(rows.map((target) => target.readings.length)),
        },
      ];
    }),
  );
  return {
    videos: byDraft.size,
    targets: series.length,
    crossPosted: [...byDraft.values()].filter((targets) => new Set(targets.map((target) => target.target)).size > 1).length,
    byPlatform: perPlatform,
  };
}

function totals(series: TargetSeries[]): Record<string, unknown> {
  return Object.fromEntries(
    PLATFORMS.map((platform) => {
      const rows = series.filter((target) => target.target === platform && latest(target));
      const sum = (key: string) => rows.reduce((total, target) => total + metricNumber(latest(target)?.metrics[key]), 0);
      const averages = averaged(rows, ["averageWatchTimeMs", "completionRate"]);
      return [
        platform,
        {
          videos: rows.length,
          views: sum("views"),
          likes: sum("likes"),
          comments: sum("comments"),
          shares: sum("shares"),
          saves: sum("saves"),
          reach: sum("reach"),
          follows: sum("follows"),
          commentsStored: rows.reduce((total, target) => total + target.comments, 0),
          ...averages,
          engagementPerReach: rate(sum("likes") + sum("comments") + sum("shares") + sum("saves"), sum("reach")),
        },
      ];
    }),
  );
}

/** Weekday and weekend kept apart, then split by the local hour a video went
 * out. Each slot carries its sample size, its confidence and whether one video
 * is carrying it. */
function publishHours(series: TargetSeries[], timeZone: string): Record<string, unknown> {
  const modes = { weekday: [] as TargetSeries[], weekend: [] as TargetSeries[] };
  for (const target of series) {
    if (!target.published_at || !latest(target)) continue;
    modes[localParts(target.published_at, timeZone).weekend ? "weekend" : "weekday"].push(target);
  }
  return Object.fromEntries(
    Object.entries(modes).map(([mode, rows]) => [
      mode,
      Object.fromEntries(
        PLATFORMS.map((platform) => [
          platform,
          hourSlots(
            rows.filter((target) => target.target === platform),
            timeZone,
          ),
        ]),
      ),
    ]),
  );
}

function hourSlots(rows: TargetSeries[], timeZone: string): Array<Record<string, unknown>> {
  const byHour = new Map<number, TargetSeries[]>();
  for (const target of rows) {
    const hour = localParts(target.published_at as string, timeZone).hour;
    byHour.set(hour, [...(byHour.get(hour) ?? []), target]);
  }
  return [...byHour.entries()]
    .sort(([left], [right]) => left - right)
    .map(([hour, targets]) => {
      const views = targets.map((target) => metricNumber(latest(target)?.metrics.views));
      const total = views.reduce((sum, value) => sum + value, 0);
      const value = (key: string) => targets.reduce((sum, target) => sum + metricNumber(latest(target)?.metrics[key]), 0);
      const reach = value("reach");
      return {
        hourLocal: hour,
        videos: targets.length,
        confidence: targets.length >= CONFIDENT_SAMPLE ? "ok" : targets.length >= WEAK_SAMPLE ? "low" : "anecdotal",
        dominatedBySingleVideo: total > 0 && Math.max(...views) / total >= DOMINANCE_SHARE,
        avgViews: Math.round(total / targets.length),
        medianViews: median(views),
        avgShares: Math.round(value("shares") / targets.length),
        avgSaves: Math.round(value("saves") / targets.length),
        avgComments: Math.round((value("comments") / targets.length) * 10) / 10,
        avgFollows: Math.round(value("follows") / targets.length),
        engagementPerReach: rate(value("likes") + value("comments") + value("shares") + value("saves"), reach),
      };
    });
}

/** How much of a video's current result was already in by each age, per
 * platform. This is the early-speed question, answered from readings only. */
function ageCurve(series: TargetSeries[]): Record<string, unknown> {
  return Object.fromEntries(
    PLATFORMS.map((platform) => {
      const rows = series.filter((target) => target.target === platform && latest(target));
      return [
        platform,
        AGE_BUCKETS_HOURS.map((bucket) => {
          const samples = rows
            .map((target) => ({ reading: readingAt(target, bucket), final: latest(target)?.metrics ?? {} }))
            .filter(
              (sample): sample is { reading: Reading; final: Record<string, unknown> } =>
                sample.reading != null && sample.reading.ageHours > 0,
            );
          const at = (key: string) => samples.map((sample) => metricNumber(sample.reading.metrics[key]));
          // The share of the final figure that was already in, per metric: it is
          // the only form in which videos of different sizes are comparable, and
          // it is what answers when an audience arrives versus when it writes.
          const shareOfCurrent = (key: string) =>
            median(
              samples
                .filter((sample) => metricNumber(sample.final[key]) > 0)
                .map((sample) => Math.round((metricNumber(sample.reading.metrics[key]) / metricNumber(sample.final[key])) * 1000) / 10),
            );
          const views = at("views");
          return {
            ageHours: bucket,
            samples: samples.length,
            medianViews: median(views),
            avgViews: samples.length ? Math.round(views.reduce((sum, value) => sum + value, 0) / samples.length) : 0,
            medianShareOfCurrent: shareOfCurrent("views"),
            medianComments: median(at("comments")),
            medianCommentShareOfCurrent: shareOfCurrent("comments"),
            medianReadingAgeHours: median(samples.map((sample) => sample.reading.ageHours)),
          };
        }),
      ];
    }),
  );
}

function videoList(byDraft: Map<number, TargetSeries[]>, timeZone: string, limit: number): Array<Record<string, unknown>> {
  return [...byDraft.entries()]
    .map(([draftId, targets]) => {
      const published =
        targets
          .map((target) => target.published_at)
          .filter((value): value is string => Boolean(value))
          .sort()[0] ?? null;
      const views = targets.reduce((sum, target) => sum + metricNumber(latest(target)?.metrics.views), 0);
      return {
        ref: `video:${draftId}`,
        label: targets[0]?.label || null,
        publishedAt: published,
        publishedLocal: published ? localParts(published, timeZone) : null,
        views,
        platforms: Object.fromEntries(
          targets.map((target) => [
            target.target,
            {
              url: target.external_url,
              comments: target.comments,
              readings: target.readings.length,
              latest: latest(target)?.metrics ?? null,
              latestAt: latest(target)?.sampledAt ?? null,
            },
          ]),
        ),
      };
    })
    .sort((left, right) => right.views - left.views)
    .slice(0, limit);
}

/** Why a number may be missing, said once and in the report that shows it: a
 * frozen schedule and a scope error both look like an empty column. */
function collectionHealth(series: TargetSeries[]): Record<string, unknown> {
  const frozen = series.filter((target) => target.frozen_at);
  const failing = series.filter((target) => target.last_error);
  return {
    targetsWithoutReadings: series
      .filter((target) => !target.readings.length)
      .map((target) => ({ ref: `video:${target.video_draft_id}`, platform: target.target })),
    frozen: frozen.length,
    failing: failing.length,
    errors: [...new Set(failing.map((target) => `${target.target}: ${String(target.last_error).slice(0, 200)}`))].slice(0, 5),
  };
}

function recentComments(backendDb: BackendDb, targetIds: number[]): Array<Record<string, unknown>> {
  if (!targetIds.length) return [];
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT platform, author, text, like_count, published_at FROM social_comments
        WHERE video_target_id IN (${targetIds.map(() => "?").join(",")})
        ORDER BY published_at DESC LIMIT 20`,
    )
    .all(...targetIds) as Array<Record<string, unknown>>;
}

function history(target: TargetSeries): Array<Record<string, unknown>> {
  return target.readings.map((reading, index) => {
    const previous = target.readings[index - 1];
    const elapsedHours = previous ? Math.max(0.1, reading.ageHours - previous.ageHours) : Math.max(0.1, reading.ageHours);
    const delta = (key: string) => metricNumber(reading.metrics[key]) - (previous ? metricNumber(previous.metrics[key]) : 0);
    return {
      ageHours: reading.ageHours,
      sampledAt: reading.sampledAt,
      metrics: reading.metrics,
      deltas: Object.fromEntries(["views", "likes", "comments", "shares", "saves", "reach", "follows"].map((key) => [key, delta(key)])),
      viewsPerHour: Math.round(delta("views") / elapsedHours),
    };
  });
}

function atAges(target: TargetSeries): Array<Record<string, unknown>> {
  return AGE_BUCKETS_HOURS.map((bucket) => {
    const reading = readingAt(target, bucket);
    return {
      ageHours: bucket,
      readingAgeHours: reading?.ageHours ?? null,
      views: reading ? metricNumber(reading.metrics.views) : null,
      shares: reading ? metricNumber(reading.metrics.shares) : null,
      saves: reading ? metricNumber(reading.metrics.saves) : null,
      comments: reading ? metricNumber(reading.metrics.comments) : null,
      follows: reading ? metricNumber(reading.metrics.follows) : null,
    };
  });
}

function readingNotes(): string[] {
  return [
    "Every figure is a reading taken at a moment, not a lifetime total: videos in one window have different ages, so compare `atAges`/`ageCurve` rather than latest values.",
    "`readingAgeHours` is the age the value actually came from; where it is far from the bucket, the bucket is approximate.",
    "shares/saves/reach/follows are Instagram-only; YouTube reports averageWatchTimeMs, completionRate and subscribersGained instead.",
    "A slot with fewer than 5 videos, or one marked dominatedBySingleVideo, is not evidence for an hour recommendation — say so when reporting it.",
    "This Studio knows nothing about native audience heatmaps, traffic sources or per-second retention: those live only in YouTube Studio and Instagram Insights.",
  ];
}

function averaged(rows: TargetSeries[], keys: string[]): Record<string, number | null> {
  return Object.fromEntries(
    keys.map((key) => {
      const values = rows
        .map((target) => latest(target)?.metrics[key])
        .filter((value) => value != null)
        .map((value) => metricNumber(value));
      return [
        `avg${key[0]?.toUpperCase()}${key.slice(1)}`,
        values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
      ];
    }),
  );
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return Math.round(value * 10) / 10;
}

function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 100 : null;
}

/** The local weekday and hour a video went out. Publication times are stored in
 * UTC and every scheduling question here is asked in the Studio's own zone. */
function localParts(instant: string, timeZone: string): { weekday: string; hour: number; weekend: boolean; clock: string } {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant)))
    parts[part.type] = part.value;
  const weekday = parts.weekday ?? "";
  const hour = Number(parts.hour ?? 0) % 24;
  return {
    weekday,
    hour,
    weekend: weekday === "Sat" || weekday === "Sun",
    clock: `${String(hour).padStart(2, "0")}:${parts.minute ?? "00"}`,
  };
}
