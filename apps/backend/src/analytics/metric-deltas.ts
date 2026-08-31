import { type BackendDb, unsafeDb } from "../db/client.js";
import { creatorProfiles } from "../db/schema.js";
import { metricNumber } from "./snapshots/creator-store.js";

/** Single source for period-delta analytics shared by every report and dashboard.
 * Post/video engagement lives in metric_samples; audience growth in
 * creator_profile_snapshots. Callers differ only in how they aggregate the deltas.
 * Both queries below let SQLite (via idx_metric_samples_lookup) find the
 * latest/baseline row per group instead of pulling the whole matched history
 * into JS and reducing it there. */

/** `metrics.shares` is the Share action (Instagram sends / YouTube share
 * button), never a repost. */
export type VideoMetricRow = {
  platform: string;
  locale: "ru" | "en";
  label: string;
  publishedAt: string | null;
  metrics: Record<string, unknown>;
};
type TextPostMetricRow = { platform: string; label: string; metrics: Record<string, unknown> };
export type ContentMetrics = { views: number; likes: number; comments: number; shares: number; saves: number };

/** NUL joins composite map keys so account display names (which can contain any
 * printable character) never collide with the separator. */
const KEY_SEP = String.fromCharCode(0);

type MetricSeries = { target: string; metric: string; firstAt: string; latest: number; baseline: number | null };

/** One row per (post, target, metric) with its latest value and the last value
 * at or before `since`. This is the primitive every metric_samples projection
 * is built on, so the scan and baseline rule exist in exactly one place. */
function metricSeriesSince(backendDb: BackendDb, since: string): MetricSeries[] {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      // One grouping pass to find the keys, then two indexed point lookups per
      // key. It used to rank the whole table twice and group it once -- three
      // full passes over 27k rows for a figure the dashboard asks for on every
      // cold render. idx_metric_samples_lookup is
      // (publication_key, target, metric_name, sampled_at), which is exactly
      // the shape both lookups want.
      `WITH keys AS (
         SELECT publication_key, target, metric_name, MIN(sampled_at) AS first_at
           FROM metric_samples
          WHERE target NOT LIKE 'site_%'
          GROUP BY publication_key, target, metric_name
       )
       SELECT k.target AS target, k.metric_name AS metric_name, k.first_at AS first_at,
              CAST(COALESCE((
                SELECT latest.value FROM metric_samples AS latest
                 WHERE latest.publication_key = k.publication_key AND latest.target = k.target AND latest.metric_name = k.metric_name
                 ORDER BY latest.sampled_at DESC, latest.id DESC
                 LIMIT 1
              ), 0) AS INTEGER) AS latest,
              (
                SELECT CAST(COALESCE(baseline.value, 0) AS INTEGER) FROM metric_samples AS baseline
                 WHERE baseline.publication_key = k.publication_key AND baseline.target = k.target
                   AND baseline.metric_name = k.metric_name AND baseline.sampled_at <= ?
                 ORDER BY baseline.sampled_at DESC, baseline.id DESC
                 LIMIT 1
              ) AS baseline
         FROM keys k`,
    )
    .all(since) as Array<{ target: string; metric_name: string; first_at: string; latest: number; baseline: number | null }>;
  return rows.map((row) => ({
    target: row.target,
    metric: row.metric_name,
    firstAt: row.first_at,
    latest: row.latest,
    baseline: row.baseline,
  }));
}

/** Text-post metric deltas grouped by delivery target. `reposts` is the
 * platform's share/forward action and is rendered as “пересылки” in UI. */
export function textContentMetricsByPlatform(backendDb: BackendDb, since: string): Map<string, ContentMetrics> {
  const totals = new Map<string, ContentMetrics>();
  for (const entry of metricSeriesSince(backendDb, since)) {
    if (entry.baseline == null && entry.firstAt < since) continue;
    const value = totals.get(entry.target) ?? { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
    const delta = Math.max(0, entry.latest - (entry.baseline ?? 0));
    if (entry.metric === "views") value.views += delta;
    else if (entry.metric === "likes") value.likes += delta;
    else if (entry.metric === "comments" || entry.metric === "replies") value.comments += delta;
    else if (entry.metric === "reposts" || entry.metric === "shares") value.shares += delta;
    else if (entry.metric === "saves") value.saves += delta;
    totals.set(entry.target, value);
  }
  return totals;
}

/** Individual published text posts, with live counts minus the checkpoint at
 * the selected period's start. A row remains visible even before its first
 * metric observation so the dashboard can show a clear zero rather than hide
 * a newly published post. */
export function latestTextPostMetrics(backendDb: BackendDb, since: string): TextPostMetricRow[] {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `WITH ranked_samples AS (
         SELECT publication_key, target, metric_name, value, sampled_at, id,
                ROW_NUMBER() OVER (PARTITION BY publication_key, target, metric_name ORDER BY sampled_at DESC, id DESC) AS rn
         FROM metric_samples
       )
       SELECT 'post:' || d.post_id AS publication_key,
              COALESCE(NULLIF(ru.approved_text, ''), NULLIF(ru.source_text, ''), NULLIF(en.approved_text, ''), NULLIF(en.source_text, ''), 'post:' || d.post_id) AS label,
              t.target, sample.metric_name, sample.value AS latest,
              (SELECT value FROM metric_samples baseline
               WHERE baseline.publication_key = t.publication_key AND baseline.target = t.target
                 AND baseline.metric_name = sample.metric_name AND baseline.sampled_at <= ?
               ORDER BY baseline.sampled_at DESC, baseline.id DESC LIMIT 1) AS baseline
       FROM drafts d
       LEFT JOIN post_locales ru ON ru.draft_id=d.id AND ru.locale='ru'
       LEFT JOIN post_locales en ON en.draft_id=d.id AND en.locale='en'
       JOIN publication_targets t ON t.publication_key = 'post:' || d.post_id
       LEFT JOIN ranked_samples sample ON sample.publication_key = t.publication_key AND sample.target = t.target AND sample.rn = 1
       WHERE t.status = 'published' AND COALESCE(t.published_at, d.updated_at, d.created_at) >= ?
         AND t.target NOT LIKE 'site_%' AND t.target NOT LIKE '%stories%'
       ORDER BY t.published_at DESC, t.target ASC`,
    )
    .all(since, since) as Array<{
    publication_key: string;
    label: string;
    target: string;
    metric_name: string | null;
    latest: number | null;
    baseline: number | null;
  }>;
  const grouped = new Map<string, TextPostMetricRow>();
  for (const row of rows) {
    const key = `${row.publication_key}${KEY_SEP}${row.target}`;
    const value = grouped.get(key) ?? { platform: row.target, label: row.label, metrics: {} };
    if (row.metric_name) value.metrics[row.metric_name] = Math.max(0, metricNumber(row.latest) - metricNumber(row.baseline));
    grouped.set(key, value);
  }
  return [...grouped.values()];
}

export function latestVideoMetrics(backendDb: BackendDb, since: string): VideoMetricRow[] {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT target.target AS platform, draft.locale, draft.label, target.published_at,
              latest.metrics_json AS latest_metrics, baseline.metrics_json AS baseline_metrics
       FROM video_targets target
       JOIN video_drafts draft ON draft.id = target.video_draft_id
       JOIN video_metric_snapshots latest ON latest.id =
         (SELECT id FROM video_metric_snapshots WHERE video_target_id = target.id
          ORDER BY sampled_at DESC, id DESC LIMIT 1)
       LEFT JOIN video_metric_snapshots baseline ON baseline.id =
         (SELECT id FROM video_metric_snapshots WHERE video_target_id = target.id AND sampled_at <= ?
          ORDER BY sampled_at DESC, id DESC LIMIT 1)
       WHERE target.status = 'published'
       ORDER BY latest.id DESC`,
    )
    .all(since) as Array<{
    platform: string;
    locale: string;
    label: string;
    published_at: string | null;
    latest_metrics: string;
    baseline_metrics: string | null;
  }>;
  return rows.flatMap((row) => {
    const latest = JSON.parse(row.latest_metrics) as Record<string, unknown>;
    const baseline = row.baseline_metrics ? (JSON.parse(row.baseline_metrics) as Record<string, unknown>) : null;
    const publishedInPeriod = row.published_at != null && row.published_at >= since;
    if (!baseline && !publishedInPeriod) return [];
    // A provider migration can leave a synthetic all-zero baseline for an
    // older video. Treating its lifetime count as this period's performance is
    // worse than temporarily omitting it, so wait for a real observation.
    if (!publishedInPeriod && baseline && !Object.values(baseline).some((value) => metricNumber(value) > 0)) return [];
    const metrics = Object.fromEntries(
      Object.entries(latest).map(([key, value]) => [key, Math.max(0, metricNumber(value) - metricNumber(baseline?.[key]))]),
    );
    return [
      { platform: row.platform, locale: row.locale === "en" ? "en" : "ru", label: row.label, publishedAt: row.published_at, metrics },
    ];
  });
}

/** A channel's public `viewCount` is available immediately from YouTube Data
 * API. The hourly profile observations make its 24h delta complete even when
 * the Analytics API has not closed the report yet. */
export function youtubeChannelViewDeltaSince(backendDb: BackendDb, since: string, platform: string): number | null {
  // A recovery after an outage must not label several days of channel growth
  // as a 24-hour delta. Hourly collection normally allows a small delay.
  const oldestUsableBaseline = new Date(new Date(since).getTime() - 2 * 60 * 60_000).toISOString();
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT
         (SELECT CAST(COALESCE(json_extract(metrics_json, '$.viewCount'), 0) AS INTEGER)
          FROM creator_profile_snapshots WHERE platform = ?
          ORDER BY sampled_at DESC, id DESC LIMIT 1) AS latest,
         (SELECT CAST(COALESCE(json_extract(metrics_json, '$.viewCount'), 0) AS INTEGER)
          FROM creator_profile_snapshots WHERE platform = ? AND sampled_at <= ?
          ORDER BY sampled_at DESC, id DESC LIMIT 1) AS baseline,
         (SELECT sampled_at FROM creator_profile_snapshots WHERE platform = ? AND sampled_at <= ?
          ORDER BY sampled_at DESC, id DESC LIMIT 1) AS baseline_sampled_at`,
    )
    .get(platform, platform, since, platform, since) as { latest?: number; baseline?: number; baseline_sampled_at?: string } | null;
  if (rows?.latest == null || rows.baseline == null || !rows.baseline_sampled_at || rows.baseline_sampled_at < oldestUsableBaseline)
    return null;
  return Math.max(0, rows.latest - rows.baseline);
}

/** The current account's latest projection minus its own last observation at
 * or before `since`, keyed by `platform${KEY_SEP}account`. Reconnecting a route
 * to another account keeps the old snapshots attributable without mixing their
 * growth into the replacement account. A profile with no baseline is omitted rather than
 * counting its lifetime follower number as growth. `until` makes the same
 * calculation safe for historical dashboard dates: the latest sample must be
 * inside the selected period, not whatever was collected today. */
function audienceGrowthByAccount(backendDb: BackendDb, since: string, until: string): Map<string, number> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `WITH samples AS (
         SELECT platform, account, sampled_at, id,
                CAST(COALESCE(json_extract(metrics_json, '$.subscriberCount'), json_extract(metrics_json, '$.followersCount'), 0) AS INTEGER) AS value
         FROM creator_profile_snapshots
         WHERE sampled_at <= ?
       ),
       ranked_latest AS (
         SELECT platform, account, value,
                ROW_NUMBER() OVER (PARTITION BY platform ORDER BY sampled_at DESC, id DESC) AS rn
         FROM samples
       ),
       ranked_baseline AS (
         SELECT platform, account, value,
                ROW_NUMBER() OVER (PARTITION BY platform, account ORDER BY sampled_at DESC, id DESC) AS rn
         FROM samples WHERE sampled_at <= ?
       )
       SELECT l.platform AS platform, l.account AS account, l.value AS latest,
              CASE WHEN b.platform IS NOT NULL THEN b.value ELSE NULL END AS baseline
       FROM ranked_latest l
       LEFT JOIN ranked_baseline b ON b.platform = l.platform AND b.account = l.account AND b.rn = 1
       WHERE l.rn = 1`,
    )
    .all(until, since) as Array<{ platform: string; account: string; latest: number; baseline: number | null }>;
  return new Map(
    rows.filter((row) => row.baseline != null).map((row) => [`${row.platform}${KEY_SEP}${row.account}`, row.latest - (row.baseline ?? 0)]),
  );
}

/** Prefer a platform's own period report where it exists (YouTube exposes
 * gained/lost subscribers directly). Zernio currently exposes this aggregate
 * only for 30 days, so shorter Instagram periods continue to use our durable
 * daily observations. */
export function audienceGrowthByPlatform(
  backendDb: BackendDb,
  since: string,
  days: number,
  until = new Date().toISOString(),
  useCurrentProviderReports = true,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const [key, value] of audienceGrowthByAccount(backendDb, since, until)) {
    const [platform] = key.split(KEY_SEP);
    if (platform) totals.set(platform, (totals.get(platform) ?? 0) + value);
  }
  if (!useCurrentProviderReports) return totals;
  for (const profile of unsafeDb(backendDb).db.select().from(creatorProfiles).all()) {
    const direct = providerFollowerGrowth(profile.platform, profile.dataJson, days);
    const observed = totals.get(profile.platform);
    // The YouTube daily report is often absent while its response shape still
    // contains zeroes. Preserve a real durable-snapshot delta in that case;
    // a non-zero native report remains the authoritative aggregate.
    if (direct != null && !(direct === 0 && observed != null && observed !== 0)) totals.set(profile.platform, direct);
  }
  return totals;
}

function providerFollowerGrowth(platform: string, data: Record<string, unknown>, days: number): number | null {
  if (platform === "youtube" || platform.startsWith("youtube_")) {
    const suffix = days === 30 ? "" : `${days}d`;
    const gained = data[`subscribersGained${suffix}`];
    const lost = data[`subscribersLost${suffix}`];
    if (gained != null || lost != null) return metricNumber(gained) - metricNumber(lost);
  }
  if ((platform === "instagram" || platform.startsWith("instagram_")) && days === 30) {
    const gained = data.followersGained30d;
    const lost = data.followersLost30d;
    if (gained != null || lost != null) return metricNumber(gained) - metricNumber(lost);
  }
  return null;
}
