import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { runAnalyticsCycle } from "../src/analytics/collection/creator-cycle.js";
import { runVideoMetricSchedule } from "../src/analytics/collection/video-metrics.js";
import { registerChannel } from "../src/channels/registry.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import {
  analyticsSync,
  creatorProfileSnapshots,
  creatorProfiles,
  publicationEvents,
  socialComments,
  videoMetricSchedule,
  videoMetricSnapshots,
} from "../src/db/schema.js";
import { flushUsage } from "../src/observability/usage.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { TEXT_TEST_CHANNELS, VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { withDb as withFixtureDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const withDb = <T>(run: (backendDb: UnsafeBackendDb) => T | Promise<T>) =>
  withFixtureDb(run, [...TEXT_TEST_CHANNELS, ...VIDEO_TEST_CHANNELS]);

describe("creator analytics collection", () => {
  it("retains live YouTube channel counters when the Analytics API is unavailable", async () => {
    await withDb(async (backendDb) => {
      const config = loadTestConfig({
        YOUTUBE_RU_CLIENT_ID: "client",
        YOUTUBE_RU_CLIENT_SECRET: "secret",
        YOUTUBE_RU_REFRESH_TOKEN: "refresh",
      });
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "access" }));
        if (url.includes("youtube/v3/channels"))
          return new Response(
            JSON.stringify({
              items: [{ snippet: { title: "Marux_play" }, statistics: { subscriberCount: "125", viewCount: "190783", videoCount: "119" } }],
            }),
          );
        if (new URL(url).hostname === "youtubeanalytics.googleapis.com")
          return new Response(JSON.stringify({ error: { message: "service disabled" } }), { status: 403 });
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;
      try {
        const collected = await runAnalyticsCycle(config, backendDb, fetchMock);
        expect(collected).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "youtube_ru")).get()?.dataJson).toMatchObject({
        subscriberCount: 125,
        viewCount: 190783,
      });
      expect(
        backendDb.db.select().from(creatorProfileSnapshots).where(eq(creatorProfileSnapshots.platform, "youtube_ru")).all(),
      ).toHaveLength(1);
      expect(backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, "youtube_ru")).get()?.lastError).toContain(
        "service disabled",
      );
    });
  });

  // Counted per tick, like every other usage key. Skipping the empty ones read
  // as a collector that had died: a Studio with no video channels went silent
  // in the usage report while its cycle was running every five minutes.
  it("counts a scheduler tick that collected nothing", async () => {
    await withDb(async (backendDb) => {
      const config = loadTestConfig({});

      expect(await runAnalyticsCycle(config, backendDb)).toBe(0);
      flushUsage(backendDb);
      expect(backendDb.sqlite.query("SELECT calls FROM runtime_usage WHERE feature_key = 'analytics.video_metrics.collect'").get()).toEqual(
        { calls: 1 },
      );
    });
  });

  it("runs the X and non-native Zernio profile branches in one cycle", async () => {
    await withDb(async (backendDb) => {
      registerChannel(backendDb, {
        platform: "tiktok",
        locale: "ru",
        provider: "zernio",
        providerAccountId: "tiktok-account",
      });
      const config = Object.assign(
        loadTestConfig({
          ENABLE_X_PROFILE_METRICS: "1",
          X_CLIENT_ID: "consumer",
          X_CLIENT_SECRET: "secret",
        }),
        { X_ACCESS_TOKEN: "access", X_REFRESH_TOKEN: "access-secret", ZERNIO_API_KEY: "a".repeat(16) },
      );
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("api.x.com"))
          return new Response(JSON.stringify({ data: { id: "x-user", username: "alex", public_metrics: { followers_count: 120 } } }));
        if (url === "https://zernio.com/api/v1/accounts")
          return new Response(JSON.stringify([{ _id: "tiktok-account", username: "maru_tiktok", followersCount: 42 }]));
        throw new Error(`Unexpected profile request: ${url}`);
      }) as unknown as typeof fetch;

      expect(await runAnalyticsCycle(config, backendDb, fetchMock)).toBe(2);
      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "x")).get()?.dataJson).toMatchObject({
        followersCount: 120,
      });
      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "tiktok_ru")).get()?.dataJson).toMatchObject({
        followersCount: 42,
      });
    });
  });

  it("syncs native Instagram profile snapshots with the matching locale credentials", async () => {
    await withDb(async (backendDb) => {
      const config = loadTestConfig({
        INSTAGRAM_RU_ACCESS_TOKEN: "ru-token",
        INSTAGRAM_RU_USER_ID: "ru-user",
        INSTAGRAM_EN_ACCESS_TOKEN: "en-token",
        INSTAGRAM_EN_USER_ID: "en-user",
      });
      const requested: string[] = [];
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        requested.push(url);
        const account = url.includes("ru-user") ? "marux_play" : "marux_plays";
        return new Response(JSON.stringify({ username: account, followers_count: account === "marux_play" ? 170 : 3, media_count: 1 }));
      }) as typeof fetch;

      await runAnalyticsCycle(config, backendDb, fetchMock);

      expect(requested.filter((url) => url.includes("ru-user") || url.includes("en-user"))).toHaveLength(2);
      const ruRequest = requested.find((url) => url.includes("ru-user"));
      const enRequest = requested.find((url) => url.includes("en-user"));
      expect(ruRequest).toContain("access_token=ru-token");
      expect(enRequest).toContain("access_token=en-token");
      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "instagram_ru")).get()?.dataJson).toMatchObject(
        {
          followersCount: 170,
        },
      );
      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "instagram_en")).get()?.dataJson).toMatchObject(
        {
          followersCount: 3,
        },
      );
    });
  });

  it("uses fixed publication-time checkpoints for video metrics", async () => {
    await withDb(async (backendDb) => {
      const publishedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const { targetId } = insertPublishedVideo(backendDb, {
        label: "Hades",
        target: "instagram_reels",
        publishedAt,
        externalId: "reel-1",
        locale: "en",
      });
      const config = loadTestConfig({
        INSTAGRAM_RU_ACCESS_TOKEN: "token",
        INSTAGRAM_RU_USER_ID: "user",
        INSTAGRAM_EN_ACCESS_TOKEN: "en-token",
        INSTAGRAM_EN_USER_ID: "en-user",
      });
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("/comments")) return new Response(JSON.stringify({ data: [] }));
        if (url.includes("reel-1")) {
          if (!url.includes("access_token=en-token")) throw new Error(`Expected the English Instagram token: ${url}`);
          return new Response(JSON.stringify({ plays: 20, like_count: 2, comments_count: 1 }));
        }
        return new Response(JSON.stringify({ username: "maru", followers_count: 10, media_count: 1 }));
      }) as typeof fetch;
      await runAnalyticsCycle(config, backendDb, fetchMock);

      expect(backendDb.db.select().from(videoMetricSnapshots).all()).toHaveLength(1);
      const schedule = backendDb.db.select().from(videoMetricSchedule).where(eq(videoMetricSchedule.videoTargetId, targetId)).get();
      expect(schedule?.checkpointIndex).toBe(1);
      const nextCheck = new Date(schedule?.nextCheckAt ?? 0).getTime();
      expect(nextCheck).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
      expect(nextCheck).toBeLessThan(Date.now() + 70 * 60 * 1000);
    });
  });

  it("keeps YouTube video metrics healthy when comment access is unavailable", async () => {
    await withDb(async (backendDb) => {
      const publishedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const { targetId } = insertPublishedVideo(backendDb, {
        label: "YouTube scope test",
        target: "youtube_shorts",
        publishedAt,
        externalId: "youtube-scope-test",
      });
      const config = loadTestConfig({
        YOUTUBE_RU_CLIENT_ID: "client",
        YOUTUBE_RU_CLIENT_SECRET: "secret",
        YOUTUBE_RU_REFRESH_TOKEN: "refresh",
      });
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "access" }));
        if (url.includes("youtube/v3/videos"))
          return new Response(
            JSON.stringify({
              items: [
                {
                  snippet: { title: "YouTube scope test", publishedAt },
                  statistics: { viewCount: "1200", likeCount: "80", commentCount: "9" },
                  contentDetails: { duration: "PT24S" },
                },
              ],
            }),
          );
        if (url.includes("youtube/v3/commentThreads"))
          return new Response(JSON.stringify({ error: { message: "Request had insufficient authentication scopes." } }), { status: 403 });
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;

      await runVideoMetricSchedule(config, backendDb, fetchMock);

      expect(
        backendDb.db.select().from(videoMetricSnapshots).where(eq(videoMetricSnapshots.videoTargetId, targetId)).get()?.metricsJson,
      ).toMatchObject({
        views: 1_200,
        videoDurationMs: 24_000,
      });
      const schedule = backendDb.db.select().from(videoMetricSchedule).where(eq(videoMetricSchedule.videoTargetId, targetId)).get();
      expect(schedule?.frozenAt).toBeNull();
      expect(schedule?.lastError).toBeNull();
    });
  });

  it("freezes a terminal video metric error and records a durable event", async () => {
    await withDb(async (backendDb) => {
      const publishedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const { draftId, targetId } = insertPublishedVideo(backendDb, {
        label: "Missing Reel",
        target: "instagram_reels",
        publishedAt,
        externalId: "missing-reel",
      });
      const config = loadTestConfig({ INSTAGRAM_RU_ACCESS_TOKEN: "token", INSTAGRAM_RU_USER_ID: "user" });
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("missing-reel")) return new Response(JSON.stringify({ error: { message: "media not found" } }), { status: 404 });
        throw new Error(`Unexpected request: ${url}`);
      }) as unknown as typeof fetch;

      expect(await runVideoMetricSchedule(config, backendDb, fetchMock)).toBe(1);
      expect(backendDb.db.select().from(videoMetricSchedule).where(eq(videoMetricSchedule.videoTargetId, targetId)).get()).toMatchObject({
        frozenAt: expect.any(String),
        lockedBy: null,
      });
      expect(
        backendDb.db.select().from(publicationEvents).where(eq(publicationEvents.eventType, "analytics.video_metrics.frozen")).get(),
      ).toMatchObject({
        publicationKey: `video:${draftId}`,
        target: "instagram_reels",
        severity: "warn",
      });
    });
  });

  it("keeps the Data API snapshot when YouTube Analytics enrichment fails", async () => {
    await withDb(async (backendDb) => {
      const publishedAt = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
      const { targetId } = insertPublishedVideo(backendDb, {
        label: "Delayed Analytics",
        target: "youtube_shorts",
        publishedAt,
        externalId: "delayed-analytics",
      });
      const config = loadTestConfig({
        YOUTUBE_RU_CLIENT_ID: "client",
        YOUTUBE_RU_CLIENT_SECRET: "secret",
        YOUTUBE_RU_REFRESH_TOKEN: "refresh",
      });
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "access" }));
        if (url.includes("youtube/v3/videos"))
          return new Response(
            JSON.stringify({
              items: [
                {
                  snippet: { title: "Delayed Analytics", publishedAt },
                  statistics: { viewCount: "80" },
                  contentDetails: { duration: "PT8S" },
                },
              ],
            }),
          );
        if (url.includes("youtube/v3/commentThreads"))
          return new Response(JSON.stringify({ error: { message: "Request had insufficient authentication scopes." } }), { status: 403 });
        if (new URL(url).hostname === "youtubeanalytics.googleapis.com")
          return new Response(JSON.stringify({ error: { message: "analytics service unavailable" } }), { status: 503 });
        throw new Error(`Unexpected request: ${url}`);
      }) as unknown as typeof fetch;

      await runVideoMetricSchedule(config, backendDb, fetchMock);
      expect(
        backendDb.db.select().from(videoMetricSnapshots).where(eq(videoMetricSnapshots.videoTargetId, targetId)).get()?.metricsJson,
      ).toMatchObject({
        views: 80,
        videoDurationMs: 8_000,
      });
      expect(backendDb.db.select().from(videoMetricSchedule).where(eq(videoMetricSchedule.videoTargetId, targetId)).get()).toMatchObject({
        frozenAt: null,
        lastError: null,
      });
      expect(
        backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, "youtube_video_analytics_ru")).get()?.lastError,
      ).toContain("503");
    });
  });

  it("keeps native Instagram metrics when plays are unavailable and stores comments", async () => {
    await withDb(async (backendDb) => {
      const publishedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const { targetId } = insertPublishedVideo(backendDb, {
        label: "Native comments",
        target: "instagram_reels",
        publishedAt,
        externalId: "native-comments",
      });
      const config = loadTestConfig({ INSTAGRAM_RU_ACCESS_TOKEN: "token", INSTAGRAM_RU_USER_ID: "user" });
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("fields=like_count"))
          return new Response(
            JSON.stringify({ like_count: 4, comments_count: 2, permalink: "https://instagram.com/reel/native-comments" }),
          );
        if (url.includes("/insights?")) return new Response(JSON.stringify({ error: { message: "insight unavailable" } }), { status: 403 });
        if (url.includes("/comments?"))
          return new Response(JSON.stringify({ data: [{ id: "comment-1", text: "Nice", username: "viewer", like_count: 2 }] }));
        throw new Error(`Unexpected request: ${url}`);
      }) as unknown as typeof fetch;

      await runVideoMetricSchedule(config, backendDb, fetchMock);
      expect(
        backendDb.db.select().from(videoMetricSnapshots).where(eq(videoMetricSnapshots.videoTargetId, targetId)).get()?.metricsJson,
      ).toMatchObject({
        views: 0,
        likes: 4,
        comments: 2,
      });
      expect(backendDb.db.select().from(socialComments).where(eq(socialComments.videoTargetId, targetId)).get()).toMatchObject({
        platform: "instagram",
        commentId: "comment-1",
        text: "Nice",
        likeCount: 2,
      });
    });
  });

  it("corrects a legacy video schedule without making a provider request", async () => {
    await withDb(async (backendDb) => {
      const publishedAt = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
      const { targetId } = insertPublishedVideo(backendDb, { target: "instagram_reels", publishedAt, externalId: "legacy-schedule" });
      const lastCheckedAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const oldNextCheckAt = new Date(Date.now() + 10 * 24 * 60 * 60_000).toISOString();
      backendDb.db
        .insert(videoMetricSchedule)
        .values({ videoTargetId: targetId, checkpointIndex: 1, lastCheckedAt, nextCheckAt: oldNextCheckAt, updatedAt: lastCheckedAt })
        .run();
      const config = loadTestConfig({});
      expect(
        await runVideoMetricSchedule(config, backendDb, (async () => {
          throw new Error("provider should not be called");
        }) as unknown as typeof fetch),
      ).toBe(0);
      const nextCheckAt = backendDb.db
        .select({ nextCheckAt: videoMetricSchedule.nextCheckAt })
        .from(videoMetricSchedule)
        .where(eq(videoMetricSchedule.videoTargetId, targetId))
        .get();
      expect(nextCheckAt?.nextCheckAt).not.toBe(oldNextCheckAt);
    });
  });

  it("merges one batched YouTube Analytics report into Data API snapshots", async () => {
    await withDb(async (backendDb) => {
      const publishedAt = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
      const { targetId } = insertPublishedVideo(backendDb, {
        label: "YouTube analytics test",
        target: "youtube_shorts",
        publishedAt,
        externalId: "youtube-analytics-test",
      });
      const config = loadTestConfig({
        YOUTUBE_RU_CLIENT_ID: "client",
        YOUTUBE_RU_CLIENT_SECRET: "secret",
        YOUTUBE_RU_REFRESH_TOKEN: "refresh",
      });
      const requested: string[] = [];
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        requested.push(url);
        if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "access" }));
        if (url.includes("youtube/v3/videos"))
          return new Response(
            JSON.stringify({
              items: [
                {
                  snippet: { title: "YouTube analytics test", publishedAt },
                  statistics: { viewCount: "1200", likeCount: "80", commentCount: "9" },
                  contentDetails: { duration: "PT30S" },
                },
              ],
            }),
          );
        if (url.includes("youtube/v3/commentThreads"))
          return new Response(JSON.stringify({ error: { message: "Request had insufficient authentication scopes." } }), { status: 403 });
        if (new URL(url).hostname === "youtubeanalytics.googleapis.com")
          return new Response(
            JSON.stringify({
              columnHeaders: [
                { name: "video" },
                { name: "views" },
                { name: "estimatedMinutesWatched" },
                { name: "averageViewDuration" },
                { name: "averageViewPercentage" },
                { name: "subscribersGained" },
                { name: "subscribersLost" },
              ],
              rows: [["youtube-analytics-test", 2400, 36, 18, 60, 7, 2]],
            }),
          );
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;

      await runVideoMetricSchedule(config, backendDb, fetchMock);

      const metrics = backendDb.db
        .select()
        .from(videoMetricSnapshots)
        .where(eq(videoMetricSnapshots.videoTargetId, targetId))
        .get()?.metricsJson;
      expect(metrics).toMatchObject({
        // Data API remains the source of the current public counter.
        views: 1_200,
        videoDurationMs: 30_000,
        averageWatchTimeMs: 18_000,
        totalWatchTimeMs: 2_160_000,
        completionRate: 60,
        subscribersGained: 7,
        subscribersLost: 2,
        follows: 5,
        analyticsSource: "youtube_analytics_api",
      });
      expect(requested.some((url) => url.includes("dimensions=video") && url.includes("filters=video%3D%3D"))).toBe(true);
    });
  });

  it("refreshes YouTube OAuth once and freezes a failed batch without a request burst", async () => {
    await withDb(async (backendDb) => {
      const publishedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const now = new Date().toISOString();
      const targetIds = [
        insertPublishedVideo(backendDb, {
          label: "YouTube batch A",
          target: "youtube_shorts",
          publishedAt,
          updatedAt: now,
          externalId: "youtube-a",
        }).targetId,
        insertPublishedVideo(backendDb, {
          label: "YouTube batch B",
          target: "youtube_shorts",
          publishedAt,
          updatedAt: now,
          externalId: "youtube-b",
        }).targetId,
      ];
      backendDb.db
        .insert(videoMetricSchedule)
        .values(
          targetIds.map((videoTargetId) => ({ videoTargetId, nextCheckAt: new Date(Date.now() - 1_000).toISOString(), updatedAt: now })),
        )
        .run();
      const config = loadTestConfig({
        YOUTUBE_RU_CLIENT_ID: "client",
        YOUTUBE_RU_CLIENT_SECRET: "secret",
        YOUTUBE_RU_REFRESH_TOKEN: "revoked",
      });
      let refreshRequests = 0;
      const fetchMock = (async (input: URL | RequestInfo) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          refreshRequests += 1;
          return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), {
            status: 400,
          });
        }
        throw new Error(`Unexpected request: ${input}`);
      }) as typeof fetch;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;
      try {
        await runVideoMetricSchedule(config, backendDb, fetchMock);
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(refreshRequests).toBe(1);
      for (const videoTargetId of targetIds) {
        const schedule = backendDb.db.select().from(videoMetricSchedule).where(eq(videoMetricSchedule.videoTargetId, videoTargetId)).get();
        expect(schedule?.frozenAt).not.toBeNull();
        expect(schedule?.lastError).toContain("invalid_grant");
      }
    });
  });

  it("collects Zernio Reel and account analytics without Meta credentials", async () => {
    await withDb(async (backendDb) => {
      const now = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const { targetId } = insertPublishedVideo(backendDb, {
        label: "Zernio Reel",
        target: "instagram_reels",
        publishedAt: now,
        deliveryProvider: "zernio",
        providerAccountId: "maru-account",
        providerPostId: "zernio-post",
      });
      const config = Object.assign(loadTestConfig({}), { ZERNIO_API_KEY: "a".repeat(16) });
      registerChannel(backendDb, {
        platform: "instagram",
        locale: "ru",
        provider: "zernio",
        providerAccountId: "maru-account",
      });
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url === "https://zernio.com/api/v1/accounts")
          return new Response(JSON.stringify([{ _id: "maru-account", username: "marux_play", followersCount: 306 }]));
        if (url.includes("account-insights"))
          return new Response(
            JSON.stringify({
              metrics: {
                reach: { total: 100 },
                views: { total: 200 },
                total_interactions: { total: 20 },
                saves: { total: 5 },
                shares: { total: 7 },
              },
            }),
          );
        if (url.includes("follower-history"))
          return new Response(
            JSON.stringify({ metrics: { follower_count: { total: 0 }, followers_gained: { total: 8 }, followers_lost: { total: 2 } } }),
          );
        if (url.includes("postId=zernio-post"))
          return new Response(
            JSON.stringify({
              publishedAt: now,
              platformPostUrl: "https://www.instagram.com/reel/example/",
              analytics: {
                views: 200,
                likes: 20,
                comments: 3,
                reach: 160,
                shares: 7,
                saves: 5,
                follows: 2,
                igReelsAvgWatchTime: 7000,
                igReelsVideoDuration: 12,
              },
            }),
          );
        throw new Error(`unexpected URL: ${url}`);
      }) as typeof fetch;

      await runAnalyticsCycle(config, backendDb, fetchMock);

      expect(
        backendDb.db.select().from(videoMetricSnapshots).where(eq(videoMetricSnapshots.videoTargetId, targetId)).get()?.metricsJson,
      ).toMatchObject({
        views: 200,
        reach: 160,
        saves: 5,
        averageWatchTimeMs: 7000,
        videoDurationMs: 12_000,
      });
      expect(
        backendDb.db.select().from(videoMetricSnapshots).where(eq(videoMetricSnapshots.videoTargetId, targetId)).get()?.metricsJson,
      ).toMatchObject({ completionRate: (7000 / 12_000) * 100 });
      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "instagram_ru")).get()?.dataJson).toMatchObject(
        {
          followersCount: 306,
          reach30d: 100,
          followersGained30d: 8,
        },
      );
    });
  });
});
