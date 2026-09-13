import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { openingsRanked } from "../src/analytics/reports/video-performance.js";
import { videoDrafts, videoMetricSnapshots } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";

type Row = { ref: string; hook: string | null; retentionAt3s: number | null; skipRate: number | null; views: number | null };

function opening(
  backendDb: Parameters<typeof insertPublishedVideo>[0],
  input: { hook: string; line: string; retention?: number; skip?: number; views?: number },
): string {
  const { draftId, targetId } = insertPublishedVideo(backendDb, {
    target: "instagram_reels",
    publishedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    label: input.line,
  });
  backendDb.db.update(videoDrafts).set({ hook: input.hook, openingLine: input.line }).where(eq(videoDrafts.id, draftId)).run();
  if (input.retention !== undefined || input.views !== undefined)
    backendDb.db
      .insert(videoMetricSnapshots)
      .values({
        videoTargetId: targetId,
        platform: "instagram_reels",
        checkpointIndex: 0,
        sampledAt: new Date(Date.now() - 3_600_000).toISOString(),
        metricsJson: { views: input.views ?? 0, retentionAt3s: input.retention, skipRate: input.skip },
      })
      .run();
  return `video:${draftId}`;
}

describe("openings ranked", () => {
  it("ranks the openings of one kind by what the first seconds did", async () => {
    await withDb(async (backendDb) => {
      const held = opening(backendDb, { hook: "premise", line: "Держит.", retention: 120, skip: 20, views: 100 });
      const lost = opening(backendDb, { hook: "premise", line: "Не держит.", retention: 80, skip: 60, views: 9000 });
      const unread = opening(backendDb, { hook: "premise", line: "Никто не читал." });
      opening(backendDb, { hook: "release", line: "Другая форма.", retention: 200, skip: 1, views: 1 });

      const report = openingsRanked(backendDb, { kind: "premise", sort: "retention" }) as {
        videos: number;
        measured: number;
        kind: string;
        openings: Row[];
      };

      // Only the kind asked for, best retention first, and the video nobody
      // has read last -- no figure is not a figure of zero.
      expect({ videos: report.videos, measured: report.measured, kind: report.kind }).toEqual({
        videos: 3,
        measured: 2,
        kind: "premise",
      });
      expect(report.openings.map((row) => row.ref)).toEqual([held, lost, unread]);
    });
  });

  it("ranks by skip the other way round, because fewer is better there", async () => {
    await withDb(async (backendDb) => {
      const leaky = opening(backendDb, { hook: "premise", line: "Сливает.", retention: 90, skip: 70, views: 10 });
      const tight = opening(backendDb, { hook: "premise", line: "Держит.", retention: 90, skip: 12, views: 10 });

      const report = openingsRanked(backendDb, { sort: "skip" }) as { openings: Row[]; byKind: Record<string, number> };

      expect(report.openings.map((row) => row.ref)).toEqual([tight, leaky]);
      expect(report.byKind).toEqual({ premise: 2 });
    });
  });
});
