import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../../db/client.js";
import { recordEvent } from "../../db/repositories/events.js";
import type { JsonValue } from "../../db/schema.js";
import { recordObservedPublicationUrl } from "../../delivery/observed-publication.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import { recordWorkerState } from "../../foundation/runtime/worker-state.js";
import { ALERT_COOLDOWN_SECONDS } from "../../observability/alerts.js";
import { trackUsageAsync } from "../../observability/usage.js";
import { platformAnalyticsProfile } from "../../publishing/platform-profiles.js";
import { upsertMetricError, upsertMetrics } from "../snapshots/metric-repository.js";
import { isTerminalMetricError } from "./collectors/errors.js";
import { createMetricCollectors, SUPPORTED_METRIC_TARGETS } from "./collectors/index.js";
import type { MetricCollector } from "./collectors/types.js";
import {
  claimDueMetricTasks,
  ensureMetricSchedule,
  finishMetricTask,
  freezeDisabledMetricSchedules,
  freezeUnsupportedMetricSchedules,
} from "./metric-schedule.js";

export async function runMetricsCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  collectors: Record<string, MetricCollector> = createMetricCollectors(config),
): Promise<number> {
  // One list drives creation, retirement and claiming. Deriving them separately let a
  // target be collected but never scheduled, or scheduled but never collected.
  const collectableTargets = Object.keys(collectors).filter((target) => platformAnalyticsProfile(target).enabled);
  ensureMetricSchedule(backendDb, collectableTargets);
  freezeUnsupportedMetricSchedules(backendDb, SUPPORTED_METRIC_TARGETS);
  freezeDisabledMetricSchedules(backendDb, [...(config.ENABLE_X_METRICS ? [] : ["x"])]);
  const tasks = claimDueMetricTasks(backendDb, config, collectableTargets);
  for (const task of tasks) {
    const collector = collectors[task.target];
    if (!collector) continue;
    try {
      await trackUsageAsync(backendDb, "analytics.metrics.collect", async () => {
        const startedAt = Date.now();
        let providerMs = 0;
        let persistMs = 0;
        let metricCount = 0;
        let success = false;
        let failure: unknown;
        try {
          const providerStartedAt = Date.now();
          let result: Awaited<ReturnType<MetricCollector>>;
          try {
            result = await collector(task);
          } finally {
            providerMs = Date.now() - providerStartedAt;
          }
          metricCount = Object.keys(result.metrics).length;
          const persistStartedAt = Date.now();
          unsafeDb(backendDb).db.transaction((tx) => {
            upsertMetrics(
              backendDb,
              task.publicationKey,
              task.target,
              result.metrics,
              result.source,
              result.raw,
              tx as UnsafeBackendDb["db"],
            );
            if (result.url)
              recordObservedPublicationUrl(
                tx as UnsafeBackendDb["db"],
                task.publicationKey,
                task.target,
                result.url,
                new Date().toISOString(),
              );
            finishMetricTask(backendDb, task, null, false, tx as UnsafeBackendDb["db"]);
          });
          persistMs = Date.now() - persistStartedAt;
          success = true;
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          log(success ? "info" : "warn", "operation timing", {
            operation: "analytics.metrics.collect",
            target: task.target,
            success,
            totalMs: Date.now() - startedAt,
            providerMs,
            persistMs,
            metricCount,
            ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
          });
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal = isTerminalMetricError(error);
      unsafeDb(backendDb).db.transaction((transactionDb) => {
        upsertMetricError(
          backendDb,
          task.publicationKey,
          task.target,
          `${task.target}_metrics`,
          message,
          {
            external_id: task.externalId,
          } as JsonValue,
          transactionDb as UnsafeBackendDb["db"],
        );
        finishMetricTask(backendDb, task, message, terminal, transactionDb as UnsafeBackendDb["db"]);
        // Journalled in the transaction that records the failure, the way a
        // social job records its own `publish.job.failed`. Both places this
        // failure was written are erased by the next success -- the schedule's
        // `last_error` is cleared and the metric row is overwritten -- so an
        // intermittent collector left the counters showing a failure rate and
        // nothing anywhere saying what had failed.
        //
        // Carried against the target rather than the publication, unlike a
        // publish failure: a target that stops answering fails every task it
        // has, and one event per publication per cooldown is hundreds of rows
        // for one outage. The publication that hit it is in the details.
        recordEvent(transactionDb as UnsafeBackendDb["db"], backendDb.clock, {
          ref: null,
          type: "analytics.metrics.failed",
          severity: terminal ? "error" : "warn",
          target: task.target,
          message: `${task.target} metrics collection failed: ${message}`,
          details: { target: task.target, terminal, publicationKey: task.publicationKey, externalId: task.externalId },
          cooldownSeconds: ALERT_COOLDOWN_SECONDS,
        });
      });
    }
  }

  recordWorkerState(backendDb, "metrics", { checked: tasks.length });
  return tasks.length;
}
