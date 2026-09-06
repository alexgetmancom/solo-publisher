import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { videoDrafts, videoTargets } from "../src/db/schema.js";
import { backfillVideoGames } from "../src/operations/video-tag-backfill.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";

describe("video game backfill", () => {
  it("reads the game out of the published copy and leaves a video that names none alone", async () => {
    await withDb(async (backendDb) => {
      const published = new Date().toISOString();
      const captioned = insertPublishedVideo(backendDb, { target: "instagram_reels", publishedAt: published, label: "Пати 🔥" });
      backendDb.db
        .update(videoTargets)
        .set({ metadataJson: { caption: "СРОЧНО ТАЩИ ПАТИ! 🔥\n\n🎮 Название игры: The Dead We Knew\n👾 Платформа: PC\n\n#игры" } })
        .where(eq(videoTargets.id, captioned.targetId))
        .run();
      const titled = insertPublishedVideo(backendDb, {
        target: "youtube_shorts",
        publishedAt: published,
        label: "БОЛЬШЕ НЕ БОМЖИ! 🧙 | Broke Wizards",
      });
      const newsy = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: published, label: "3 инди-шедевра 🔥" });

      const plan = backfillVideoGames(backendDb, { apply: false, overwrite: false });
      expect(plan).toMatchObject({ applied: false, tagged: 2, unresolved: 1, bySource: { caption: 1, title: 1 } });
      // Nothing is written without --apply.
      expect(backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, captioned.draftId)).get()?.game).toBeNull();

      backfillVideoGames(backendDb, { apply: true, overwrite: false });
      expect(backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, captioned.draftId)).get()?.game).toBe("The Dead We Knew");
      // The emoji and the pipe belong to the title, not to the game.
      expect(backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, titled.draftId)).get()?.game).toBe("Broke Wizards");
      // A roundup names no single game, so it stays untagged rather than being guessed.
      expect(backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, newsy.draftId)).get()?.game).toBeNull();
    });
  });

  it("keeps a tag written by hand unless overwrite is asked for", async () => {
    await withDb(async (backendDb) => {
      const { draftId, targetId } = insertPublishedVideo(backendDb, {
        target: "instagram_reels",
        publishedAt: new Date().toISOString(),
        label: "Пати",
      });
      backendDb.db
        .update(videoTargets)
        .set({ metadataJson: { caption: "🎮 Название игры: Lethal Company" } })
        .where(eq(videoTargets.id, targetId))
        .run();
      backendDb.db.update(videoDrafts).set({ game: "Lethal Company (co-op)" }).where(eq(videoDrafts.id, draftId)).run();

      expect(backfillVideoGames(backendDb, { apply: true, overwrite: false })).toMatchObject({ tagged: 0, alreadyTagged: 1 });
      expect(backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, draftId)).get()?.game).toBe("Lethal Company (co-op)");

      backfillVideoGames(backendDb, { apply: true, overwrite: true });
      expect(backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, draftId)).get()?.game).toBe("Lethal Company");
    });
  });
});
