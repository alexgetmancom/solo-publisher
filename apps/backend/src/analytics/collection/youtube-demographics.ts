import type { ChannelConnection } from "../../channels/registry.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { audienceDemographics } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { youtubeAccessToken } from "../../foundation/external/youtube.js";
import { queryYouTubeAnalytics, youtubeAnalyticsDateRange } from "./youtube-analytics.js";

/** A channel's audience shifts over months, not hours. */
export const YOUTUBE_DEMOGRAPHICS_INTERVAL_SECONDS = 24 * 60 * 60;

/** The window the breakdowns describe. Ninety days is what YouTube Studio's
 * own audience tab defaults to, and it is long enough that a single viral
 * Short cannot redraw the age curve. */
const WINDOW_DAYS = 90;

/** Percentages arrive with one decimal that matters: 8.4% of viewers is not
 * 8%. Stored as tenths, with the unit on the row saying so. */
const PERCENT_SCALE = 10;

type Report = { columnHeaders?: Array<{ name?: string }>; rows?: Array<Array<string | number>> };

/** Three questions YouTube will answer about who watched, and the dimension
 * each one is asked with. `subscribedStatus` is the split Instagram refuses to
 * give at all: how much of the watching came from people who follow. */
const QUERIES = [
  { dimension: "ageGroup", metrics: "viewerPercentage", unit: "percent_tenths" },
  { dimension: "gender", metrics: "viewerPercentage", unit: "percent_tenths" },
  { dimension: "country", metrics: "views", unit: "count" },
  { dimension: "subscribedStatus", metrics: "views", unit: "count" },
] as const;

export type YouTubeDemographicsResult = { stored: number; unavailable?: string };

/** Reads who watched this channel and stores it beside the Instagram answer,
 * in the same dated shape. */
export async function syncYouTubeDemographics(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch,
  connection: ChannelConnection,
  now = new Date(),
): Promise<YouTubeDemographicsResult> {
  const locale = connection.locale === "en" ? "en" : "ru";
  const token = await youtubeAccessToken(config, fetchImpl, locale);
  const range = youtubeAnalyticsDateRange(WINDOW_DAYS, now);
  const capturedAt = now.toISOString();
  const capturedOn = capturedAt.slice(0, 10);
  const rows: Array<typeof audienceDemographics.$inferInsert> = [];
  for (const query of QUERIES) {
    const report: Report = await queryYouTubeAnalytics(fetchImpl, token, {
      ...range,
      metrics: query.metrics,
      dimensions: query.dimension,
      maxResults: 50,
    });
    const headers = (report.columnHeaders ?? []).map((header) => header.name ?? "");
    const labelIndex = headers.indexOf(query.dimension);
    const valueIndex = headers.indexOf(query.metrics);
    for (const row of report.rows ?? []) {
      const label = String(row[labelIndex === -1 ? 0 : labelIndex] ?? "");
      const raw = Number(row[valueIndex === -1 ? 1 : valueIndex] ?? 0);
      if (!label || !Number.isFinite(raw)) continue;
      rows.push({
        platform: connection.id,
        account: connection.label,
        metric: "viewer_demographics",
        dimension: query.dimension,
        label,
        value: Math.round(query.unit === "percent_tenths" ? raw * PERCENT_SCALE : raw),
        unit: query.unit,
        timeframe: `${range.startDate}..${range.endDate}`,
        capturedOn,
        capturedAt,
        source: "youtube_analytics_api",
      });
    }
  }
  if (!rows.length) return { stored: 0, unavailable: "YouTube reported no audience rows for this window" };
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const row of rows)
      tx.insert(audienceDemographics)
        .values(row)
        .onConflictDoUpdate({
          target: [
            audienceDemographics.platform,
            audienceDemographics.account,
            audienceDemographics.metric,
            audienceDemographics.dimension,
            audienceDemographics.label,
            audienceDemographics.capturedOn,
          ],
          set: { value: row.value, unit: row.unit, capturedAt: row.capturedAt, timeframe: row.timeframe },
        })
        .run();
  });
  return { stored: rows.length };
}
