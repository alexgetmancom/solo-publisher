import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { importManualAnalytics } from "../src/analytics/import-manual-analytics.js";
import { creatorProfileSnapshots, creatorProfiles } from "../src/db/schema.js";
import { withDb } from "./helpers/db.js";

describe("manual analytics import", () => {
  it("records both Threads accounts as one dated operator observation", () =>
    withDb(async (backendDb) => {
      const result = importManualAnalytics(backendDb, {
        sampledAt: "2026-07-29T18:00:00.000Z",
        threadsRuFollowers: 210,
        threadsEnFollowers: 170,
      });

      expect(result.profiles).toEqual([
        { platform: "threads_ru", account: "alexgetmanru", followersCount: 210 },
        { platform: "threads_en", account: "alexgetmanco", followersCount: 170 },
      ]);
      expect(backendDb.db.select().from(creatorProfileSnapshots).all()).toHaveLength(2);
      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "threads_ru")).get()?.dataJson).toEqual({
        name: "alexgetmanru",
        followersCount: 210,
        manual: true,
      });
    }));

  it("rejects an empty or invalid observation before writing anything", () =>
    withDb(async (backendDb) => {
      expect(() => importManualAnalytics(backendDb, { sampledAt: "2026-07-29T18:00:00.000Z" })).toThrow("provide --x-file");
      expect(() => importManualAnalytics(backendDb, { sampledAt: "2026-07-29T18:00:00.000Z", threadsRuFollowers: -1 })).toThrow(
        "non-negative integer",
      );
      expect(backendDb.db.select().from(creatorProfileSnapshots).all()).toHaveLength(0);
    }));
});
