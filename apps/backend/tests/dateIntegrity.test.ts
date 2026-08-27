import { describe, expect, it } from "bun:test";
import { xActivityMetricSnapshots } from "../src/db/schema.js";
import { dateIntegrity } from "../src/observability/date-integrity.js";
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
