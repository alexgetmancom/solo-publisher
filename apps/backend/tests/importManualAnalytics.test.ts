import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { importManualAnalytics } from "../src/analytics/import-manual-analytics.js";
import { registerChannel } from "../src/channels/registry.js";
import { creatorProfileSnapshots, creatorProfiles } from "../src/db/schema.js";
import { withDb } from "./helpers/db.js";

describe("manual analytics import", () => {
  it("records both Threads accounts as one dated operator observation", () =>
    withDb(async (backendDb) => {
      // The handle comes from the connected channel: a snapshot filed under a
      // constant would be this Studio's numbers under somebody else's account.
      for (const [targetId, locale, account] of [
        ["threads_ru", "ru", "studio_ru"],
        ["threads_en", "en", "studio_en"],
      ] as const)
        registerChannel(backendDb, { platform: "threads", locale, provider: "native", providerAccountId: account, targetId });
      const result = importManualAnalytics(backendDb, {
        sampledAt: "2026-07-29T18:00:00.000Z",
        threadsRuFollowers: 210,
        threadsEnFollowers: 170,
      });

      expect(result.profiles).toEqual([
        { platform: "threads_ru", account: "studio_ru", followersCount: 210 },
        { platform: "threads_en", account: "studio_en", followersCount: 170 },
      ]);
      expect(backendDb.db.select().from(creatorProfileSnapshots).all()).toHaveLength(2);
      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "threads_ru")).get()?.dataJson).toEqual({
        name: "studio_ru",
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
      expect(() => importManualAnalytics(backendDb, { sampledAt: "2026-07-29T18:00:00.000Z", threadsRuFollowers: 10 })).toThrow(
        "connect the threads ru channel",
      );
      expect(backendDb.db.select().from(creatorProfileSnapshots).all()).toHaveLength(0);
    }));
});
