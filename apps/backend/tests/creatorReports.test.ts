import { afterEach, describe, expect, it } from "bun:test";
import { creatorVideoArchive, creatorVideoMetrics } from "../src/analytics/reports/video-archive.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { videoMetricSnapshots } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";

const sampledAt = "2026-07-27T09:00:00.000Z";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function snapshot(backendDb: UnsafeBackendDb, targetId: number, platform: string, metrics: Record<string, number>): void {
  backendDb.db.insert(videoMetricSnapshots).values({ videoTargetId: targetId, platform, metricsJson: metrics, sampledAt }).run();
}

describe("creatorVideoArchive", () => {
  it("lists published videos newest first and counts the distinct drafts", () => {
    return withDb((backendDb) => {
      insertPublishedVideo(backendDb, { label: "Older", target: "youtube_shorts", publishedAt: "2026-07-01T00:00:00.000Z" });
      insertPublishedVideo(backendDb, { label: "Newer", target: "youtube_shorts", publishedAt: "2026-07-20T00:00:00.000Z" });

      const archive = creatorVideoArchive(backendDb);
      expect(archive.items.map((item) => item.label)).toEqual(["Newer", "Older"]);
      expect(archive.total).toBe(2);
      expect(archive.text).toContain("Choose a video");
    });
  });

  it("counts a draft once even when it published to several targets", () => {
    return withDb((backendDb) => {
      const at = "2026-07-20T00:00:00.000Z";
      const { draftId } = insertPublishedVideo(backendDb, { label: "Cross-posted", target: "youtube_shorts", publishedAt: at });
      insertPublishedVideo(backendDb, { label: "Second draft", target: "instagram_reels", publishedAt: at });

      const archive = creatorVideoArchive(backendDb);
      expect(archive.total).toBe(2);
      expect(archive.items.some((item) => item.id === draftId)).toBe(true);
    });
  });

  it("pages with an offset and caps a page at ten", () => {
    return withDb((backendDb) => {
      for (let index = 0; index < 12; index += 1) {
        insertPublishedVideo(backendDb, {
          label: `Video ${index}`,
          target: "youtube_shorts",
          publishedAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        });
      }

      expect(creatorVideoArchive(backendDb).items).toHaveLength(10);
      expect(creatorVideoArchive(backendDb, 10).items).toHaveLength(2);
      expect(creatorVideoArchive(backendDb).total).toBe(12);
    });
  });

  it("does not list a draft whose targets never published", () => {
    return withDb((backendDb) => {
      insertPublishedVideo(backendDb, { label: "Published", target: "youtube_shorts", publishedAt: sampledAt });
      backendDb.sqlite.query("UPDATE video_targets SET status='failed'").run();

      expect(creatorVideoArchive(backendDb).items).toEqual([]);
      expect(creatorVideoArchive(backendDb).total).toBe(0);
    });
  });
});

describe("creatorVideoMetrics", () => {
  it("renders the latest snapshot per target with the label escaped for Markdown", () => {
    return withDb((backendDb) => {
      const { draftId, targetId } = insertPublishedVideo(backendDb, {
        label: "Video_with*markdown",
        target: "youtube_shorts",
        publishedAt: sampledAt,
      });
      snapshot(backendDb, targetId, "youtube_shorts", { views: 10, likes: 1, comments: 0 });
      snapshot(backendDb, targetId, "youtube_shorts", { views: 900, likes: 30, comments: 4 });

      const text = creatorVideoMetrics(backendDb, draftId);
      expect(text).toContain("Video\\_with\\*markdown");
      expect(text).toContain("▶️ YouTube: 900 views · 30 likes · 4 comments");
    });
  });

  it("says so when the draft does not exist", () => {
    return withDb((backendDb) => {
      expect(creatorVideoMetrics(backendDb, 4242)).toBe("Video not found.");
      expect(creatorVideoMetrics(backendDb, 4242, "ru")).toBe("Ролик не найден.");
    });
  });

  it("marks a target that has no snapshot yet instead of printing a stale row", () => {
    return withDb((backendDb) => {
      const { draftId } = insertPublishedVideo(backendDb, { label: "Fresh", target: "youtube_shorts", publishedAt: sampledAt });

      const text = creatorVideoMetrics(backendDb, draftId);
      expect(text).toContain("0 views");
      expect(text).toContain("Metrics have not been collected yet.");
    });
  });

  it("expands each platform's own fields and converts average watch time to seconds", () => {
    return withDb((backendDb) => {
      const { draftId, targetId } = insertPublishedVideo(backendDb, { label: "Reel", target: "instagram_reels", publishedAt: sampledAt });
      snapshot(backendDb, targetId, "instagram_reels", {
        views: 5_000,
        likes: 100,
        comments: 7,
        reach: 4_200,
        shares: 30,
        saves: 12,
        averageWatchTimeMs: 8_400,
        skipRate: 41.5,
      });

      const text = creatorVideoMetrics(backendDb, draftId);
      expect(text).toContain("📸 Instagram: 5000 views");
      // `follows` is not shown: Instagram answers null for it on every Reel, so
      // the line said "follows: 0" forever and meant nothing.
      expect(text).toContain("reach: 4200 · shares: 30 · saves: 12 · avg watch: 8.4 s · skipped in 3s: 42%");
    });
  });

  it("shows what YouTube collects, which used to be gathered and never drawn", () => {
    return withDb((backendDb) => {
      const { draftId, targetId } = insertPublishedVideo(backendDb, { label: "Short", target: "youtube_shorts", publishedAt: sampledAt });
      snapshot(backendDb, targetId, "youtube_shorts", {
        views: 7_000,
        likes: 300,
        comments: 9,
        averageWatchTimeMs: 19_000,
        completionRate: 63.4,
        subscribersGained: 4,
        retentionAt3s: 110.7,
      });

      const text = creatorVideoMetrics(backendDb, draftId);
      expect(text).toContain("avg watch: 19.0 s · watched: 63% · subscribers: 4 · retention at 3s: 111%");
    });
  });

  it("omits the Reels expansion for a YouTube target and for a Reel with none of those fields", () => {
    return withDb((backendDb) => {
      const youtube = insertPublishedVideo(backendDb, { label: "Short", target: "youtube_shorts", publishedAt: sampledAt });
      snapshot(backendDb, youtube.targetId, "youtube_shorts", { views: 1, likes: 0, comments: 0, reach: 999 });
      expect(creatorVideoMetrics(backendDb, youtube.draftId)).not.toContain("reach:");

      const reel = insertPublishedVideo(backendDb, { label: "Bare reel", target: "instagram_reels", publishedAt: sampledAt });
      snapshot(backendDb, reel.targetId, "instagram_reels", { views: 2, likes: 0, comments: 0 });
      expect(creatorVideoMetrics(backendDb, reel.draftId)).not.toContain("reach:");
    });
  });

  it("localizes the expansion into Russian", () => {
    return withDb((backendDb) => {
      const { draftId, targetId } = insertPublishedVideo(backendDb, { label: "Рил", target: "instagram_reels", publishedAt: sampledAt });
      snapshot(backendDb, targetId, "instagram_reels", { views: 10, likes: 1, comments: 0, reach: 8, averageWatchTimeMs: 2_000 });

      const text = creatorVideoMetrics(backendDb, draftId, "ru");
      expect(text).toContain("охват: 8");
      expect(text).toContain("среднее: 2.0 с");
    });
  });
});
