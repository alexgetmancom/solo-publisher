import { describe, expect, it } from "bun:test";
import { outliers, videoDigest } from "../src/analytics/reports/video-digest.js";
import { platformComparison } from "../src/analytics/reports/video-platform-compare.js";
import { videoDrafts, videoMetricSnapshots, videoTargets } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";
import { eq } from "drizzle-orm";

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** A published video with one reading taken `readAfter` hours after it went out. */
function publish(
  backendDb: Parameters<typeof insertPublishedVideo>[0],
  target: "youtube_shorts" | "instagram_reels",
  publishedHoursAgo: number,
  views: number,
  readAfterHours = publishedHoursAgo,
) {
  const { draftId, targetId } = insertPublishedVideo(backendDb, { target, publishedAt: hoursAgo(publishedHoursAgo) });
  backendDb.db
    .insert(videoMetricSnapshots)
    .values({
      videoTargetId: targetId,
      platform: target,
      checkpointIndex: 0,
      sampledAt: hoursAgo(Math.max(0, publishedHoursAgo - readAfterHours)),
      metricsJson: { views },
    })
    .run();
  return { draftId, targetId };
}

describe("digest and outliers", () => {
  it("compares the window with the one before it", async () => {
    await withDb(async (backendDb) => {
      for (const views of [1000, 2000]) publish(backendDb, "youtube_shorts", 24, views);
      for (const views of [500, 500]) publish(backendDb, "youtube_shorts", 24 * 10, views);

      const digest = videoDigest(backendDb, { days: 7, timeZone: "Europe/Moscow" });
      const youtube = (digest.platforms as Record<string, Record<string, unknown>>).youtube_shorts;
      expect(youtube).toMatchObject({ videos: 2, views: 3000, medianViews: 1500 });
      const previous = youtube?.previous as { videos: number };
      expect(previous.videos).toBe(2);
      // 3000 against the 1000 of the previous window.
      expect(youtube?.viewsChangePercent).toBe(200);
    });
  });

  it("flags a young video against what a typical video had at the same age", async () => {
    await withDb(async (backendDb) => {
      // A month of ordinary videos, each read six hours in.
      for (let index = 0; index < 8; index += 1) publish(backendDb, "youtube_shorts", 24 * (3 + index), 1000, 6);
      const breakout = publish(backendDb, "youtube_shorts", 6, 9000, 6);
      publish(backendDb, "youtube_shorts", 6, 1200, 6);

      const found = outliers(backendDb);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ ref: `video:${breakout.draftId}`, views: 9000, typicalAtThisAge: 1000, times: 9 });
    });
  });
});

describe("platform comparison", () => {
  it("compares the same video with itself rather than one platform's total with the other's", async () => {
    await withDb(async (backendDb) => {
      // One draft published to both platforms is the only comparable case.
      const youtube = publish(backendDb, "youtube_shorts", 48, 6000);
      backendDb.db
        .insert(videoTargets)
        .values({
          videoDraftId: youtube.draftId,
          target: "instagram_reels",
          metadataJson: {},
          status: "published",
          publishedAt: hoursAgo(48),
          createdAt: hoursAgo(48),
          updatedAt: hoursAgo(48),
        })
        .run();
      const reel = backendDb.db.select().from(videoTargets).where(eq(videoTargets.target, "instagram_reels")).get();
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({
          videoTargetId: reel?.id as number,
          platform: "instagram_reels",
          checkpointIndex: 0,
          sampledAt: hoursAgo(1),
          metricsJson: { views: 2000 },
        })
        .run();
      backendDb.db.update(videoDrafts).set({ game: "Lethal Company" }).where(eq(videoDrafts.id, youtube.draftId)).run();
      // A video that went out on one platform only cannot be compared.
      publish(backendDb, "instagram_reels", 48, 50_000);

      const report = platformComparison(backendDb, { days: 30 });
      expect(report).toMatchObject({ pairedVideos: 1, unpaired: 1, medianRatio: 3, wonOnYouTube: 1, wonOnInstagram: 0 });
    });
  });
});
