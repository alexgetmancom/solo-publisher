import { requestJson } from "../../foundation/http.js";

type YouTubeAnalyticsReport = {
  columnHeaders?: Array<{ name?: string }>;
  rows?: Array<Array<string | number>>;
};

type YouTubeDateParts = { year: string; month: string; day: string };

const YOUTUBE_ANALYTICS_TIME_ZONE = "America/Los_Angeles";

/** Builds a completed-date range in the timezone used by YouTube Analytics. */
export function youtubeAnalyticsDateRange(days: number, now = new Date()): { startDate: string; endDate: string } {
  const completedEnd = youtubeAnalyticsCompletedEnd(now);
  const start = new Date(completedEnd);
  start.setUTCDate(start.getUTCDate() - Math.max(1, days) + 1);
  return { startDate: start.toISOString().slice(0, 10), endDate: completedEnd.toISOString().slice(0, 10) };
}

/** Returns the last calendar date for which a YouTube report can be complete. */
export function youtubeAnalyticsCompletedEnd(now = new Date()): Date {
  const parts = youtubeAnalyticsDateParts(now);
  const completedEnd = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  completedEnd.setUTCDate(completedEnd.getUTCDate() - 1);
  return completedEnd;
}

/** Formats an instant as a YouTube Analytics calendar date in Pacific time. */
export function youtubeAnalyticsDate(value: Date): string {
  const parts = youtubeAnalyticsDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function queryYouTubeAnalytics(
  fetchImpl: typeof fetch,
  token: string,
  input: {
    startDate: string;
    endDate: string;
    metrics: string;
    dimensions?: string;
    filters?: string;
    maxResults?: number;
  },
): Promise<YouTubeAnalyticsReport> {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", input.startDate);
  url.searchParams.set("endDate", input.endDate);
  url.searchParams.set("metrics", input.metrics);
  if (input.dimensions) url.searchParams.set("dimensions", input.dimensions);
  if (input.filters) url.searchParams.set("filters", input.filters);
  if (input.maxResults != null) url.searchParams.set("maxResults", String(input.maxResults));
  return requestJson<YouTubeAnalyticsReport>(fetchImpl, url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function youtubeAnalyticsDateParts(value: Date): YouTubeDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: YOUTUBE_ANALYTICS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(value)
    .reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
  return {
    year: parts.year ?? "0000",
    month: parts.month ?? "01",
    day: parts.day ?? "01",
  };
}

/** Where a Short's views came from, as YouTube groups them. One video per
 * call: the traffic-source dimension cannot be split by video in a batch the
 * way the plain metrics report can. */
export async function youtubeTrafficSources(
  fetchImpl: typeof fetch,
  token: string,
  videoId: string,
  range: { startDate: string; endDate: string },
): Promise<Record<string, number>> {
  const report = await queryYouTubeAnalytics(fetchImpl, token, {
    ...range,
    metrics: "views",
    dimensions: "insightTrafficSourceType",
    filters: `video==${videoId}`,
    maxResults: 50,
  });
  const sources: Record<string, number> = {};
  for (const row of report.rows ?? []) {
    const [name, views] = row;
    if (typeof name === "string") sources[name] = Number(views ?? 0);
  }
  return sources;
}

/** The retention curve, sampled by YouTube at percentages of the video. The
 * first seconds are the whole question for a Short, so the caller converts the
 * ratios it wants using the video's own duration. */
export async function youtubeAudienceRetention(
  fetchImpl: typeof fetch,
  token: string,
  videoId: string,
  range: { startDate: string; endDate: string },
): Promise<Array<{ ratio: number; watchRatio: number }>> {
  const report = await queryYouTubeAnalytics(fetchImpl, token, {
    ...range,
    metrics: "audienceWatchRatio",
    dimensions: "elapsedVideoTimeRatio",
    filters: `video==${videoId};audienceType==ORGANIC`,
    maxResults: 200,
  });
  return (report.rows ?? [])
    .map((row) => ({ ratio: Number(row[0] ?? 0), watchRatio: Number(row[1] ?? 0) }))
    .filter((point) => Number.isFinite(point.ratio) && Number.isFinite(point.watchRatio))
    .sort((left, right) => left.ratio - right.ratio);
}

/** Retention at the seconds a Short is won or lost in, read off the curve.
 * Returns null where the video is too short for that second to exist. */
export function retentionAtSeconds(
  curve: Array<{ ratio: number; watchRatio: number }>,
  videoDurationMs: number | null,
  seconds: number[],
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const second of seconds) {
    const key = `retentionAt${second}s`;
    if (!curve.length || !videoDurationMs || videoDurationMs <= 0) {
      result[key] = null;
      continue;
    }
    const ratio = (second * 1_000) / videoDurationMs;
    if (ratio > 1) {
      result[key] = null;
      continue;
    }
    const point = curve.reduce((closest, candidate) =>
      Math.abs(candidate.ratio - ratio) < Math.abs(closest.ratio - ratio) ? candidate : closest,
    );
    result[key] = Math.round(point.watchRatio * 1000) / 10;
  }
  return result;
}
