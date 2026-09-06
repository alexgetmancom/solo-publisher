import { describe, expect, it } from "bun:test";
import { retentionAtSeconds } from "../src/analytics/collection/youtube-analytics.js";
import {
  deepAnalyticsBucketFor,
  enrichYouTubeDeepAnalytics,
  hasDeepAnalytics,
} from "../src/analytics/collection/youtube-deep-analytics.js";
import { videoMetricSnapshots } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";

describe("youtube deep analytics", () => {
  it("reads retention off the curve at the seconds a Short is won in", () => {
    const curve = [
      { ratio: 0, watchRatio: 1 },
      { ratio: 0.1, watchRatio: 0.82 },
      { ratio: 0.2, watchRatio: 0.64 },
      { ratio: 1, watchRatio: 0.2 },
    ];
    // A 30s video: one second in is ratio 0.033, closest sample is 0.
    expect(retentionAtSeconds(curve, 30_000, [1, 3])).toEqual({ retentionAt1s: 100, retentionAt3s: 82 });
    // A 2s video has no fifth second to report.
    expect(retentionAtSeconds(curve, 2_000, [5])).toEqual({ retentionAt5s: null });
    expect(retentionAtSeconds([], 30_000, [1])).toEqual({ retentionAt1s: null });
  });

  it("pays for a per-video report twice in a video's life, not on every checkpoint", async () => {
    await withDb(async (backendDb) => {
      const publishedAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
      expect(deepAnalyticsBucketFor(publishedAt)).toBe(24);
      expect(deepAnalyticsBucketFor(new Date(Date.now() - 3_600_000).toISOString())).toBeNull();

      const { targetId } = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt, externalId: "abc" });
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({
          videoTargetId: targetId,
          platform: "youtube_shorts",
          checkpointIndex: 3,
          sampledAt: new Date().toISOString(),
          metricsJson: { views: 900, videoDurationMs: 30_000 },
        })
        .run();
      expect(hasDeepAnalytics(backendDb, targetId, 24)).toBe(false);

      let calls = 0;
      const fetchImpl = (async (input: RequestInfo | URL) => {
        calls += 1;
        const url = String(input);
        const rows = url.includes("elapsedVideoTimeRatio")
          ? { columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }], rows: [[0, 0.95]] }
          : url.includes("ageGroup")
            ? {
                columnHeaders: [{ name: "ageGroup" }, { name: "gender" }, { name: "viewerPercentage" }],
                rows: [["age25-34", "male", 44.4]],
              }
            : url.includes("insightTrafficSourceDetail")
              ? { columnHeaders: [{ name: "insightTrafficSourceDetail" }, { name: "views" }], rows: [["кооп хоррор", 120]] }
              : {
                  columnHeaders: [{ name: "insightTrafficSourceType" }, { name: "views" }],
                  rows: [
                    ["SHORTS", 5000],
                    ["YT_SEARCH", 120],
                  ],
                };
        return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      const target = { videoTargetId: targetId, externalId: "abc", checkpointIndex: 3, publishedAt, videoDurationMs: 30_000 };
      const enrichment = await enrichYouTubeDeepAnalytics(backendDb, target, 24, "token", fetchImpl);
      expect(enrichment.trafficSources).toEqual({ SHORTS: 5000, YT_SEARCH: 120 });
      // Who watched, and what they searched for — the latter only because
      // search actually brought views.
      expect(enrichment.viewers).toEqual({ "age25-34:male": 44.4 });
      expect(enrichment.searchTerms).toEqual({ "кооп хоррор": 120 });
      expect(calls).toBe(4);
      // The marker is in the snapshot, so a restart cannot buy the same reading twice.
      expect(hasDeepAnalytics(backendDb, targetId, 24)).toBe(true);
      expect(hasDeepAnalytics(backendDb, targetId, 168)).toBe(false);
    });
  });
});
