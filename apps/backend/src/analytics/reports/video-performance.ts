import type { BackendDb } from "../../db/client.js";
import { unsafeDb } from "../../db/client.js";
import { heatmapCoverage } from "../audience-heatmap.js";
import { OPENING_SECONDS } from "../collection/video-frames.js";
import { metricFailureCause } from "../collection/collectors/errors.js";
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
  game: string | null;
  hook: string | null;
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
    coverage: { ...coverage(series, byDraft), scripts: scriptCoverage(backendDb, [...byDraft.keys()]) },
    totals: totals(series),
    publishHours: publishHours(series, options.timeZone),
    ageCurve: ageCurve(series),
    trafficSources: trafficSources(series),
    byTag: byTag(backendDb, byDraft),
    audienceGrowth: audienceGrowth(backendDb, from.toISOString()),
    queue: queue(backendDb, options.timeZone),
    heatmaps: heatmapCoverage(backendDb, now),
    openings: openings(backendDb, byDraft),
    videos: videoList(byDraft, options.timeZone, options.limit),
    collection: collectionHealth(backendDb, series),
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
      `SELECT t.id, t.video_draft_id, t.target, t.published_at, t.external_url, d.label, d.locale, d.game, d.hook,
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

/** How much of the window can say what was said in it, and whether that text
 * was written before the video or heard afterwards. Only the written ones are
 * evidence about the words that were chosen. */
function scriptCoverage(backendDb: BackendDb, draftIds: number[]): Record<string, number> {
  if (draftIds.length === 0) return { videos: 0, written: 0, heard: 0, missing: 0 };
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT script_source AS source, COUNT(*) AS count
         FROM video_drafts
        WHERE id IN (${draftIds.map(() => "?").join(",")}) AND script IS NOT NULL
        GROUP BY script_source`,
    )
    .all(...draftIds) as Array<{ source: string | null; count: number }>;
  const written = rows.filter((row) => row.source === "operator").reduce((total, row) => total + row.count, 0);
  const heard = rows.reduce((total, row) => total + row.count, 0) - written;
  return { videos: draftIds.length, written, heard, missing: draftIds.length - written - heard };
}

function totals(series: TargetSeries[]): Record<string, unknown> {
  return Object.fromEntries(
    PLATFORMS.map((platform) => {
      const rows = series.filter((target) => target.target === platform && latest(target));
      const sum = (key: string) => rows.reduce((total, target) => total + metricNumber(latest(target)?.metrics[key]), 0);
      const averages = averaged(rows, ["averageWatchTimeMs", "completionRate", "skipRate"]);
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

/** What the tagged videos say about games and openings. Only tagged videos are
 * counted, and the share that carries a tag travels with the answer: a ranking
 * built on a fifth of the window describes that fifth. */
function byTag(backendDb: BackendDb, byDraft: Map<number, TargetSeries[]>): Record<string, unknown> {
  const drafts = [...byDraft.values()];
  const summarise = (field: "game" | "hook") => {
    const tagged = drafts.filter((targets) => targets[0]?.[field]);
    const groups = new Map<string, number[]>();
    for (const targets of tagged) {
      const key = String(targets[0]?.[field]);
      const views = targets.reduce((sum, target) => sum + metricNumber(latest(target)?.metrics.views), 0);
      groups.set(key, [...(groups.get(key) ?? []), views]);
    }
    return {
      taggedVideos: tagged.length,
      taggedShare: drafts.length ? Math.round((tagged.length / drafts.length) * 100) : 0,
      values: [...groups.entries()]
        .map(([value, views]) => ({
          value,
          videos: views.length,
          medianViews: median(views),
          avgViews: Math.round(views.reduce((sum, view) => sum + view, 0) / views.length),
          confidence: views.length >= CONFIDENT_SAMPLE ? "ok" : views.length >= WEAK_SAMPLE ? "low" : "anecdotal",
        }))
        .sort((left, right) => right.medianViews - left.medianViews),
    };
  };
  const described = gameFacets(backendDb);
  const byFacet = (facet: "genres" | "playerModes") => {
    const groups = new Map<string, number[]>();
    let tagged = 0;
    for (const targets of drafts) {
      const game = targets[0]?.game;
      const raw = game ? (described.get(game)?.[facet] ?? []) : [];
      const values = facet === "playerModes" ? howItIsPlayed(raw) : raw;
      if (!values.length) continue;
      tagged += 1;
      const views = targets.reduce((sum, target) => sum + metricNumber(latest(target)?.metrics.views), 0);
      // A game carries several genres at once, so a video counts under each of
      // them; the shares below are shares of videos, never of one another.
      for (const value of values) groups.set(value, [...(groups.get(value) ?? []), views]);
    }
    return {
      taggedVideos: tagged,
      taggedShare: drafts.length ? Math.round((tagged / drafts.length) * 100) : 0,
      values: [...groups.entries()]
        .map(([value, views]) => ({
          value,
          videos: views.length,
          medianViews: median(views),
          avgViews: Math.round(views.reduce((sum, view) => sum + view, 0) / views.length),
          confidence: views.length >= CONFIDENT_SAMPLE ? "ok" : views.length >= WEAK_SAMPLE ? "low" : "anecdotal",
        }))
        .sort((left, right) => right.medianViews - left.medianViews),
    };
  };
  const openings = frameShapes(backendDb);
  const opening = (() => {
    const groups = new Map<string, number[]>();
    let tagged = 0;
    for (const targets of drafts) {
      const draftId = targets[0]?.video_draft_id;
      const shape = draftId ? openings.get(draftId) : undefined;
      if (!shape) continue;
      tagged += 1;
      groups.set(shape, [
        ...(groups.get(shape) ?? []),
        targets.reduce((sum, target) => sum + metricNumber(latest(target)?.metrics.views), 0),
      ]);
    }
    return {
      taggedVideos: tagged,
      taggedShare: drafts.length ? Math.round((tagged / drafts.length) * 100) : 0,
      values: [...groups.entries()]
        .map(([value, views]) => ({
          value,
          videos: views.length,
          medianViews: median(views),
          avgViews: Math.round(views.reduce((sum, view) => sum + view, 0) / views.length),
          confidence: views.length >= CONFIDENT_SAMPLE ? "ok" : views.length >= WEAK_SAMPLE ? "low" : "anecdotal",
        }))
        .sort((left, right) => right.medianViews - left.medianViews),
    };
  })();
  return { game: summarise("game"), hook: summarise("hook"), genre: byFacet("genres"), playerMode: byFacet("playerModes"), opening };
}

/** How each video opens, as measured from its own first frame. */
function frameShapes(backendDb: BackendDb): Map<number, string> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT video_draft_id AS videoDraftId, json_extract(features_json, '$.shape') AS shape
         FROM video_frame_features WHERE at_seconds = ${OPENING_SECONDS}`,
    )
    .all() as Array<{ videoDraftId: number; shape: string | null }>;
  return new Map(rows.filter((row) => row.shape).map((row) => [row.videoDraftId, String(row.shape)]));
}

/** What is known about each tagged game, for the groupings that are worth more
 * than the game itself: 152 games behind 166 videos cannot group anything, and
 * the handful of genres behind them can. */
/** How a game is played, as one answer.
 *
 * Steam does not choose: a co-op game carries Multi-player, Co-op and Online
 * Co-op at once, so counting every category put the same fifty-one videos in
 * three rows with one median between them, and three rows that move together
 * read as three facts. The order below is what this channel is about -- a game
 * played with friends is a co-op game whatever else it also supports, and only
 * a game with nothing else is single-player. */
const PLAY_ORDER: Array<[string, RegExp]> = [
  ["Co-op", /co-op/iu],
  ["PvP", /pvp/iu],
  ["Multi-player", /multi-player/iu],
  ["Single-player", /single-player/iu],
];

function howItIsPlayed(categories: string[]): string[] {
  for (const [mode, pattern] of PLAY_ORDER) if (categories.some((category) => pattern.test(category))) return [mode];
  return [];
}

function gameFacets(backendDb: BackendDb): Map<string, { genres: string[]; playerModes: string[] }> {
  const rows = unsafeDb(backendDb).sqlite.prepare("SELECT name, genres, player_modes AS playerModes FROM games").all() as Array<{
    name: string;
    genres: string | null;
    playerModes: string | null;
  }>;
  const parse = (value: string | null): string[] => {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  return new Map(rows.map((row) => [row.name, { genres: parse(row.genres), playerModes: parse(row.playerModes) }]));
}

/** Did the channel itself grow while these videos were out. Read from the daily
 * audience snapshots, so it answers for the account and never for one video.
 *
 * The snapshot key is not a calendar day everywhere -- YouTube's rows are
 * hourly -- so the window's edges are found by the moment each row was taken
 * and the count is reported as samples rather than days. */
function audienceGrowth(backendDb: BackendDb, since: string): Array<Record<string, unknown>> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT platform, account, COUNT(*) AS samples, MIN(sampled_at) AS firstAt, MAX(sampled_at) AS lastAt
         FROM creator_profile_snapshots WHERE sampled_at >= ? GROUP BY platform, account`,
    )
    .all(since) as Array<{ platform: string; account: string; samples: number; firstAt: string; lastAt: string }>;
  const sizeAt = (platform: string, account: string, sampledAt: string) => {
    const row = unsafeDb(backendDb)
      .sqlite.prepare("SELECT metrics_json AS metricsJson FROM creator_profile_snapshots WHERE platform=? AND account=? AND sampled_at=?")
      .get(platform, account, sampledAt) as { metricsJson?: string } | undefined;
    const metrics = row?.metricsJson ? (JSON.parse(row.metricsJson) as Record<string, unknown>) : {};
    return metricNumber(metrics.subscriberCount ?? metrics.followersCount);
  };
  return rows.map((row) => {
    const first = sizeAt(row.platform, row.account, row.firstAt);
    const last = sizeAt(row.platform, row.account, row.lastAt);
    return {
      platform: row.platform,
      account: row.account,
      from: row.firstAt,
      to: row.lastAt,
      samples: row.samples,
      first,
      last,
      gained: last - first,
    };
  });
}

/** What is already scheduled, so a recommendation about hours can be aimed at
 * something instead of hanging in the air. */
function queue(backendDb: BackendDb, timeZone: string): Array<Record<string, unknown>> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT t.video_draft_id AS videoDraftId, t.target, t.scheduled_at AS scheduledAt, t.status, d.label, d.game, d.hook
         FROM video_targets t JOIN video_drafts d ON d.id = t.video_draft_id
        WHERE t.status IN ('scheduled', 'queued', 'prepared') AND t.scheduled_at IS NOT NULL
        ORDER BY t.scheduled_at LIMIT 20`,
    )
    .all() as Array<{
    videoDraftId: number;
    target: string;
    scheduledAt: string;
    status: string;
    label: string | null;
    game: string | null;
    hook: string | null;
  }>;
  return rows.map((row) => ({
    ref: `video:${row.videoDraftId}`,
    platform: row.target,
    status: row.status,
    scheduledAt: row.scheduledAt,
    scheduledLocal: localParts(row.scheduledAt, timeZone),
    label: row.label,
    game: row.game,
    hook: row.hook,
  }));
}

/** Where the window's YouTube views came from, summed over the videos that
 * have a reading. Shorts land in SHORTS; the rest is the long tail that tells
 * you whether anything but the feed is working. */
function trafficSources(series: TargetSeries[]): Record<string, unknown> {
  const totals = new Map<string, number>();
  let videos = 0;
  for (const target of series) {
    if (target.target !== "youtube_shorts") continue;
    const reading = [...target.readings].reverse().find((entry) => entry.metrics.trafficSources);
    const sources = reading?.metrics.trafficSources as Record<string, unknown> | undefined;
    if (!sources) continue;
    videos += 1;
    for (const [source, value] of Object.entries(sources)) totals.set(source, (totals.get(source) ?? 0) + metricNumber(value));
  }
  const views = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return {
    youtube_shorts: {
      videos,
      views,
      sources: [...totals.entries()]
        .sort(([, left], [, right]) => right - left)
        .map(([source, value]) => ({ source, views: value, share: views ? Math.round((value / views) * 1000) / 10 : 0 })),
    },
  };
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
        game: targets[0]?.game ?? null,
        hook: targets[0]?.hook ?? null,
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
              latest: summarised(latest(target)?.metrics ?? null),
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
/** Which publishing route a video target belongs to, as the channel registry
 * spells it: `youtube_shorts` on an English draft is the `youtube_en` channel. */
const CHANNEL_PLATFORM: Record<string, string> = { youtube_shorts: "youtube", instagram_reels: "instagram" };

/** Channels nobody publishes to any more.
 *
 * Their videos keep every view they earned, and they belong in the totals. But
 * a route that was switched off cannot be "stopped collecting" and cannot be
 * fixed by reconnecting it: it is finished, and reporting it as a fault sends
 * an operator to repair something they turned off on purpose. */
function disabledChannels(backendDb: BackendDb): Set<string> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare("SELECT platform, locale FROM channel_connections WHERE enabled = 0")
    .all() as Array<{ platform: string; locale: string }>;
  return new Set(rows.map((row) => `${row.platform}:${row.locale}`));
}

/** Readings that answer about one video and swamp a list of them.
 *
 * The per-second retention curve is a hundred points, and the search terms and
 * viewer breakdown are a paragraph each. Repeated across a hundred videos they
 * were most of a quarter-megabyte answer -- large enough that it arrived
 * truncated, which is worse than large: the JSON no longer parsed at all.
 * `video-metrics` is where one video is read in full. */
const READ_ONE_VIDEO_FOR = ["retentionCurve", "searchTerms", "viewers", "trafficSources"] as const;

function summarised(metrics: Metrics | null): Metrics | null {
  if (!metrics) return null;
  const kept: Metrics = {};
  const elsewhere: string[] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if ((READ_ONE_VIDEO_FOR as readonly string[]).includes(key)) elsewhere.push(key);
    else kept[key] = value;
  }
  return elsewhere.length ? { ...kept, inVideoMetrics: elsewhere } : kept;
}

/** What each opening did to the first seconds.
 *
 * Views say whether a video was shown. Retention at three seconds and
 * Instagram's skip rate say whether the opening held anyone once it was, and
 * that is the only part of a video its author chooses twice. Grouped by the
 * kind of opening -- what was said -- and by its shape -- what was on screen --
 * because they are different choices and a video makes both.
 */
function openings(backendDb: BackendDb, byDraft: Map<number, TargetSeries[]>): Record<string, unknown> {
  const shapes = frameShapes(backendDb);
  const said = spokenOpenings(backendDb);
  const group = (of: (draftId: number) => string | undefined) => {
    const rows = new Map<string, { retention: number[]; skip: number[]; views: number[] }>();
    for (const [draftId, targets] of byDraft) {
      const key = of(draftId);
      if (!key) continue;
      const slot = rows.get(key) ?? { retention: [], skip: [], views: [] };
      for (const target of targets) {
        const metrics = latest(target)?.metrics;
        if (!metrics) continue;
        const retention = metricNumber(metrics.retentionAt3s);
        const skip = metricNumber(metrics.skipRate);
        if (retention) slot.retention.push(retention);
        if (skip) slot.skip.push(skip);
      }
      slot.views.push(targets.reduce((sum, target) => sum + metricNumber(latest(target)?.metrics.views), 0));
      rows.set(key, slot);
    }
    return [...rows.entries()]
      .map(([value, slot]) => ({
        value,
        videos: slot.views.length,
        medianViews: median(slot.views),
        // The two figures the opening is actually answerable by: how many were
        // still there at three seconds, and how many left inside them.
        medianRetentionAt3s: slot.retention.length ? median(slot.retention) : null,
        medianSkipRate: slot.skip.length ? median(slot.skip) : null,
        confidence: slot.views.length >= CONFIDENT_SAMPLE ? "ok" : slot.views.length >= WEAK_SAMPLE ? "low" : "anecdotal",
      }))
      .sort((left, right) => (right.medianRetentionAt3s ?? 0) - (left.medianRetentionAt3s ?? 0));
  };
  return {
    byKind: group((draftId) => said.get(draftId)?.hook),
    byShape: group((draftId) => shapes.get(draftId)),
    coverage: {
      kind: said.size,
      shape: shapes.size,
      videos: byDraft.size,
    },
    examples: [...byDraft.keys()]
      .map((draftId) => ({ ref: `video:${draftId}`, ...said.get(draftId), shape: shapes.get(draftId) }))
      .filter((row) => row.hook && row.shape)
      .slice(0, 6),
  };
}

/** The words each video opens with, and what kind of opening they are. */
function spokenOpenings(backendDb: BackendDb): Map<number, { hook: string; opening: string }> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      "SELECT id AS videoDraftId, hook, substr(opening_line, 1, 120) AS opening FROM video_drafts WHERE hook IS NOT NULL AND opening_line IS NOT NULL",
    )
    .all() as Array<{ videoDraftId: number; hook: string; opening: string }>;
  return new Map(rows.map((row) => [row.videoDraftId, { hook: row.hook, opening: row.opening }]));
}

function collectionHealth(backendDb: BackendDb, series: TargetSeries[]): Record<string, unknown> {
  const disabled = disabledChannels(backendDb);
  const live = series.filter((target) => !disabled.has(`${CHANNEL_PLATFORM[target.target] ?? target.target}:${target.locale}`));
  const failing = live.filter((target) => target.last_error);
  // A raw 403 body is a request URL and a page of JSON, and the reader of this
  // report is an agent answering a creator's question. What stopped collection
  // is a sentence -- and how many rows it stopped, because "the quota is spent"
  // and "the credential is gone" are different news at nineteen rows and one.
  const causes = new Map<string, { targets: number; frozen: number; platform: string }>();
  for (const target of failing) {
    const cause = metricFailureCause(String(target.last_error));
    const key = `${target.target}: ${cause}`;
    const seen = causes.get(key) ?? { targets: 0, frozen: 0, platform: target.target };
    causes.set(key, { ...seen, targets: seen.targets + 1, frozen: seen.frozen + (target.frozen_at ? 1 : 0) });
  }
  return {
    targetsWithoutReadings: live
      .filter((target) => !target.readings.length)
      .map((target) => ({ ref: `video:${target.video_draft_id}`, platform: target.target })),
    onDisabledChannels: series.length - live.length,
    frozen: live.filter((target) => target.frozen_at).length,
    failing: failing.length,
    stopped: [...causes.entries()]
      .map(([cause, counts]) => ({ cause, targets: counts.targets, frozen: counts.frozen }))
      .sort((left, right) => right.targets - left.targets)
      .slice(0, 5),
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
    "`byTag.opening` is measured from the video's own first frame — face, split screen or plain gameplay — and is the axis to read beside retention at 1 and 3 seconds and Instagram's skip rate.",
    "`byTag.genre` and `byTag.playerMode` come from the game each video is tagged with, so they group 150 one-off games into a handful of axes; a video whose game has several genres is counted under each.",
    "`byTag.playerMode` is one answer per video, not several: Steam marks a co-op game as multi-player and co-op at once, and the most specific of those is the one reported.",
    "`openings` is the one block about a choice rather than an outcome: what was said in the first line and what was on screen at two seconds, against how many viewers were still there at three. Views belong to the feed, the opening belongs to whoever made the video.",
    "An opening's kind is a model's judgement about ten words, not a measurement — `hooks-classify` prints the words beside the label so a grouping can be checked before it is believed.",
    "`byTag` counts only tagged videos: read `taggedShare` before ranking games or hooks, and tag more with `video-tag` if it is low.",
    "`trafficSources` and `retentionAt1s/3s/5s` are YouTube-only and are read twice in a video's life, at 24 hours and at 7 days; a video younger than that carries neither.",
    "`skipRate` is Instagram's own answer to the first three seconds: the share of viewers who left inside them. It is the closest thing Reels has to YouTube's retention curve, and Instagram publishes nothing finer.",
    "Retention above 100% is not an error: YouTube counts a rewatched second more than once, so a looping Short really does hold more than one view per viewer there.",
    "`heatmaps` is what a browser copied out of a platform dashboard, with the age of the capture: it describes followers, while most Reels views come from people who follow nothing.",
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
