import { and, desc, eq } from "drizzle-orm";
import type { ChannelConnection } from "../../channels/registry.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { audienceDemographics } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { zernioRequest } from "../../foundation/external/zernio.js";
import { shortenRequestFailure } from "../../foundation/http.js";

/** Instagram describes its audience once a month and delays the answer by up
 * to two days, so a daily read is already more often than the data changes. */
export const DEMOGRAPHICS_INTERVAL_SECONDS = 24 * 60 * 60;

const DIMENSIONS = ["age", "city", "country", "gender"] as const;
const METRIC = "follower_demographics";
const TIMEFRAME = "this_month";

/** Instagram refuses demographics for a small account, and the plan may not
 * carry the analytics add-on. Neither is a fault to alert on: the answer is
 * simply "not available for this account", and it will stay that way until the
 * account grows or the plan changes. */
const UNAVAILABLE = [/100\+? followers/iu, /at least 100/iu, /analytics.add.?on/iu, /not enough/iu];

type DemographicsResponse = {
  metric?: string;
  timeframe?: string;
  demographics?: Record<string, unknown>;
};

export type DemographicsResult = { stored: number; unavailable?: string };

/** Reads one Instagram account's audience breakdown and stores it as a dated
 * capture, the way every other audience observation here is stored. */
export async function syncInstagramDemographics(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch,
  connection: ChannelConnection,
  now = new Date(),
): Promise<DemographicsResult> {
  if (!connection.providerAccountId) return { stored: 0, unavailable: "the channel carries no provider account id" };
  let data: DemographicsResponse;
  try {
    data = await zernioRequest<DemographicsResponse>(
      config,
      `analytics/instagram/demographics?${new URLSearchParams({
        accountId: connection.providerAccountId,
        metric: METRIC,
        breakdown: DIMENSIONS.join(","),
        timeframe: TIMEFRAME,
      })}`,
      fetchImpl,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (UNAVAILABLE.some((pattern) => pattern.test(message))) return { stored: 0, unavailable: shortenRequestFailure(message, 200) };
    throw error;
  }
  const capturedAt = now.toISOString();
  const capturedOn = capturedAt.slice(0, 10);
  const rows = Object.entries(data.demographics ?? {}).flatMap(([dimension, breakdown]) =>
    entries(breakdown).map(([label, value]) => ({
      platform: connection.id,
      account: connection.label,
      metric: data.metric ?? METRIC,
      dimension,
      label,
      value,
      timeframe: data.timeframe ?? TIMEFRAME,
      capturedOn,
      capturedAt,
      source: "zernio_instagram_demographics",
    })),
  );
  if (!rows.length) return { stored: 0, unavailable: "the provider returned no breakdown" };
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
          set: { value: row.value, capturedAt: row.capturedAt, timeframe: row.timeframe },
        })
        .run();
  });
  return { stored: rows.length };
}

/** The provider states a breakdown either as a map or as a list of rows, and
 * both spellings appear across its own endpoints. */
function entries(breakdown: unknown): Array<[string, number]> {
  if (Array.isArray(breakdown))
    return breakdown
      .map((item) => {
        const row = item as Record<string, unknown>;
        const label = row.label ?? row.name ?? row.dimension_value ?? row.key;
        const value = row.value ?? row.count ?? row.total;
        return [String(label ?? ""), Math.round(Number(value ?? 0))] as [string, number];
      })
      .filter(([label, value]) => label !== "" && Number.isFinite(value));
  if (breakdown && typeof breakdown === "object")
    return Object.entries(breakdown as Record<string, unknown>)
      .map(([label, value]) => [label, Math.round(Number(value ?? 0))] as [string, number])
      .filter(([, value]) => Number.isFinite(value));
  return [];
}

/** The newest capture per account, with each dimension ordered by size. */
export function audienceDemographicsReport(backendDb: BackendDb): Record<string, unknown> {
  const captures = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT platform, account, metric, MAX(captured_on) AS capturedOn FROM audience_demographics GROUP BY platform, account, metric`,
    )
    .all() as Array<{ platform: string; account: string; metric: string; capturedOn: string }>;
  return {
    captures: captures.map((capture) => {
      const rows = unsafeDb(backendDb)
        .db.select()
        .from(audienceDemographics)
        .where(
          and(
            eq(audienceDemographics.platform, capture.platform),
            eq(audienceDemographics.account, capture.account),
            eq(audienceDemographics.metric, capture.metric),
            eq(audienceDemographics.capturedOn, capture.capturedOn),
          ),
        )
        .orderBy(desc(audienceDemographics.value))
        .all();
      const dimensions = new Map<string, Array<{ label: string; value: number; share: number }>>();
      for (const dimension of new Set(rows.map((row) => row.dimension))) {
        const inDimension = rows.filter((row) => row.dimension === dimension);
        const total = inDimension.reduce((sum, row) => sum + row.value, 0);
        dimensions.set(
          dimension,
          inDimension.map((row) => ({
            label: row.label,
            value: row.value,
            share: total ? Math.round((row.value / total) * 1000) / 10 : 0,
          })),
        );
      }
      return {
        ...capture,
        capturedAt: rows[0]?.capturedAt ?? null,
        timeframe: rows[0]?.timeframe ?? null,
        source: rows[0]?.source ?? null,
        dimensions: Object.fromEntries(dimensions),
      };
    }),
    reading: [
      "This describes the people who follow the account, not the people who watched a given video — on Reels most views come from accounts that follow nothing.",
      "Instagram computes it over a month and delays it by up to two days, so a change since yesterday is noise, not a trend.",
      "Cities and countries are the top 45 entries per dimension; a long tail is cut off and the shares are shares of what is listed.",
    ],
  };
}
