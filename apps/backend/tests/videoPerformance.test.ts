import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { videoPerformanceDetail, videoPerformanceReport } from "../src/analytics/reports/video-performance.js";
import { creatorProfileSnapshots, videoMetricSnapshots, videoTargets } from "../src/db/schema.js";
import { tagVideo } from "../src/operations/video-tag.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";

const TIME_ZONE = "Europe/Moscow";

/** 21:00 Moscow on a Wednesday, then the readings a real collection cycle
 * would have left behind by now. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

describe("video performance report", () => {
  it("separates what a video had at each age from its current total", async () => {
    await withDb(async (backendDb) => {
      const { draftId, targetId } = insertPublishedVideo(backendDb, {
        target: "instagram_reels",
        publishedAt: hoursAgo(72),
        label: "Reel",
      });
      backendDb.db
        .insert(videoMetricSnapshots)
        .values([
          {
            videoTargetId: targetId,
            platform: "instagram_reels",
            checkpointIndex: 0,
            sampledAt: hoursAgo(71),
            metricsJson: { views: 500, shares: 10, reach: 400 },
          },
          {
            videoTargetId: targetId,
            platform: "instagram_reels",
            checkpointIndex: 1,
            sampledAt: hoursAgo(48),
            metricsJson: { views: 4000, shares: 90, reach: 3000 },
          },
          {
            videoTargetId: targetId,
            platform: "instagram_reels",
            checkpointIndex: 2,
            sampledAt: hoursAgo(1),
            metricsJson: { views: 5000, shares: 120, reach: 3800 },
          },
        ])
        .run();

      const report = videoPerformanceReport(backendDb, { days: 30, limit: 10, timeZone: TIME_ZONE });
      const totals = (report.totals as Record<string, { views: number; videos: number }>).instagram_reels;
      expect(totals?.views).toBe(5000);
      expect(totals?.videos).toBe(1);

      const curve = (report.ageCurve as Record<string, Array<{ ageHours: number; samples: number; medianViews: number }>>).instagram_reels;
      // The one-hour bucket is the first reading, not the lifetime total.
      expect(curve?.find((bucket) => bucket.ageHours === 1)?.medianViews).toBe(500);
      expect(curve?.find((bucket) => bucket.ageHours === 24)?.medianViews).toBe(4000);

      const detail = videoPerformanceDetail(backendDb, draftId, TIME_ZONE);
      const target = (
        detail.targets as Array<{
          history: Array<{ deltas: { views: number } }>;
          atAges: Array<{ ageHours: number; views: number | null }>;
        }>
      )[0];
      expect(target?.history[1]?.deltas.views).toBe(3500);
      expect(target?.atAges.find((bucket) => bucket.ageHours === 168)?.views).toBe(5000);
    });
  });

  it("marks a publishing hour carried by one video instead of recommending it", async () => {
    await withDb(async (backendDb) => {
      for (const views of [100, 100, 20_000]) {
        const { targetId } = insertPublishedVideo(backendDb, {
          target: "youtube_shorts",
          // 2026-09-02 is a Wednesday; 18:00 UTC is 21:00 in Moscow.
          publishedAt: "2026-09-02T18:00:00.000Z",
          label: `Short ${views}`,
        });
        backendDb.db
          .insert(videoMetricSnapshots)
          .values({
            videoTargetId: targetId,
            platform: "youtube_shorts",
            checkpointIndex: 0,
            sampledAt: "2026-09-02T19:00:00.000Z",
            metricsJson: { views },
          })
          .run();
      }
      const report = videoPerformanceReport(backendDb, { days: 3650, limit: 10, timeZone: TIME_ZONE });
      const slots = (
        report.publishHours as Record<
          string,
          Record<string, Array<{ hourLocal: number; videos: number; confidence: string; dominatedBySingleVideo: boolean }>>
        >
      ).weekday?.youtube_shorts;
      const slot = slots?.find((entry) => entry.hourLocal === 21);
      expect(slot?.videos).toBe(3);
      expect(slot?.confidence).toBe("low");
      expect(slot?.dominatedBySingleVideo).toBe(true);
    });
  });

  it("reports what share of the window carries a tag, not just the ranking", async () => {
    await withDb(async (backendDb) => {
      const tagged: number[] = [];
      for (const views of [1000, 2000, 3000]) {
        const { draftId, targetId } = insertPublishedVideo(backendDb, {
          target: "youtube_shorts",
          publishedAt: hoursAgo(50),
          label: `Short ${views}`,
        });
        backendDb.db
          .insert(videoMetricSnapshots)
          .values({
            videoTargetId: targetId,
            platform: "youtube_shorts",
            checkpointIndex: 0,
            sampledAt: hoursAgo(1),
            metricsJson: { views },
          })
          .run();
        tagged.push(draftId);
      }
      tagVideo(backendDb, tagged[0] as number, { game: "Lethal Company" });
      const cleared = tagVideo(backendDb, tagged[1] as number, { game: "Lethal Company", hook: "" });
      expect(cleared.hook).toBeNull();

      const report = videoPerformanceReport(backendDb, { days: 30, limit: 10, timeZone: TIME_ZONE });
      const games = (
        report.byTag as {
          game: { taggedVideos: number; taggedShare: number; values: Array<{ value: string; videos: number; confidence: string }> };
        }
      ).game;
      expect(games.taggedVideos).toBe(2);
      // Two of three videos carry a game, and the ranking says it is thin evidence.
      expect(games.taggedShare).toBe(67);
      expect(games.values[0]?.confidence).toBe("anecdotal");
    });
  });

  it("counts audience growth by when a snapshot was taken, because not every platform keys them by day", async () => {
    await withDb(async (backendDb) => {
      // YouTube keys its rows hourly; a naive count of rows would call this 3 days.
      backendDb.db
        .insert(creatorProfileSnapshots)
        .values([
          {
            platform: "youtube_ru",
            account: "Marux_play",
            sampledOn: "2026-09-01T10",
            metricsJson: { subscriberCount: 200 },
            source: "test",
            sampledAt: hoursAgo(72),
          },
          {
            platform: "youtube_ru",
            account: "Marux_play",
            sampledOn: "2026-09-01T11",
            metricsJson: { subscriberCount: 240 },
            source: "test",
            sampledAt: hoursAgo(48),
          },
          {
            platform: "youtube_ru",
            account: "Marux_play",
            sampledOn: "2026-09-01T12",
            metricsJson: { subscriberCount: 260 },
            source: "test",
            sampledAt: hoursAgo(2),
          },
        ])
        .run();
      const growth = videoPerformanceReport(backendDb, { days: 30, limit: 5, timeZone: TIME_ZONE }).audienceGrowth as Array<
        Record<string, unknown>
      >;
      expect(growth[0]?.samples).toBe(3);
      expect(growth[0]?.gained).toBe(60);
    });
  });

  it("lists what is scheduled so an hour recommendation has something to aim at", async () => {
    await withDb(async (backendDb) => {
      const { draftId, targetId } = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: hoursAgo(1), label: "Next" });
      backendDb.db
        .update(videoTargets)
        .set({ status: "scheduled", publishedAt: null, scheduledAt: "2026-09-09T18:00:00.000Z" })
        .where(eq(videoTargets.id, targetId))
        .run();
      const queue = videoPerformanceReport(backendDb, { days: 30, limit: 5, timeZone: TIME_ZONE }).queue as Array<Record<string, unknown>>;
      expect(queue[0]?.ref).toBe(`video:${draftId}`);
      const scheduledLocal = queue[0]?.scheduledLocal as { hour: number };
      expect(scheduledLocal.hour).toBe(21);
    });
  });
});
