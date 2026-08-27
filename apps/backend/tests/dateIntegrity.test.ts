import { describe, expect, it } from "bun:test";
import { xActivityMetricSnapshots } from "../src/db/schema.js";
import { dateIntegrity } from "../src/observability/date-integrity.js";
import { repairStoredDates } from "../src/observability/date-repair.js";
import { openBackendDb } from "./helpers/open-db.js";

describe("stored dates", () => {
  it("passes a database whose dates are dates", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      expect(dateIntegrity(backendDb)).toEqual([]);
    } finally {
      backendDb.close();
    }
  });

  /** The value that cost eight days of X readings: a timestamp cut short by a
   * shell, which `Date` read as the year 2034 and every query sorted above the
   * window it belonged in. */
  it("names a column holding something that is not an instant", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      backendDb.db
        .insert(xActivityMetricSnapshots)
        .values([
          { xPostId: "1", metricName: "views", value: 10, sampledAt: "34Z" },
          { xPostId: "2", metricName: "views", value: 20, sampledAt: "2026-08-27T14:01:34Z" },
        ])
        .run();

      expect(dateIntegrity(backendDb)).toEqual([
        { table: "x_activity_metric_snapshots", column: "sampled_at", expects: "instant", rows: 1, sample: "34Z" },
      ]);
    } finally {
      backendDb.close();
    }
  });

  /** A calendar day is a different shape, and holding one where a moment
   * belongs is the same defect wearing a plausible face. */
  it("does not accept a bare day where a moment belongs", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      backendDb.db.insert(xActivityMetricSnapshots).values({ xPostId: "3", metricName: "views", value: 30, sampledAt: "2026-08-27" }).run();

      expect(dateIntegrity(backendDb).map((violation) => violation.column)).toEqual(["sampled_at"]);
    } finally {
      backendDb.close();
    }
  });
});

describe("repairing stored dates", () => {
  it("rewrites SQLite's own spelling and drops a reading with no moment", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      backendDb.db
        .insert(xActivityMetricSnapshots)
        .values([
          { xPostId: "1", metricName: "views", value: 10, sampledAt: "34Z" },
          { xPostId: "2", metricName: "views", value: 20, sampledAt: "2026-08-27 14:01:34" },
          { xPostId: "3", metricName: "views", value: 30, sampledAt: "2026-08-27T14:01:34.000Z" },
        ])
        .run();

      expect(repairStoredDates(backendDb, false).every((repair) => !repair.applied)).toBe(true);
      expect(dateIntegrity(backendDb)).toHaveLength(1);

      repairStoredDates(backendDb, true);

      expect(dateIntegrity(backendDb)).toEqual([]);
      const kept = backendDb.db.select().from(xActivityMetricSnapshots).all();
      // The measurement survives; only the row whose whole content was a
      // moment that never happened is gone.
      expect(kept.map((row) => row.sampledAt).sort()).toEqual(["2026-08-27T14:01:34.000Z", "2026-08-27T14:01:34.000Z"]);
    } finally {
      backendDb.close();
    }
  });
});
