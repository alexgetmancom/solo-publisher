import { and, desc, eq } from "drizzle-orm";
import type { ChannelConnection } from "../../channels/registry.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { audienceDemographics } from "../../db/schema.js";
import { syncStateFor } from "../snapshots/creator-store.js";
import type { BackendConfig } from "../../foundation/config.js";
import { zernioRequest } from "../../foundation/external/zernio.js";
import { shortenRequestFailure } from "../../foundation/http.js";

/** Instagram describes its audience once a month and delays the answer by up
 * to two days, so a daily read is already more often than the data changes. */
export const DEMOGRAPHICS_INTERVAL_SECONDS = 24 * 60 * 60;

/** Asked one at a time. Meta answers an empty set rather than an error when a
 * breakdown it dislikes is bundled with the others, so a single call for all
 * four could come back blank with nothing to say about which one it choked on. */
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
  note?: string;
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
  const capturedAt = now.toISOString();
  const responses: Array<{ dimension: string; data: DemographicsResponse }> = [];
  const empty: string[] = [];
  for (const dimension of DIMENSIONS) {
    let data: DemographicsResponse;
    try {
      data = await zernioRequest<DemographicsResponse>(
        config,
        `analytics/instagram/demographics?${new URLSearchParams({
          accountId: connection.providerAccountId,
          metric: METRIC,
          breakdown: dimension,
          timeframe: TIMEFRAME,
        })}`,
        fetchImpl,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (UNAVAILABLE.some((pattern) => pattern.test(message))) return { stored: 0, unavailable: shortenRequestFailure(message, 200) };
      throw error;
    }
    if (Object.keys(data.demographics ?? {}).length === 0) {
      // The provider's own note says why far better than a guess would.
      empty.push(data.note ? `${dimension}: ${data.note}` : dimension);
      continue;
    }
    responses.push({ dimension, data });
  }
  const capturedOn = capturedAt.slice(0, 10);
  const rows = responses.flatMap(({ data }) =>
    Object.entries(data.demographics ?? {}).flatMap(([dimension, breakdown]) =>
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
    ),
  );
  if (!rows.length) {
    // An answer that arrived and produced nothing is a shape this code does
    // not know, not an absence -- so it hands back what it actually received
    // rather than a verdict it cannot support.
    const received = responses.map(({ dimension, data }) => `${dimension}=${JSON.stringify(data.demographics ?? {})}`).join(" ");
    const reason = received ? `unreadable shape: ${received.slice(0, 300)}` : empty.join("; ").slice(0, 300) || "no dimensions asked";
    return { stored: 0, unavailable: `the provider returned no breakdown (${reason})` };
  }
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
  return { stored: rows.length, ...(empty.length ? { unavailable: `empty dimensions — ${empty.join("; ").slice(0, 200)}` } : {}) };
}

/** The provider states a breakdown either as a map or as a list of rows, and
 * both spellings appear across its own endpoints. */
function entries(breakdown: unknown): Array<[string, number]> {
  if (Array.isArray(breakdown))
    return breakdown
      .map((item) => {
        const row = item as Record<string, unknown>;
        // The provider names the label `dimension`, which reads like the name
        // of the breakdown rather than a value inside it; the other spellings
        // are what its sibling endpoints use.
        const label = row.dimension ?? row.label ?? row.name ?? row.dimension_value ?? row.key;
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
    // What the collector last said about each account, including the accounts
    // it could not read: an empty report with no explanation is the same
    // silence this whole surface exists to end.
    collection: syncStateFor(backendDb, "demographics:"),
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
            // A percentage arrives scaled to tenths so one decimal survives an
            // integer column; it is handed back as the percentage it is.
            value: row.unit === "percent_tenths" ? row.value / 10 : row.value,
            unit: row.unit,
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
      "YouTube answers about viewers over the last 90 days, Instagram about followers this month: `metric` says which, and `subscribedStatus` is the follower/non-follower split of watch time that Instagram does not report at all.",
    ],
  };
}
