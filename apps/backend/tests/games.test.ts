import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { enrichGames, gamesReport } from "../src/analytics/games.js";
import { games, videoDrafts, videoTargets } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";

const STEAM = {
  "4890760": {
    success: true,
    data: {
      name: "THE DEAD WE KNEW",
      genres: [{ description: "Action" }, { description: "Early Access" }],
      categories: [{ description: "Co-op" }, { description: "Online Co-op" }, { description: "Family Sharing" }],
      release_date: { date: "17 Sep, 2026" },
      developers: ["MAY19 STUDIO"],
    },
  },
};

describe("game dimension", () => {
  it("reads the genre off the store page the video's own copy links to", async () => {
    await withDb(async (backendDb) => {
      const { draftId, targetId } = insertPublishedVideo(backendDb, {
        target: "youtube_shorts",
        publishedAt: new Date().toISOString(),
      });
      backendDb.db
        .update(videoTargets)
        .set({ metadataJson: { gameUrl: "https://store.steampowered.com/app/4890760" } })
        .where(eq(videoTargets.id, targetId))
        .run();
      backendDb.db.update(videoDrafts).set({ game: "The Dead We Knew" }).where(eq(videoDrafts.id, draftId)).run();

      const fetchImpl = (async () => new Response(JSON.stringify(STEAM))) as unknown as typeof fetch;
      expect(await enrichGames(backendDb, fetchImpl, { apply: false, refresh: false, limit: 10 })).toMatchObject({
        applied: false,
        games: 1,
        withStoreLink: 1,
        enriched: 0,
      });
      // Nothing is written without --apply.
      expect(backendDb.db.select().from(games).all()).toEqual([]);

      await enrichGames(backendDb, fetchImpl, { apply: true, refresh: false, limit: 10 });
      const stored = backendDb.db.select().from(games).get();
      expect(stored).toMatchObject({
        name: "The Dead We Knew",
        steamAppId: "4890760",
        genres: ["Action", "Early Access"],
        developer: "MAY19 STUDIO",
        source: "steam:4890760",
      });
      // Store plumbing is not a way to play a game.
      expect(stored?.playerModes).toEqual(["Co-op", "Online Co-op"]);

      const report = gamesReport(backendDb);
      expect(report).toMatchObject({ games: 1, described: 1, videos: 1 });
    });
  });

  it("reports a game with no store link instead of guessing at it", async () => {
    await withDb(async (backendDb) => {
      const { draftId } = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: new Date().toISOString() });
      backendDb.db.update(videoDrafts).set({ game: "Известная только Мару" }).where(eq(videoDrafts.id, draftId)).run();

      const fetchImpl = (async () => {
        throw new Error("Steam must not be called for a game with no link");
      }) as unknown as typeof fetch;
      expect(await enrichGames(backendDb, fetchImpl, { apply: true, refresh: false, limit: 10 })).toMatchObject({
        withStoreLink: 0,
        enriched: 0,
        withoutStoreLink: ["Известная только Мару"],
      });
    });
  });
});
