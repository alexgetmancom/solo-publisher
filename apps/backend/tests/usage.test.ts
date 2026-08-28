import { describe, expect, it } from "bun:test";
import { flushUsage, recordUsage, trackUsageAsync, trackUsageSync, usageReport } from "../src/observability/usage.js";
import { withDb } from "./helpers/db.js";

describe("runtime usage telemetry", () => {
  it("aggregates successful and failed calls by day without changing operation errors", () =>
    withDb(async (backendDb) => {
      expect(trackUsageSync(backendDb, "studio.queue.read", () => "ok")).toBe("ok");
      await expect(
        trackUsageAsync(backendDb, "studio.queue.read", async () => {
          throw new Error("provider failed");
        }),
      ).rejects.toThrow("provider failed");
      flushUsage(backendDb);

      const row = backendDb.sqlite
        .prepare("SELECT calls, successes, failures, total_duration_ms FROM runtime_usage WHERE feature_key=?")
        .get("studio.queue.read") as { calls: number; successes: number; failures: number; total_duration_ms: number };
      expect(row.calls).toBe(2);
      expect(row.successes).toBe(1);
      expect(row.failures).toBe(1);
      expect(row.total_duration_ms).toBeGreaterThanOrEqual(0);
    }));

  it("reports a window and marks known operations that have gone unused", () =>
    withDb(async (backendDb) => {
      const now = new Date("2026-08-01T12:00:00.000Z");
      recordUsage(backendDb, "publishing.plan.create", true, 12, new Date("2026-08-01T10:00:00.000Z"));
      recordUsage(backendDb, "publishing.plan.create", true, 20, new Date("2026-07-31T10:00:00.000Z"));
      recordUsage(backendDb, "old.operation", false, 80, new Date("2026-06-01T10:00:00.000Z"));

      const report = usageReport(backendDb, { days: 2, unusedDays: 30, now, knownFeatures: [] });
      const publishing = report.features.find((feature) => feature.featureKey === "publishing.plan.create");
      const old = report.features.find((feature) => feature.featureKey === "old.operation");
      const never = report.features.find((feature) => feature.featureKey === "publishing.video.job");
      const milestoneHistory = report.features.find((feature) => feature.featureKey === "studio.analytics.milestones.read");
      expect(report.windowDays).toBe(2);
      expect(report.since).toBe("2026-07-31T00:00:00.000Z");
      expect(publishing).toMatchObject({ calls: 2, successes: 2, failures: 0, totalDurationMs: 32, daysWithCalls: 2, unused: false });
      expect(old).toMatchObject({ calls: 0, failures: 0, unused: true });
      expect(never).toMatchObject({ calls: 0, unused: true, firstSeenAt: null, lastSeenAt: null });
      expect(milestoneHistory).toMatchObject({ calls: 0, unused: true, firstSeenAt: null, lastSeenAt: null });
    }));

  it("separates an outage that ended from one that is still running", () =>
    withDb(async (backendDb) => {
      const now = new Date("2026-08-28T12:00:00.000Z");
      const day = (date: string, calls: number, failures: number): void => {
        for (let index = 0; index < calls; index += 1)
          recordUsage(backendDb, "analytics.metrics.collect", index >= failures, 10, new Date(`${date}T10:00:00.000Z`));
      };
      // Two days of a provider outage a fortnight ago, quiet ever since.
      day("2026-08-15", 8, 7);
      day("2026-08-16", 6, 5);
      day("2026-08-27", 5, 0);
      day("2026-08-28", 4, 1);

      const report = usageReport(backendDb, { days: 30, unusedDays: 30, now, knownFeatures: [] });
      const metrics = report.features.find((feature) => feature.featureKey === "analytics.metrics.collect");
      // The window alone reads as 13 failures in 23 calls, which is the shape
      // that sends an operator after a fire that went out ten days ago.
      expect(metrics).toMatchObject({ calls: 23, failures: 13, daysWithCalls: 4 });
      expect(metrics?.recent).toEqual({ days: 7, calls: 9, failures: 1 });
      expect(metrics?.worstDay).toEqual({ day: "2026-08-15", calls: 8, failures: 7 });

      const clean = report.features.find((feature) => feature.featureKey === "studio.queue.read");
      expect(clean?.worstDay).toBeNull();
      expect(clean?.recent).toEqual({ days: 7, calls: 0, failures: 0 });

      // A window shorter than the recent one cannot report more days than it has.
      expect(usageReport(backendDb, { days: 2, unusedDays: 30, now, knownFeatures: [] }).features[0]?.recent.days).toBe(2);
    }));
});
