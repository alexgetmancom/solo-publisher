import { queryYouTubeAnalytics, youtubeAnalyticsCompletedEnd, youtubeAnalyticsDate } from "../analytics/collection/youtube-analytics.js";
import {
  deepAnalyticsBucketFor,
  enrichYouTubeDeepAnalytics,
  hasDeepAnalytics,
  snapshotDurationMs,
} from "../analytics/collection/youtube-deep-analytics.js";
import { mergeVideoSnapshot } from "../analytics/snapshots/creator-store.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { channelForVideo } from "../channels/registry.js";
import { youtubeAccessToken } from "../foundation/external/youtube.js";
import { shortenRequestFailure } from "../foundation/http.js";

/** What the owner Analytics report adds on top of the Data API snapshot. A
 * video missing all of these was never enriched. */
const ENRICHED_KEYS = ["averageWatchTimeMs", "completionRate", "subscribersGained"] as const;

type Candidate = {
  videoTargetId: number;
  videoDraftId: number;
  externalId: string;
  locale: "ru" | "en";
  publishedAt: string;
  checkpointIndex: number;
  metrics: Record<string, unknown>;
};

/**
 * Fills in what the owner Analytics API knows about videos already published.
 *
 * Without `apply` it reads: it counts what is missing and makes one real report
 * call per language, so its output is also the answer to whether the connected
 * token reaches the Analytics API at all -- a scope that publishes and reads
 * comments is not automatically a scope that reports.
 */
export async function backfillYouTubeAnalytics(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  input: { days: number; apply: boolean },
): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - input.days * 86_400_000).toISOString();
  const candidates = loadCandidates(backendDb, since);
  const byLocale = { ru: [] as Candidate[], en: [] as Candidate[] };
  for (const candidate of candidates) byLocale[candidate.locale].push(candidate);
  const result: Record<string, unknown> = {};
  let enriched = 0;
  let deepened = 0;
  for (const locale of ["ru", "en"] as const) {
    const localized = byLocale[locale];
    if (!localized.length) continue;
    // A disabled channel is a decision, not a fault: reporting it as an
    // unreachable token would put a permanent red line in a health report.
    if (!channelForVideo(backendDb, "youtube_shorts", locale)?.enabled) {
      result[locale] = { videos: localized.length, skipped: "channel disabled" };
      continue;
    }
    const missingBase = localized.filter((candidate) => ENRICHED_KEYS.every((key) => candidate.metrics[key] == null));
    const missingDeep = localized.filter((candidate) => {
      const bucket = deepAnalyticsBucketFor(candidate.publishedAt);
      return bucket != null && !hasDeepAnalytics(backendDb, candidate.videoTargetId, bucket);
    });
    let token: string;
    try {
      token = await youtubeAccessToken(config, fetchImpl, locale);
    } catch (error) {
      result[locale] = {
        videos: localized.length,
        reachable: false,
        error: describe(full(error)),
        hint: "the stored refresh token could not be exchanged; reconnect the channel",
      };
      continue;
    }
    const report = await readBaseReport(fetchImpl, token, localized).catch((error: unknown) => full(error));
    if (typeof report === "string") {
      result[locale] = {
        videos: localized.length,
        missingBase: missingBase.length,
        missingDeep: missingDeep.length,
        reachable: false,
        error: describe(report),
        hint: hintFor(report),
      };
      continue;
    }
    if (input.apply) {
      for (const candidate of missingBase) {
        const values = report.get(candidate.externalId);
        if (!values) continue;
        mergeVideoSnapshot(backendDb, candidate.videoTargetId, "youtube_shorts", candidate.checkpointIndex, values);
        enriched += 1;
      }
      for (const candidate of missingDeep) {
        const bucket = deepAnalyticsBucketFor(candidate.publishedAt);
        if (bucket == null) continue;
        await enrichYouTubeDeepAnalytics(
          backendDb,
          {
            videoTargetId: candidate.videoTargetId,
            externalId: candidate.externalId,
            checkpointIndex: candidate.checkpointIndex,
            publishedAt: candidate.publishedAt,
            videoDurationMs: snapshotDurationMs(candidate.metrics),
          },
          bucket,
          token,
          fetchImpl,
        );
        deepened += 1;
      }
    }
    result[locale] = {
      videos: localized.length,
      missingBase: missingBase.length,
      missingDeep: missingDeep.length,
      reachable: true,
      reported: report.size,
      sample: [...report.entries()].slice(0, 2).map(([videoId, values]) => ({ videoId, ...values })),
    };
  }
  return {
    window: { days: input.days, since },
    applied: input.apply,
    candidates: candidates.length,
    enriched,
    deepened,
    byLocale: result,
    note: input.apply
      ? "Values were merged into each video's newest snapshot; the checkpoint history before it is untouched."
      : "Nothing was written. `reachable` says whether the connected token can read the Analytics API at all.",
  };
}

function loadCandidates(backendDb: BackendDb, since: string): Candidate[] {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT t.id AS videoTargetId, t.video_draft_id AS videoDraftId, t.external_id AS externalId, d.locale AS locale,
              t.published_at AS publishedAt, s.checkpoint_index AS checkpointIndex, s.metrics_json AS metricsJson
         FROM video_targets t
         JOIN video_drafts d ON d.id = t.video_draft_id
         JOIN video_metric_snapshots s ON s.id = (SELECT MAX(id) FROM video_metric_snapshots WHERE video_target_id = t.id)
        WHERE t.status = 'published' AND t.target = 'youtube_shorts' AND t.external_id IS NOT NULL
          AND t.published_at >= ? AND s.checkpoint_index IS NOT NULL
        ORDER BY t.published_at DESC`,
    )
    .all(since) as Array<Omit<Candidate, "metrics" | "locale"> & { metricsJson: string | null; locale: string }>;
  return rows.map((row) => ({
    ...row,
    locale: row.locale === "en" ? "en" : "ru",
    metrics: row.metricsJson ? (JSON.parse(row.metricsJson) as Record<string, unknown>) : {},
  }));
}

/** The same batched report the collector runs, keyed by video id. */
async function readBaseReport(
  fetchImpl: typeof fetch,
  token: string,
  candidates: Candidate[],
): Promise<Map<string, Record<string, unknown>>> {
  const completedEnd = youtubeAnalyticsCompletedEnd();
  const eligible = candidates.filter((candidate) => new Date(candidate.publishedAt).getTime() <= completedEnd.getTime());
  const values = new Map<string, Record<string, unknown>>();
  if (!eligible.length) return values;
  const startDate = eligible.reduce(
    (earliest, candidate) => (new Date(candidate.publishedAt) < earliest ? new Date(candidate.publishedAt) : earliest),
    new Date(eligible[0]?.publishedAt ?? completedEnd),
  );
  const range = { startDate: youtubeAnalyticsDate(startDate), endDate: youtubeAnalyticsDate(completedEnd) };
  if (range.startDate > range.endDate) return values;
  const ids = eligible.map((candidate) => candidate.externalId);
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const report = await queryYouTubeAnalytics(fetchImpl, token, {
      ...range,
      metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost",
      dimensions: "video",
      filters: `video==${batch.join(",")}`,
      maxResults: 500,
    });
    const headers = (report.columnHeaders ?? []).map((header, index) => header.name ?? `metric_${index}`);
    for (const row of report.rows ?? []) {
      const cells = Object.fromEntries(headers.map((header, index) => [header, row[index]]));
      const videoId = typeof cells.video === "string" ? cells.video : null;
      if (!videoId) continue;
      const gained = Number(cells.subscribersGained ?? 0);
      const lost = Number(cells.subscribersLost ?? 0);
      values.set(videoId, {
        analyticsSource: "youtube_analytics_api",
        averageWatchTimeMs: Number(cells.averageViewDuration ?? 0) * 1_000,
        completionRate: Math.min(100, Math.max(0, Number(cells.averageViewPercentage ?? 0))),
        totalWatchTimeMs: Number(cells.estimatedMinutesWatched ?? 0) * 60_000,
        subscribersGained: gained,
        subscribersLost: lost,
        follows: gained - lost,
      });
    }
  }
  return values;
}

function full(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const describe = shortenRequestFailure;

/** What an operator should do about it, decided by what the API answered
 * rather than by guesswork. Read from the whole message: the part that names
 * the reason sits at the end, past a URL long enough to hide it. */
function hintFor(message: string): string {
  if (message.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT"))
    return "the token cannot read the Analytics API: reconnect the channel so it also carries yt-analytics.readonly";
  const status = /failed: (\d{3})/.exec(message)?.[1];
  if (status === "403")
    return "the token cannot read the Analytics API: reconnect the channel asking for yt-analytics.readonly alongside youtube.force-ssl";
  if (status === "401") return "the token expired or was revoked: reconnect the channel";
  return `the Analytics API refused this report${status ? ` with ${status}` : ""}`;
}
