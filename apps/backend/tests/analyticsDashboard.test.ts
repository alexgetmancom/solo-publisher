import { describe, expect, it } from "bun:test";
import { creatorDashboard } from "../src/analytics/reports/dashboard.js";
import { studioAnalyticsDashboard } from "../src/analytics/reports/studio-dashboard.js";
import { pruneMetricSamples } from "../src/analytics/snapshots/metric-repository.js";
import { showAnalyticsDashboard } from "../src/bot/analytics-screen.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { creatorProfiles, metricSamples, publicationTargets, videoMetricSnapshots } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { registerTestChannels, TEXT_TEST_CHANNELS, VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { withDb as withFixtureDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig, SITE_STUDIO_PROFILE } from "./helpers/studio-config.js";

const withDb = <T>(run: (backendDb: UnsafeBackendDb) => T | Promise<T>) =>
  withFixtureDb(run, [...TEXT_TEST_CHANNELS, ...VIDEO_TEST_CHANNELS]);

describe("creator analytics dashboards", () => {
  it("builds a compact video dashboard from cached platform data", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const { targetId } = insertPublishedVideo(backendDb, { label: "Hades, часть 3", target: "youtube_shorts", publishedAt: now });
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({
          videoTargetId: targetId,
          platform: "youtube_shorts",
          metricsJson: { views: 1200, likes: 87, comments: 9 },
          sampledAt: now,
        })
        .run();
      backendDb.db
        .insert(creatorProfiles)
        .values([
          { platform: "youtube_ru", dataJson: { subscriberCount: 117 }, updatedAt: now },
          { platform: "youtube_en", dataJson: { subscriberCount: 13 }, updatedAt: now },
        ])
        .run();

      const config = loadTestConfig({}, SITE_STUDIO_PROFILE);
      const dashboard = creatorDashboard(backendDb, config, 7);
      expect(dashboard.text).toContain("Видео: 1200 просмотров · 96 взаимодействий");
      expect(dashboard.text).toContain("YouTube: 1200 просмотров · 87 лайков · 130 подписчиков");
      expect(dashboard.text).toContain("Hades, часть 3 — 1200 просмотров");
    });
  });

  it("renders the overall creator dashboard from every connected account source", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values([
          {
            platform: "youtube_ru",
            dataJson: {
              subscriberCount: 10,
              viewCount: 2_000,
              videoCount: 7,
              views: 500,
              estimatedMinutesWatched: 60,
              subscribersGained: 4,
              subscribersLost: 1,
            },
            updatedAt: now,
          },
          {
            platform: "instagram_ru",
            dataJson: {
              followersCount: 306,
              mediaCount: 12,
              reach30d: 1_000,
              views30d: 900,
              interactions30d: 80,
              saves30d: 20,
              shares30d: 10,
              reposts30d: 5,
            },
            updatedAt: now,
          },
        ])
        .run();

      const config = loadTestConfig({}, SITE_STUDIO_PROFILE);

      const dashboard = creatorDashboard(backendDb, config, 0, "en");
      expect(dashboard.text).toContain("Overall statistics");
      expect(dashboard.text).toContain("Site: 0 material views");
      expect(dashboard.text).toContain("Posts: 0 views · 0 interactions");
      expect(dashboard.text).toContain("Subscribers: 10");
      expect(dashboard.text).toContain("Lifetime views: 2000");
      expect(dashboard.text).toContain("Watch time: 1.0 h");
      expect(dashboard.text).toContain("Followers: 306");
      expect(dashboard.text).toContain("Total Reels/posts: 12");
      expect(dashboard.text).toContain("30 days: reach 1000");
    });
  });

  it("renders the compact Studio overview and keeps post and video analytics separate", async () => {
    await withDb(async (backendDb) => {
      const before = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
      const now = new Date().toISOString();
      backendDb.db
        .insert(metricSamples)
        .values([
          { publicationKey: "post:1", target: "telegram", metricName: "views", value: 10, sampledAt: before },
          { publicationKey: "post:1", target: "telegram", metricName: "views", value: 34, sampledAt: now },
          { publicationKey: "post:1", target: "telegram", metricName: "likes", value: 2, sampledAt: before },
          { publicationKey: "post:1", target: "telegram", metricName: "likes", value: 7, sampledAt: now },
        ])
        .run();
      const overview = studioAnalyticsDashboard(backendDb, "overview", 1, "ru").text;
      const postsView = studioAnalyticsDashboard(backendDb, "posts", 1, "ru").text;

      expect(overview).not.toContain("Общая статистика");
      expect(overview).toContain("| Telegram | 0 | — | 24 | 5 | 0 | — | — |");
      // No platform has a growth baseline here, so the total is unknown too —
      // the same "—" the Telegram row shows, not a confident "+0".
      expect(postsView).toBe("За этот период нет статистики текстовых постов.");
      expect(studioAnalyticsDashboard(backendDb, "overview", 1, "ru").richHtml).toContain("<table bordered striped>");
      expect(postsView).not.toContain("Видеопостинг");
    });
  });

  it("separates account activity from videos published in the selected period", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const { targetId } = insertPublishedVideo(backendDb, {
        label: "Симулятор фермы, который удивит",
        target: "instagram_reels",
        publishedAt: now,
      });
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({
          videoTargetId: targetId,
          platform: "instagram_reels",
          metricsJson: { views: 200, likes: 20, shares: 7, saves: 5 },
          sampledAt: now,
        })
        .run();
      backendDb.db
        .insert(creatorProfiles)
        .values({ platform: "instagram_ru", dataJson: { followersCount: 306, views1d: 63_394, likes1d: 1_227 }, updatedAt: now })
        .run();
      const dashboard = studioAnalyticsDashboard(backendDb, "video", 1, "ru");
      expect(dashboard.text).not.toContain("Аккаунт ·");
      expect(dashboard.text).not.toContain("Instagram RU | 306");
      expect(dashboard.text).toContain("| Видео | Площадка | 👁 | ♥ | 💬 | ↗ | 🔖 |");
      expect(dashboard.text).toContain("| Все | — | 200 | 20 | 0 | 7 | 5 |");
      expect(dashboard.text).toContain("| Симулятор… | 📸 RU | 200 | 20 | 0 | 7 | 5 |");
      expect(dashboard.text).not.toContain("| Симулятор… | ▶️ RU |");
      expect(dashboard.richHtml.match(/<table bordered striped>/g)?.length).toBe(1);
      expect(dashboard.richHtml).not.toContain("|:--");
      const overview = studioAnalyticsDashboard(backendDb, "overview", 1, "ru");
      expect(overview.text).not.toContain("Симулятор…");
      expect(overview.richHtml.match(/<table bordered striped>/g)?.length).toBe(1);
    });
  });

  it("renders only newly published text posts in the posting section", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 1, ru: "Релиз новой функции", now });
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:1", target: "telegram", status: "published", updatedAt: now })
        .run();
      backendDb.db
        .insert(metricSamples)
        .values([
          { publicationKey: "post:1", target: "telegram", metricName: "views", value: 200, sampledAt: now },
          { publicationKey: "post:1", target: "telegram", metricName: "likes", value: 20, sampledAt: now },
          { publicationKey: "post:1", target: "telegram", metricName: "reposts", value: 7, sampledAt: now },
        ])
        .run();
      const dashboard = studioAnalyticsDashboard(backendDb, "posts", 1, "ru");
      expect(dashboard.text).toContain("| Пост | Площадка | 👁 | ♥ | 💬 | ↗ | 🔖 |");
      expect(dashboard.text).toContain("| Все | — | 200 | 20 | 0 | 7 | — |");
      expect(dashboard.text).toContain("| Релиз нов… | ✈️ RU | 200 | 20 | 0 | 7 | — |");
      expect(dashboard.richHtml.match(/<table bordered striped>/g)?.length).toBe(1);
    });
  });

  it("renders text publication platforms in their own labeled column", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 2, en: "Platform labels", now });
      const targets = ["threads_en", "x", "telegram", "discord"];
      backendDb.db
        .insert(publicationTargets)
        .values(targets.map((target) => ({ publicationKey: "post:2", target, status: "published", publishedAt: now, updatedAt: now })))
        .run();
      backendDb.db
        .insert(metricSamples)
        .values(
          targets.map((target, index) => ({ publicationKey: "post:2", target, metricName: "views", value: index + 1, sampledAt: now })),
        )
        .run();

      const dashboard = studioAnalyticsDashboard(backendDb, "posts", 1, "en").text;
      for (const platform of ["🧵 EN", "𝕏 EN", "✈️ RU", "🎮 EN"]) expect(dashboard).toContain(`| ${platform} |`);
    });
  });

  it("keeps the 30-day baseline a 30-day report needs after retention runs", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const publishedAt = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString();
      // Before the 30-day window opens: this is the checkpoint the delta is
      // measured from, and the sample retention used to delete after 7 days.
      const beforePeriod = new Date(Date.now() - 33 * 24 * 60 * 60_000).toISOString();
      seedTextPost(backendDb, { postId: 1, ru: "Старый пост", now: publishedAt });
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:1", target: "telegram", status: "published", publishedAt, updatedAt: now })
        .run();
      backendDb.db
        .insert(metricSamples)
        .values([
          { publicationKey: "post:1", target: "telegram", metricName: "views", value: 900, sampledAt: beforePeriod },
          { publicationKey: "post:1", target: "telegram", metricName: "views", value: 950, sampledAt: now },
        ])
        .run();
      pruneMetricSamples(backendDb);
      // 50 views of growth, not 950 lifetime and not a dropped row: with the
      // baseline pruned there is no third answer the report could give.
      expect(studioAnalyticsDashboard(backendDb, "overview", 30, "ru").text).toContain("| Telegram | 0 | — | 50 |");
    });
  });

  /** Seven emoji headers with no legend, and rows carrying nothing at all,
   * cost the same screen height as the platform that earned the views. */
  it("names the columns and folds a platform with nothing to report", async () => {
    await withDb(async (backendDb) => {
      registerTestChannels(backendDb, ["telegram", "instagram_ru", "telegram_stories"]);
      const now = new Date().toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values([
          { platform: "telegram", dataJson: { followersCount: 142 }, updatedAt: now },
          { platform: "instagram_ru", dataJson: { followersCount: 273 }, updatedAt: now },
          { platform: "telegram_stories", dataJson: { followersCount: 0 }, updatedAt: now },
        ])
        .run();

      const overview = studioAnalyticsDashboard(backendDb, "overview", 7, "ru").text;

      expect(overview).toContain("👥 аудитория");
      expect(overview).toContain("Тихо за период: Telegram Stories");
      // An audience with no activity is still an audience, and keeps its row.
      expect(overview).toContain("| Instagram RU | 273 |");
      expect(overview).toContain("| Telegram | 142 |");
    });
  });

  it("scopes the audience to the connected video platforms", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values([
          { platform: "telegram", dataJson: { followersCount: 130 }, updatedAt: now },
          { platform: "youtube_ru", dataJson: { subscriberCount: 120 }, updatedAt: now },
          { platform: "instagram_ru", dataJson: { followersCount: 306 }, updatedAt: now },
        ])
        .run();
      const overview = studioAnalyticsDashboard(backendDb, "overview", 7, "ru").text;
      const audience = studioAnalyticsDashboard(backendDb, "audience", 7, "ru").text;
      expect(overview).toContain("| Все | 556 | —");
      expect(
        overview
          .split("\n")
          .slice(2)
          .map((row) => row.split("|")[1]?.trim()),
      ).toEqual(["Instagram RU", "Telegram", "YouTube RU", "Все"]);
      expect(audience).toContain("Instagram");
      expect(audience).toContain("YouTube");
      expect(audience).toContain("Telegram");

      backendDb.channels.disable("instagram_en", now);
      backendDb.channels.disable("instagram_ru", now);
      const withoutInstagram = studioAnalyticsDashboard(backendDb, "audience", 7, "ru").text;
      expect(withoutInstagram).not.toContain("Instagram");
      expect(withoutInstagram).toContain("YouTube");
    });
  });

  it("uses human channel names and excludes disconnected profile history", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values([
          { platform: "telegram_stories", dataJson: { views1d: 175, likes1d: 3 }, updatedAt: now },
          { platform: "instagram_stories_ru", dataJson: { views1d: 35 }, updatedAt: now },
          { platform: "instagram_legacy", dataJson: { followersCount: 999, views1d: 999 }, updatedAt: now },
        ])
        .run();

      const overview = studioAnalyticsDashboard(backendDb, "overview", 1, "en").text;
      expect(overview).toContain("| Telegram Stories | 0 | — | 175 | 3 |");
      expect(overview).toContain("| Instagram Stories RU | 0 | — | 35 |");
      expect(overview).not.toContain("telegram_stories");
      expect(overview).not.toContain("instagram_stories_ru");
      expect(overview).not.toContain("instagram_legacy");

      backendDb.channels.disable("instagram_stories_ru", now);
      expect(studioAnalyticsDashboard(backendDb, "overview", 1, "en").text).not.toContain("Instagram Stories RU");
    });
  });

  it("keeps the overview compact when a requested period predates collected history", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(metricSamples)
        .values({ publicationKey: "post:1", target: "telegram", metricName: "views", value: 10, sampledAt: now })
        .run();
      const dashboard = studioAnalyticsDashboard(backendDb, "posts", 30, "en").text;
      expect(dashboard).not.toContain("History has been collected since");
    });
  });
});

describe("analytics screen navigation", () => {
  it("offers a way into the archive from the dashboard", async () => {
    await withDb(async (backendDb) => {
      let markup = "";
      const ctx = {
        from: { id: 42 },
        chat: { id: 42 },
        callbackQuery: { message: { message_id: 5 } },
        editMessageText: async (_text: unknown, options: { reply_markup?: unknown }) => {
          markup = JSON.stringify(options.reply_markup);
          return true;
        },
      } as unknown as Parameters<typeof showAnalyticsDashboard>[0];

      await showAnalyticsDashboard(ctx, backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }), "overview", 7);

      // Every archive screen links back to "archive_home"; for a while nothing
      // linked in, and the whole archive was unreachable from the bot.
      expect(markup).toContain("archive_home");
    });
  });
});
