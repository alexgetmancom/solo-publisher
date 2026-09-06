import { afterEach, describe, expect, it } from "bun:test";
import { audienceAnalysis } from "../src/analytics/reports/audience.js";
import { creatorVideoArchive, creatorVideoMetrics } from "../src/analytics/reports/video-archive.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { socialComments, videoMetricSnapshots } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

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

describe("audienceAnalysis", () => {
  const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "t", DEEPSEEK_API_KEY: "sk-test" });

  function comment(backendDb: UnsafeBackendDb, targetId: number, text: string, publishedAt: string): void {
    backendDb.db
      .insert(socialComments)
      .values({
        platform: "youtube",
        commentId: `${text}-${publishedAt}`,
        videoTargetId: targetId,
        text,
        publishedAt,
        fetchedAt: sampledAt,
      })
      .run();
  }

  it("returns the model's report under a localized title", async () => {
    await withDb(async (backendDb) => {
      const { targetId } = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: sampledAt });
      comment(backendDb, targetId, "more roguelikes please", sampledAt);
      const impl = (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "  - players want roguelikes  " } }] }))) as unknown as typeof fetch;

      const report = await audienceAnalysis(backendDb, config, "en", impl);
      expect(report).toContain("AI audience analysis");
      expect(report).toContain("- players want roguelikes");
      expect(report).not.toContain("  - players");
    });
  });

  it("sends the newest hundred comments, labelled by platform, and never the author", async () => {
    await withDb(async (backendDb) => {
      const { targetId } = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: sampledAt });
      for (let index = 0; index < 120; index += 1) {
        comment(backendDb, targetId, `comment ${index}`, `2026-07-27T${String(index % 24).padStart(2, "0")}:00:00.000Z`);
      }
      let sentBody = "";
      const impl = (async (_url: string, init?: RequestInit) => {
        sentBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      }) as unknown as typeof fetch;

      await audienceAnalysis(backendDb, config, "en", impl);
      const payload = JSON.parse(sentBody) as { messages: Array<{ role: string; content: string }> };
      const userContent = payload.messages.find((message) => message.role === "user")?.content ?? "";
      expect(userContent.split("\n")).toHaveLength(100);
      expect(userContent).toStartWith("[youtube] ");
      expect(payload.messages[0]?.content).toContain("do not invent facts");
    });
  });

  it("says the feature is unavailable without an API key, and does not call out", async () => {
    await withDb(async (backendDb) => {
      let called = false;
      const impl = (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch;

      const noKey = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "t" });
      expect(await audienceAnalysis(backendDb, noKey, "en", impl)).toContain("add DEEPSEEK_API_KEY");
      expect(called).toBe(false);
    });
  });

  it("says there is nothing to analyse when no comments are cached, and does not call out", async () => {
    await withDb(async (backendDb) => {
      let called = false;
      const impl = (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch;

      expect(await audienceAnalysis(backendDb, config, "en", impl)).toContain("no cached comments yet");
      expect(called).toBe(false);
    });
  });

  it("falls back to a placeholder when the model returns an empty choice", async () => {
    await withDb(async (backendDb) => {
      const { targetId } = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: sampledAt });
      comment(backendDb, targetId, "hi", sampledAt);
      const impl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }))) as unknown as typeof fetch;

      expect(await audienceAnalysis(backendDb, config, "en", impl)).toContain("couldn't prepare a report");
    });
  });

  it("propagates a provider failure rather than reporting a made-up analysis", async () => {
    await withDb(async (backendDb) => {
      const { targetId } = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: sampledAt });
      comment(backendDb, targetId, "hi", sampledAt);
      const impl = (async () => new Response('{"error":"quota"}', { status: 402 })) as unknown as typeof fetch;

      await expect(audienceAnalysis(backendDb, config, "en", impl)).rejects.toThrow("402");
    });
  });
});
