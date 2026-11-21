import { targetRouting } from "../../apps/backend/src/channels/registry.js";
import { unsafeDb } from "../../apps/backend/src/db/client.js";
import { editPublishedTargets } from "../../apps/backend/src/delivery/external-edits.js";
import { attemptPublishedTargetRemovals, settlePublishedTargetRemovals } from "../../apps/backend/src/delivery/external-removals.js";
import { pruneMediaCache } from "../../apps/backend/src/delivery/media-prepare.js";
import { createPlatformPorts } from "../../apps/backend/src/delivery/ports/social.js";
import { runPublicationReconciliation } from "../../apps/backend/src/delivery/publication-reconciliation.js";
import { runDeliveryPublishCycle } from "../../apps/backend/src/delivery/publish-workflow.js";
import { awaitPreparedStoryMedia, ensureStoryDerivative } from "../../apps/backend/src/delivery/story-derivatives.js";
import { pruneOperationalHistory, withMaintenanceLock } from "../../apps/backend/src/operations/maintenance.js";
import { recoverStalePublishJobs } from "../../apps/backend/src/publishing/queue.js";
import { type Call, listFiles, runScenarios } from "./delivery-scenario-support.js";

/**
 * The TypeScript side of crates/delivery/tests/delivery_scenarios.rs: the
 * publish workflow, publication reconciliation, external edits and removals,
 * and the maintenance sweeps, each through the real module over the
 * recording fetch of delivery-scenario-support.ts.
 *
 *   bun scripts/rust/delivery-scenarios.ts crates/delivery/tests/delivery_scenarios.json
 */

const call: Call = async ({ backendDb, config, fetchImpl, data }, name, args) => {
  switch (name) {
    case "publishCycle":
      return runDeliveryPublishCycle(config, backendDb, createPlatformPorts(config, fetchImpl, targetRouting(backendDb)));
    case "recoverStale":
      return recoverStalePublishJobs(backendDb, ...(args.length ? [args[0] as number] : []));
    case "reconcile":
      return runPublicationReconciliation(backendDb, config, fetchImpl);
    case "editTargets":
      return editPublishedTargets(backendDb, args[0] as Parameters<typeof editPublishedTargets>[1], config, fetchImpl);
    case "removeTargets": {
      // The caller's shape: the remote removals first, then their settlement
      // inside the transaction that journals it.
      const attempts = await attemptPublishedTargetRemovals(
        backendDb,
        config,
        args[0] as Parameters<typeof attemptPublishedTargetRemovals>[2],
        fetchImpl,
      );
      return unsafeDb(backendDb).db.transaction((tx) => {
        const results = settlePublishedTargetRemovals(tx, attempts);
        backendDb.events.record({
          ref: (args[0] as { publicationKey: string }).publicationKey,
          type: "operations.removal",
          severity: "info",
          message: "removed",
          details: { results },
        });
        return results;
      });
    }
    case "maintenance":
      return withMaintenanceLock(backendDb, () => pruneOperationalHistory(backendDb));
    case "pruneMediaCache":
      return pruneMediaCache(config);
    case "ensureStory":
      return ensureStoryDerivative(config, args[0] as string, args[1] as boolean, { source: "scenario" }, (args[2] as boolean) ?? false);
    case "preparedStory":
      return awaitPreparedStoryMedia(config, args[0] as Parameters<typeof awaitPreparedStoryMedia>[1]);
    case "files":
      return listFiles(data);
    default:
      throw new Error(`unknown call ${name}`);
  }
};

await runScenarios("delivery", call);
