import { targetRouting } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import { parseIsoInstant } from "../foundation/time.js";
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
  const sampledAt = parseIsoInstant(input.sampledAt);
  const accounts = manualFollowerAccounts(backendDb);
  const profiles = [
    profileInput("threads_ru", accounts.ru, input.threadsRuFollowers),
    profileInput("threads_en", accounts.en, input.threadsEnFollowers),
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

/** The account each Threads target files its snapshots under, or nothing when
 * the target is not connected here.
 *
 * These used to be my two handles, written into the type. Replacing them with
 * the connection's `providerAccountId` took the handles out but put nothing
 * back: a native Threads connection never carries one, so every installation --
 * both of mine included -- asked for a follower count and then refused to
 * record it. The connected target is the identity this Studio actually owns and
 * publishes under, and it is what the snapshot belongs to when the provider
 * offers no account of its own.
 */
function manualFollowerAccounts(backendDb: BackendDb): Record<"ru" | "en", string | null> {
  const routing = targetRouting(backendDb);
  const account = (target: "threads_ru" | "threads_en") => {
    const connection = routing[target];
    return connection ? (connection.accountId ?? target) : null;
  };
  return { ru: account("threads_ru"), en: account("threads_en") };
}
