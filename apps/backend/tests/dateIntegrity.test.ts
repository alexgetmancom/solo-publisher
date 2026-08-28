import { describe, expect, it } from "bun:test";
import { xActivityMetricSnapshots } from "../src/db/schema.js";
import { dateIntegrity } from "../src/observability/date-integrity.js";
import { repairStoredDates } from "../src/observability/date-repair.js";
import { withoutDateGuards } from "./helpers/date-guards.js";
import { withDb } from "./helpers/db.js";

describe("stored dates", () => {
  it("passes a database whose dates are dates", () =>
    withDb(async (backendDb) => {
      expect(dateIntegrity(backendDb)).toEqual([]);
    }));

  /** The value that cost eight days of X readings: a timestamp cut short by a
   * shell, which `Date` read as the year 2034 and every query sorted above the
   * window it belonged in. */
  it("names a column holding something that is not an instant", () =>
    withDb(async (backendDb) => {
      withoutDateGuards(backendDb, () =>
        backendDb.db
          .insert(xActivityMetricSnapshots)
          .values([
            { xPostId: "1", metricName: "views", value: 10, sampledAt: "34Z" },
            { xPostId: "2", metricName: "views", value: 20, sampledAt: "2026-08-27T14:01:34Z" },
          ])
          .run(),
      );

      expect(dateIntegrity(backendDb)).toEqual([
        { table: "x_activity_metric_snapshots", column: "sampled_at", expects: "instant", rows: 1, sample: "34Z" },
      ]);
    }));

  /** A calendar day is a different shape, and holding one where a moment
   * belongs is the same defect wearing a plausible face. */
  it("does not accept a bare day where a moment belongs", () =>
    withDb(async (backendDb) => {
      withoutDateGuards(backendDb, () =>
        backendDb.db
          .insert(xActivityMetricSnapshots)
          .values({ xPostId: "3", metricName: "views", value: 30, sampledAt: "2026-08-27" })
          .run(),
      );

      expect(dateIntegrity(backendDb).map((violation) => violation.column)).toEqual(["sampled_at"]);
    }));
});

describe("repairing stored dates", () => {
  it("rewrites SQLite's own spelling and drops a reading with no moment", () =>
    withDb(async (backendDb) => {
      withoutDateGuards(backendDb, () =>
        backendDb.db
          .insert(xActivityMetricSnapshots)
          .values([
            { xPostId: "1", metricName: "views", value: 10, sampledAt: "34Z" },
            { xPostId: "2", metricName: "views", value: 20, sampledAt: "2026-08-27 14:01:34" },
            { xPostId: "3", metricName: "views", value: 30, sampledAt: "2026-08-27T14:01:34.000Z" },
          ])
          .run(),
      );

      expect(repairStoredDates(backendDb, false).every((repair) => !repair.applied)).toBe(true);
      expect(dateIntegrity(backendDb)).toHaveLength(1);

      repairStoredDates(backendDb, true);

      expect(dateIntegrity(backendDb)).toEqual([]);
      const kept = backendDb.db.select().from(xActivityMetricSnapshots).all();
      // The measurement survives; only the row whose whole content was a
      // moment that never happened is gone.
      expect(kept.map((row) => row.sampledAt).sort()).toEqual(["2026-08-27T14:01:34.000Z", "2026-08-27T14:01:34.000Z"]);
    }));
});

/** The rule is written down and the importer checks it, but "34Z" arrived
 * through a door neither covered. This is the barrier itself: it does not care
 * which door, and it answers with an error instead of a sorted row. */
describe("the database refusing a date that is not one", () => {
  it("rejects a mangled instant from every writer, raw SQL included", () =>
    withDb(async (backendDb) => {
      const write = (sampledAt: string) =>
        backendDb.db.insert(xActivityMetricSnapshots).values({ xPostId: "1", metricName: "views", value: 10, sampledAt }).run();

      expect(() => write("34Z")).toThrow(/must be an ISO instant/);
      expect(() => write("2026-08-27")).toThrow(/must be an ISO instant/);
      expect(() => write("2026-08-27 14:01:34")).toThrow(/must be an ISO instant/);
      expect(() =>
        backendDb.sqlite.run(
          "INSERT INTO x_activity_metric_snapshots (x_post_id,metric_name,value,sampled_at) VALUES ('2','views',1,'34Z')",
        ),
      ).toThrow(/must be an ISO instant/);

      write("2026-08-27T14:01:34.000Z");
      expect(backendDb.db.select().from(xActivityMetricSnapshots).all()).toHaveLength(1);
    }));

  it("refuses to let an update spoil a date that was good", () =>
    withDb(async (backendDb) => {
      backendDb.db
        .insert(xActivityMetricSnapshots)
        .values({ xPostId: "1", metricName: "views", value: 10, sampledAt: "2026-08-27T14:01:34.000Z" })
        .run();

      expect(() => backendDb.sqlite.run("UPDATE x_activity_metric_snapshots SET sampled_at='34Z'")).toThrow(/must be an ISO instant/);
    }));

  /** A day column is a different shape, and a moment in it is the same defect
   * wearing a plausible face. */
  it("holds a day column to a day", () =>
    withDb(async (backendDb) => {
      expect(() =>
        backendDb.sqlite.run(
          "INSERT INTO x_activity_imports (checksum,source_file,period_start,sampled_at,imported_at,row_count) VALUES ('a','b','2026-08-27T14:01:34Z','2026-08-27T14:01:34Z','2026-08-27T14:01:34Z',1)",
        ),
      ).toThrow(/must be a calendar day/);
    }));
});
