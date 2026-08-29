import { targetRouting } from "../channels/registry.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { creatorProfiles } from "../db/schema.js";
import { importXAnalyticsCsv, type XCsvImportResult } from "./import-x-csv.js";
import { recordProfileSnapshot } from "./snapshots/creator-store.js";

type ManualAnalyticsInput = {
  sampledAt: string;
  xFile?: string;
  threadsRuFollowers?: number;
  threadsEnFollowers?: number;
};

type ManualProfileResult = {
  platform: "threads_ru" | "threads_en";
  /** The connected account the snapshot belongs to. It is read from the channel
   * registry rather than named here: a snapshot filed under a handle this
   * installation does not own is analytics for somebody else's audience. */
  account: string;
  followersCount: number;
};

type ManualAnalyticsImportResult = {
  sampledAt: string;
  x: XCsvImportResult | null;
  profiles: ManualProfileResult[];
};

/** Records one operator-supplied weekly observation without coupling the flow
 * to Telegram or requiring ad-hoc SQL against production. */
export function importManualAnalytics(backendDb: BackendDb, input: ManualAnalyticsInput): ManualAnalyticsImportResult {
  const sampledAt = new Date(input.sampledAt);
  if (Number.isNaN(sampledAt.getTime())) throw new Error("--sampled-at must be an ISO timestamp");
  const routing = targetRouting(backendDb);
  const profiles = [
    profileInput("threads_ru", routing.threads_ru?.accountId, input.threadsRuFollowers),
    profileInput("threads_en", routing.threads_en?.accountId, input.threadsEnFollowers),
  ].filter((profile): profile is ManualProfileResult => profile != null);
  if (!input.xFile && profiles.length === 0) throw new Error("provide --x-file, --threads-ru-followers, or --threads-en-followers");

  const x = input.xFile ? importXAnalyticsCsv(backendDb, input.xFile, sampledAt.toISOString()) : null;
  for (const profile of profiles)
    recordProfileSnapshot(backendDb, {
      platform: profile.platform,
      account: profile.account,
      metrics: { name: profile.account, followersCount: profile.followersCount, manual: true },
      source: "manual_cli",
      sampledAt,
    });
  return { sampledAt: sampledAt.toISOString(), x, profiles };
}

function profileInput(
  platform: ManualProfileResult["platform"],
  account: string | null | undefined,
  value: number | undefined,
): ManualProfileResult | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`--${platform.replaceAll("_", "-")}-followers must be a non-negative integer`);
  if (!account) throw new Error(`connect the ${platform.replace("_", " ")} channel before importing its follower count`);
  return { platform, account, followersCount: value };
}

export type ThreadsFollowersState = { ru: number | null; en: number | null; updatedAt: string | null };

/** The audience numbers the manual import owns, for a screen that offers to
 * change them. Threads has no API here: what was typed in last is the truth. */
export function manualThreadsFollowers(backendDb: BackendDb): ThreadsFollowersState {
  const rows = unsafeDb(backendDb)
    .db.select()
    .from(creatorProfiles)
    .all()
    .filter((row) => row.platform === "threads_ru" || row.platform === "threads_en");
  const value = (platform: string): number | null => {
    const followers = rows.find((row) => row.platform === platform)?.dataJson.followersCount;
    return typeof followers === "number" ? followers : null;
  };
  return {
    ru: value("threads_ru"),
    en: value("threads_en"),
    updatedAt:
      rows
        .map((row) => row.updatedAt)
        .sort()
        .at(-1) ?? null,
  };
}
