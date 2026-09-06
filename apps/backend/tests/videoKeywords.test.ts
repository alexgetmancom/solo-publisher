import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { commentQuality } from "../src/analytics/reports/comment-quality.js";
import { videoKeywordReport } from "../src/analytics/reports/video-keywords.js";
import { socialComments, videoMetricSnapshots, videoTargets } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";

function publish(
  backendDb: Parameters<typeof insertPublishedVideo>[0],
  target: "youtube_shorts" | "instagram_reels",
  metadata: Record<string, unknown>,
  views: number,
) {
  const { targetId } = insertPublishedVideo(backendDb, { target, publishedAt: new Date(Date.now() - 3_600_000).toISOString() });
  backendDb.db.update(videoTargets).set({ metadataJson: metadata }).where(eq(videoTargets.id, targetId)).run();
  backendDb.db
    .insert(videoMetricSnapshots)
    .values({ videoTargetId: targetId, platform: target, checkpointIndex: 0, sampledAt: new Date().toISOString(), metricsJson: { views } })
    .run();
}

describe("video keywords", () => {
  it("measures a tag against the platform's own median instead of its absolute views", async () => {
    await withDb(async (backendDb) => {
      // "кооп" rides the two hits, "новинки" rides every video.
      publish(backendDb, "youtube_shorts", { tags: ["кооп", "новинки"] }, 10_000);
      publish(backendDb, "youtube_shorts", { tags: ["кооп", "новинки"] }, 6_000);
      publish(backendDb, "youtube_shorts", { tags: ["кооп", "новинки"] }, 2_000);
      publish(backendDb, "youtube_shorts", { tags: ["симулятор", "новинки"] }, 1_000);
      publish(backendDb, "youtube_shorts", { tags: ["симулятор", "новинки"] }, 500);
      publish(backendDb, "youtube_shorts", { tags: ["симулятор", "новинки"] }, 400);

      const surfaces = videoKeywordReport(backendDb, { days: 30, limit: 10 }).surfaces as Record<
        string,
        { videos: number; medianViews: number; best: Array<{ keyword: string; lift: number; videos: number; onEveryVideo: boolean }> }
      >;
      const youtube = surfaces.youtube_tags;
      expect(youtube?.videos).toBe(6);
      expect(youtube?.medianViews).toBe(1500);
      expect(youtube?.best[0]?.keyword).toBe("кооп");
      expect(youtube?.best[0]?.lift).toBe(4);
      // The word on every video cannot beat the median it is part of, and says so.
      expect(youtube?.best.find((entry) => entry.keyword === "новинки")).toMatchObject({ lift: 1, onEveryVideo: true });
    });
  });

  it("reads hashtags out of the caption and pairs them with the same word spelled as a tag", async () => {
    await withDb(async (backendDb) => {
      publish(backendDb, "instagram_reels", { caption: "Тащи пати 🔥\n\n#игры #коопВыживач" }, 5_000);
      publish(backendDb, "instagram_reels", { caption: "Ещё один\n\n#игры #коопвыживач" }, 3_000);
      publish(backendDb, "instagram_reels", { caption: "И третий\n\n#игры" }, 1_000);
      publish(backendDb, "youtube_shorts", { tags: ["кооп выживач", "игры"] }, 8_000);
      publish(backendDb, "youtube_shorts", { tags: ["кооп выживач"] }, 4_000);
      publish(backendDb, "youtube_shorts", { tags: ["игры"] }, 2_000);

      const report = videoKeywordReport(backendDb, { days: 30, limit: 10 });
      const instagram = (report.surfaces as Record<string, { distinctKeywords: number; keywordsPerVideo: number }>).instagram_hashtags;
      expect(instagram?.distinctKeywords).toBe(2);
      // Two hashtags on two videos and one on the third.
      expect(instagram?.keywordsPerVideo).toBe(1.7);
      // `#коопВыживач` and the tag `кооп выживач` are one editorial choice.
      const shared = report.shared as Array<{ keyword: string; youtube: { videos: number }; instagram: { videos: number } }>;
      expect(shared.find((entry) => entry.keyword === "коопвыживач")).toMatchObject({
        youtube: { videos: 2 },
        instagram: { videos: 2 },
      });
    });
  });
});

describe("comment signals", () => {
  it("matches Russian words that an ASCII word boundary walks straight past", async () => {
    await withDb(async (backendDb) => {
      const { targetId } = insertPublishedVideo(backendDb, {
        target: "youtube_shorts",
        publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
      });
      for (const [id, text] of [
        ["a", "сделай обзор на Lethal Company"],
        ["b", "а что за игра тут?"],
        ["c", "огонь"],
      ] as const)
        backendDb.db
          .insert(socialComments)
          .values({ platform: "youtube", commentId: id, videoTargetId: targetId, text, fetchedAt: new Date().toISOString() })
          .run();

      const report = commentQuality(backendDb, { days: 30, limit: 5 });
      const totals = report.totals as { comments: number; questions: number; askedWhichGame: number };
      expect(totals.comments).toBe(3);
      // Only the second comment asks anything; the first is a request.
      expect(totals.questions).toBe(1);
      expect(totals.askedWhichGame).toBe(1);
      expect((report.requests as unknown[]).length).toBe(1);
    });
  });
});
