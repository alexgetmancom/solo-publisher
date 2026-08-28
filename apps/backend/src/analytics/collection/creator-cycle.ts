import crypto from "node:crypto";
import { listChannels } from "../../channels/registry.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import { recordUsage, type UsageFeatureKey } from "../../observability/usage.js";
import { uniqueAudienceConnections } from "../audience-groups.js";
import { evaluateAudienceMilestones } from "../audience-milestones.js";
import { claimSync } from "../snapshots/creator-store.js";
import { syncCommunityProfiles, syncInstagramProfile, syncXProfile, syncYouTubeProfile, syncZernioChannelProfile } from "./profile-sync.js";
import { runVideoMetricSchedule } from "./video-metrics.js";

/** One step of the cycle. A provider that is permanently broken (an expired
 * YouTube token, say) must not take the rest of the cycle down with it: the loop
 * runner catches per tick, so an unguarded throw here meant video metrics were
 * never collected again until someone noticed. */
async function step(backendDb: BackendDb, name: string, featureKey: UsageFeatureKey, run: () => Promise<unknown>): Promise<number> {
  const startedAt = Date.now();
  try {
    const result = await run();
    const completed = typeof result === "number" ? result : 1;
    // One record per invocation, the unit every other usage key counts.
    // Counting items instead, and skipping a pass that found none, made a
    // Studio with no video channels read as a collector that had stopped.
    recordUsage(backendDb, featureKey, true, Date.now() - startedAt);
    // The timing line stays about work performed: an idle pass has nothing
    // to time and would bury the passes that do.
    if (completed > 0)
      log("info", "operation timing", { operation: featureKey, step: name, success: true, totalMs: Date.now() - startedAt });
    return completed;
  } catch (error) {
    recordUsage(backendDb, featureKey, false, Date.now() - startedAt);
    log("error", "operation timing", {
      operation: featureKey,
      step: name,
      success: false,
      totalMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/** Runs the transport-neutral analytics collection cycle. */
export async function runAnalyticsCycle(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch = fetch): Promise<number> {
  const profileInterval = config.CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS;
  let profiles = 0;
  const channels = uniqueAudienceConnections(listChannels(backendDb));
  for (const channel of channels) {
    const standardProfile = channel.platform === "youtube" || channel.platform === "instagram";
    const profileSupported = standardProfile || (channel.provider === "zernio" && !standardProfile);
    if (!profileSupported) continue;
    const owner = `profile:${channel.id}:${crypto.randomUUID()}`;
    if (!claimSync(backendDb, channel.id, { intervalSeconds: profileInterval, owner })) continue;
    if (channel.platform === "youtube")
      profiles += await step(backendDb, channel.id, "analytics.creator_profile.sync", () =>
        syncYouTubeProfile(config, backendDb, fetchImpl, channel, owner),
      );
    if (channel.platform === "instagram")
      profiles += await step(backendDb, channel.id, "analytics.creator_profile.sync", () =>
        syncInstagramProfile(config, backendDb, fetchImpl, channel, owner),
      );
    if (channel.provider === "zernio" && !standardProfile)
      profiles += await step(backendDb, channel.id, "analytics.creator_profile.sync", () =>
        syncZernioChannelProfile(config, backendDb, fetchImpl, channel, owner),
      );
  }
  const xOwner = `profile:x:${crypto.randomUUID()}`;
  if (
    config.ENABLE_X_PROFILE_METRICS &&
    config.X_CLIENT_ID &&
    config.X_CLIENT_SECRET &&
    config.X_ACCESS_TOKEN &&
    config.X_REFRESH_TOKEN &&
    claimSync(backendDb, "x_profile", { intervalSeconds: profileInterval, owner: xOwner })
  )
    profiles += await step(backendDb, "x_profile", "analytics.creator_profile.sync", () =>
      syncXProfile(config, backendDb, fetchImpl, xOwner),
    );
  const community = [
    ...(config.controllerBotToken ? ["telegram_profile"] : []),
    ...(config.THREADS_RU_ACCESS_TOKEN ? ["threads_profile"] : []),
  ];
  if (community.length > 0)
    profiles += await step(backendDb, "community", "analytics.creator_profile.sync", () =>
      syncCommunityProfiles(config, backendDb, fetchImpl, `community:${crypto.randomUUID()}`),
    );
  evaluateAudienceMilestones(backendDb);
  profiles += await step(backendDb, "video_metrics", "analytics.video_metrics.collect", () =>
    runVideoMetricSchedule(config, backendDb, fetchImpl),
  );
  // A successful collection is worker telemetry, not a creator notification.
  // Keeping it out of the domain event journal prevents every metrics cycle
  // from becoming an unread Inbox item in every Studio interface.
  return profiles;
}
