import { runAnalyticsCycle } from "../analytics/collection/creator-cycle.js";
import { runMetricsCycle } from "../analytics/collection/metrics-cycle.js";
import { pruneMetricSamples } from "../analytics/snapshots/metric-repository.js";
import { redeemDeviceAuthorizations } from "../channels/connect.js";
import { renewMetaTokens } from "../channels/meta-tokens.js";
import { targetRouting } from "../channels/registry.js";
import { refreshXToken } from "../channels/x-oauth.js";
import type { BackendDb } from "../db/client.js";
import { pruneMediaCache } from "../delivery/media-prepare.js";
import { createPlatformPorts } from "../delivery/ports/social.js";
import { runPublicationReconciliation } from "../delivery/publication-reconciliation.js";
import { runDeliveryPublishCycle } from "../delivery/publish-workflow.js";
import { recoverStaleSiteJobs, runSiteJobCycle, SITE_JOB_RESTART_LOCK_GRACE_SECONDS } from "../delivery/site-jobs.js";
import { runVideoCycle } from "../delivery/video-worker.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { heartbeatLoop } from "../foundation/runtime/worker-state.js";
import { type ScheduledLoop, startLoop } from "../foundation/scheduler.js";
import { setWorkerWake } from "../foundation/worker-signal.js";
import { runNotificationCycle } from "../notifications/jobs.js";
import { runObservabilityCycle } from "../observability/cycle.js";
import { flushUsage } from "../observability/usage.js";
import { pruneOperationalHistory, withMaintenanceLock } from "../operations/maintenance.js";
import { recoverStalePublishJobs } from "../publishing/queue.js";
import { recoverStoryCardJobs, runStoryCardCycle } from "../story-cards/worker.js";
import { applyStoredCredentials } from "./config.js";

const WATCHDOG_INTERVAL_SECONDS = 60;
const SITE_JOB_POLL_INTERVAL_SECONDS = 10;
const PROFILE_POLL_INTERVAL_SECONDS = 300;
const PUBLISH_RESTART_LOCK_GRACE_SECONDS = 30;

async function runTimedCycle(
  operation: string,
  countName: "claimed" | "checked" | "completed",
  cycle: () => Promise<number>,
): Promise<void> {
  const startedAt = Date.now();
  const count = await cycle();
  if (count) log("info", "operation timing", { operation, success: true, totalMs: Date.now() - startedAt, [countName]: count });
}

/** Starts domain workers only. It deliberately has no Telegram or HTTP dependency. */
export function startCoreWorkers(config: BackendConfig, backendDb: BackendDb): ScheduledLoop[] {
  // Deployment/server restarts terminate the old process but leave its durable
  // locks behind. Do not wait the ordinary 15-minute crash TTL before the new
  // process can resume the same targets; the short grace still avoids racing a
  // request that was only just interrupted at the provider boundary.
  const recoveredAtStartup = recoverStalePublishJobs(backendDb, PUBLISH_RESTART_LOCK_GRACE_SECONDS);
  if (recoveredAtStartup) log("warn", "recovered interrupted publishing locks on worker startup", { recovered: recoveredAtStartup });
  // Unconditional, like the loops below: a Studio whose site was turned off
  // after a crash still owns the locks that crash left behind.
  const recoveredSiteAtStartup = recoverStaleSiteJobs(backendDb, SITE_JOB_RESTART_LOCK_GRACE_SECONDS);
  if (recoveredSiteAtStartup)
    log("warn", "recovered interrupted site build locks on worker startup", { recovered: recoveredSiteAtStartup });
  const recoveredStoryCardsAtStartup = recoverStoryCardJobs(backendDb);
  if (recoveredStoryCardsAtStartup)
    log("warn", "recovered interrupted Story card locks on worker startup", { recovered: recoveredStoryCardsAtStartup });
  const startWorkerLoop = heartbeatLoop(backendDb, startLoop, () => flushUsage(backendDb));
  // The one loop a person waits on. Everything else here runs on its interval;
  // this one is also rung the moment a publication puts work in the table.
  const publishQueueLoop = startWorkerLoop("queue", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
    await runTimedCycle("publishing.social.cycle", "claimed", () =>
      runDeliveryPublishCycle(config, backendDb, createPlatformPorts(config, fetch, targetRouting(backendDb))),
    );
  });
  setWorkerWake("publish", publishQueueLoop.wake);
  return [
    // Meta renews its long-lived tokens by issuing new ones, and a lapsed token
    // cannot be renewed at all — so this runs far from the edge, daily, and
    // renews anything a month old rather than waiting for the deadline.
    startWorkerLoop("platform-tokens", 6 * 60 * 60 * 1000, async () => {
      const outcomes = await renewMetaTokens(config, backendDb);
      const renewed = outcomes.filter((outcome) => outcome.status === "renewed");
      if (renewed.length) log("info", "platform tokens renewed", { targets: renewed.map((outcome) => outcome.target) });
    }),
    // Cheap and frequent on purpose: three reads of one table, so a credential
    // an operator stores reaches the workers within a minute instead of at the
    // next restart.
    startWorkerLoop("credentials", 60 * 1000, async () => {
      applyStoredCredentials(config, backendDb);
      const connected = await redeemDeviceAuthorizations(config, backendDb);
      if (connected) log("info", "device authorizations completed", { connected });
    }),
    startWorkerLoop("x-token", 10 * 60 * 1000, async () => {
      const outcome = await refreshXToken(config, backendDb);
      if (outcome === "refreshed") log("info", "X access token refreshed");
    }),
    startWorkerLoop("story-cards", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
      await runTimedCycle("content.story_card.cycle", "claimed", () => runStoryCardCycle(config, backendDb));
    }),
    publishQueueLoop,
    startWorkerLoop("publish-watchdog", WATCHDOG_INTERVAL_SECONDS * 1000, async () => {
      // Independent from delivery: a hung provider promise must not prevent
      // stale publishing locks from returning to the bounded retry policy.
      const recovered = recoverStalePublishJobs(backendDb);
      if (recovered) log("warn", "recovered stale publishing locks", { recovered });
    }),
    startWorkerLoop("publication-reconciliation", Math.max(60, config.IDLE_POLL_INTERVAL_SECONDS) * 1000, async () => {
      const result = await runPublicationReconciliation(backendDb, config);
      log("debug", "publication reconciliation loop tick", result);
    }),
    startWorkerLoop("notifications", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
      const delivered = runNotificationCycle(backendDb);
      log("debug", "notification loop tick", { delivered });
    }),
    startWorkerLoop("video", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
      await runTimedCycle("publishing.video.cycle", "claimed", () => runVideoCycle(config, backendDb));
    }),
    // Two independent collectors on one schedule. They do not share a
    // failure: a provider outage on one must not silently stop the other.
    startWorkerLoop("metrics", config.METRICS_REFRESH_INTERVAL_SECONDS * 1000, async () => {
      await runTimedCycle("analytics.metrics.cycle", "checked", () => runMetricsCycle(config, backendDb));
    }),
    startWorkerLoop("creator-analytics", PROFILE_POLL_INTERVAL_SECONDS * 1000, async () => {
      await runTimedCycle("analytics.creator_cycle", "completed", () => runAnalyticsCycle(config, backendDb));
    }),
    // Retention is a housekeeping concern, not a collection one: it used
    // to run on every metrics tick (10s by default), scanning
    // metric_samples for a window that moves by a day at a time.
    startWorkerLoop("metric-retention", 60 * 60 * 1000, async () => {
      try {
        pruneMetricSamples(backendDb);
      } catch (error) {
        log("error", "failed to prune old metric samples", { error: error instanceof Error ? error.message : String(error) });
      }
    }),
    // Started whether or not this Studio serves a site, and idle while it does
    // not. Deciding at startup meant turning the site on left the pages served
    // — those are read per request — with nothing building them until someone
    // restarted the container, which is a seam an operator cannot see.
    startWorkerLoop("site", SITE_JOB_POLL_INTERVAL_SECONDS * 1000, async () => {
      if (!config.studio.siteEnabled) return;
      await runTimedCycle("publishing.site.cycle", "claimed", () => runSiteJobCycle(config, backendDb));
    }),
    startWorkerLoop("site-watchdog", WATCHDOG_INTERVAL_SECONDS * 1000, async () => {
      if (!config.studio.siteEnabled) return;
      const recovered = recoverStaleSiteJobs(backendDb);
      if (recovered) log("warn", "recovered stale site build locks", { recovered });
    }),
    startWorkerLoop("media-cache", 60 * 60 * 1000, async () => {
      const removed = await pruneMediaCache(config);
      if (removed) log("info", "pruned expired media cache", { removed });
    }),
    startWorkerLoop("operational-retention", 24 * 60 * 60 * 1000, async () => {
      const result = withMaintenanceLock(backendDb, () => pruneOperationalHistory(backendDb));
      if (result.total) log("info", "pruned operational history", result);
    }),
    startWorkerLoop("observability", config.OBSERVABILITY_INTERVAL_SECONDS * 1000, async () => {
      const result = await runObservabilityCycle(config, backendDb);
      log("debug", "observability loop tick", result);
    }),
  ];
}
