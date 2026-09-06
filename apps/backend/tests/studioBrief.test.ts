import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { studioBrief } from "../src/analytics/reports/studio-brief.js";
import { videoDrafts, videoMetricSnapshots } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";

describe("studio brief", () => {
  it("leaves out what it cannot stand behind and says what is missing instead", async () => {
    await withDb(async (backendDb) => {
      // Four videos in one slot: one short of the bar the brief speaks at.
      for (const views of [1000, 2000, 3000, 4000]) {
        const { draftId, targetId } = insertPublishedVideo(backendDb, {
          target: "youtube_shorts",
          publishedAt: "2026-09-02T18:00:00.000Z",
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
        backendDb.db.update(videoDrafts).set({ game: "Lethal Company" }).where(eq(videoDrafts.id, draftId)).run();
      }

      const brief = studioBrief(backendDb, { days: 3650, timeZone: "Europe/Moscow" });
      // Four videos in the slot, so the brief says nothing about the hour.
      expect((brief.whenToPublish as { weekday: unknown[] }).weekday).toEqual([]);
      const steps = brief.nextSteps as string[];
      expect(steps.some((step) => step.includes("Hooks are not tagged"))).toBe(true);
      expect(steps.some((step) => step.includes("heatmap"))).toBe(true);
      // Every section points at the report that shows its working.
      expect((brief.words as { source: string }).source).toBe("keywords");
    });
  });
});
