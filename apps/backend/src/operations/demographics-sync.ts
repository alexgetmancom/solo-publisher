import { syncInstagramDemographics } from "../analytics/collection/instagram-demographics.js";
import { syncYouTubeDemographics } from "../analytics/collection/youtube-demographics.js";
import { markSynced } from "../analytics/snapshots/creator-store.js";
import { uniqueAudienceConnections } from "../analytics/audience-groups.js";
import { listChannels } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";

/**
 * Reads the audience breakdowns now, whatever the daily schedule thinks.
 *
 * The collector runs once a day per account, which is right for data that
 * changes monthly and wrong for the hour after a fix ships: without this, the
 * only way to see whether a change worked was to wait for tomorrow.
 */
export async function syncAudienceDemographics(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  input: { apply: boolean },
): Promise<Record<string, unknown>> {
  const accounts = uniqueAudienceConnections(listChannels(backendDb)).filter(
    (channel) => channel.platform === "youtube" || (channel.platform === "instagram" && channel.provider === "zernio"),
  );
  const results: Array<Record<string, unknown>> = [];
  for (const channel of accounts) {
    if (!input.apply) {
      results.push({ account: channel.id, platform: channel.platform, wouldRead: true });
      continue;
    }
    const source = `demographics:${channel.id}`;
    try {
      const result =
        channel.platform === "youtube"
          ? await syncYouTubeDemographics(config, backendDb, fetchImpl, channel)
          : await syncInstagramDemographics(config, backendDb, fetchImpl, channel);
      markSynced(backendDb, source, result.unavailable ?? null);
      results.push({
        account: channel.id,
        platform: channel.platform,
        stored: result.stored,
        ...(result.unavailable ? { unavailable: result.unavailable } : {}),
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      markSynced(backendDb, source, message);
      results.push({ account: channel.id, platform: channel.platform, stored: 0, error: message });
    }
  }
  return { applied: input.apply, accounts: accounts.length, results };
}
