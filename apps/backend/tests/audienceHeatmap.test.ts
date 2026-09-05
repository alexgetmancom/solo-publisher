import { describe, expect, it } from "bun:test";
import { audienceHeatmapReport, importAudienceHeatmap } from "../src/analytics/audience-heatmap.js";
import { withDb } from "./helpers/db.js";

const CAPTURE = {
  platform: "youtube",
  account: "Marux_play",
  metric: "when_followers_are_online",
  timeZone: "Europe/Moscow",
  source: "https://studio.youtube.com",
};

describe("audience heatmap", () => {
  it("replaces a re-read of the same capture instead of piling a second copy beside it", async () => {
    await withDb(async (backendDb) => {
      const capturedAt = new Date().toISOString();
      importAudienceHeatmap(backendDb, {
        ...CAPTURE,
        capturedAt,
        slots: [
          { weekday: "Mon", hour: 18, value: 100 },
          { weekday: "Mon", hour: 19, value: 180 },
        ],
      });
      importAudienceHeatmap(backendDb, { ...CAPTURE, capturedAt, slots: [{ weekday: "Mon", hour: 18, value: 120 }] });

      const report = audienceHeatmapReport(backendDb);
      const capture = (report.captures as Array<Record<string, unknown>>)[0];
      expect(capture?.slots).toBe(2);
      expect(capture?.stale).toBe(false);
      const byWeekday = capture?.byWeekday as Record<string, Array<{ hour: number; value: number }>>;
      expect(byWeekday.Mon?.[0]?.value).toBe(120);
      // Busiest first, so an agent reads the recommendation without sorting.
      const busiest = capture?.busiestHours as Array<{ hours: number[] }>;
      expect(busiest[0]?.hours).toEqual([19, 18]);
    });
  });

  it("marks a capture nobody has refreshed so it is not quoted as current", async () => {
    await withDb(async (backendDb) => {
      importAudienceHeatmap(backendDb, {
        ...CAPTURE,
        capturedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
        slots: [{ weekday: "Sat", hour: 15, value: 140 }],
      });
      const capture = (audienceHeatmapReport(backendDb).captures as Array<Record<string, unknown>>)[0];
      expect(capture?.stale).toBe(true);
      expect(capture?.ageDays).toBe(90);
    });
  });
});
