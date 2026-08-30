import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { evaluateAudienceMilestones, milestoneState } from "../src/analytics/audience-milestones.js";
import { audienceGrowthByPlatform, youtubeChannelViewDeltaSince } from "../src/analytics/metric-deltas.js";
import { studioAnalyticsDashboard } from "../src/analytics/reports/studio-dashboard.js";
import { recordProfileSnapshot } from "../src/analytics/snapshots/creator-store.js";
import { registerChannel } from "../src/channels/registry.js";
import { creatorProfileSnapshots, creatorProfiles, publicationEvents, videoMetricSnapshots } from "../src/db/schema.js";
import { settingsService } from "../src/studio/services/settings.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { registerTestChannels } from "./helpers/channels.js";
import { withDb } from "./helpers/db.js";

describe("creator analytics deltas", () => {
  it("changes audience growth with the selected period instead of repeating lifetime totals", async () => {
    await withDb(async (backendDb) => {
      registerTestChannels(backendDb, ["telegram"]);
      const now = new Date().toISOString();
      const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60_000).toISOString();
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values({ platform: "telegram", dataJson: { subscriberCount: 150 }, updatedAt: now })
        .run();
      backendDb.db
        .insert(creatorProfileSnapshots)
        .values([
          {
            platform: "telegram",
            account: "channel",
            sampledOn: "2026-06-11",
            metricsJson: { subscriberCount: 100 },
            source: "test",
            sampledAt: thirtyFiveDaysAgo,
          },
          {
            platform: "telegram",
            account: "channel",
            sampledOn: "2026-07-06",
            metricsJson: { subscriberCount: 120 },
            source: "test",
            sampledAt: tenDaysAgo,
          },
          {
            platform: "telegram",
            account: "channel",
            sampledOn: "2026-07-16",
            metricsJson: { subscriberCount: 150 },
            source: "test",
            sampledAt: now,
          },
        ])
        .run();
      const week = studioAnalyticsDashboard(backendDb, "audience", 7, "ru").text;
      const month = studioAnalyticsDashboard(backendDb, "audience", 30, "ru").text;
      expect(week).toContain("Аудитория · 7 дней");
      expect(week).toContain("прирост · 7 дней: *+30*");
      expect(month).toContain("Аудитория · 30 дней");
      expect(month).toContain("прирост · 30 дней: *+50*");
    });
  });

  it("does not mix a replaced account's audience history into the current account", async () => {
    await withDb(async (backendDb) => {
      const now = new Date();
      const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
      const sample = (account: string, followers: number, at: Date) => ({
        platform: "instagram_ru",
        account,
        sampledOn: at.toISOString().slice(0, 10),
        metricsJson: { followersCount: followers },
        source: "test",
        sampledAt: at.toISOString(),
      });
      backendDb.db
        .insert(creatorProfileSnapshots)
        .values([
          sample("old-account", 100, new Date(since.getTime() - 24 * 60 * 60_000)),
          sample("old-account", 140, new Date(since.getTime() + 24 * 60 * 60_000)),
          sample("current-account", 20, new Date(since.getTime() - 60_000)),
          sample("current-account", 25, now),
        ])
        .run();

      expect(audienceGrowthByPlatform(backendDb, since.toISOString(), 7, now.toISOString(), false).get("instagram_ru")).toBe(5);
    });
  });

  it("uses YouTube's native gained and lost subscriber reports for each selected period", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values({
          platform: "youtube_ru",
          dataJson: { subscriberCount: 120, subscribersGained1d: 9, subscribersLost1d: 2, subscribersGained7d: 28, subscribersLost7d: 5 },
          updatedAt: now,
        })
        .run();
      const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
      expect(audienceGrowthByPlatform(backendDb, since, 1).get("youtube_ru")).toBe(7);
      expect(audienceGrowthByPlatform(backendDb, since, 7).get("youtube_ru")).toBe(23);
    });
  });

  it("falls back to hourly YouTube and tracked-video deltas while the daily report is pending", async () => {
    await withDb(async (backendDb) => {
      const now = new Date();
      const before = new Date(now.getTime() - 25 * 60 * 60_000).toISOString();
      const current = now.toISOString();
      const { targetId } = insertPublishedVideo(backendDb, {
        label: "Новый Short",
        target: "youtube_shorts",
        publishedAt: current,
        externalId: "video-1",
      });
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({
          videoTargetId: targetId,
          platform: "youtube_shorts",
          metricsJson: { views: 6, likes: 2, comments: 1 },
          sampledAt: current,
        })
        .run();
      backendDb.db
        .insert(creatorProfileSnapshots)
        .values([
          {
            platform: "youtube_ru",
            account: "marux",
            sampledOn: "2026-07-18T10",
            metricsJson: { viewCount: 100, subscriberCount: 122 },
            source: "youtube_data_api",
            sampledAt: before,
          },
          {
            platform: "youtube_ru",
            account: "marux",
            sampledOn: "2026-07-19T11",
            metricsJson: { viewCount: 150, subscriberCount: 124 },
            source: "youtube_data_api",
            sampledAt: current,
          },
        ])
        .run();
      backendDb.db
        .insert(creatorProfiles)
        .values({
          platform: "youtube_ru",
          dataJson: { subscriberCount: 124, views1d: 0, likes1d: 0, comments1d: 0, shares1d: 0 },
          updatedAt: current,
        })
        .run();
      registerChannel(backendDb, { platform: "youtube", locale: "ru", provider: "native", label: "YouTube RU" });

      const dashboard = studioAnalyticsDashboard(backendDb, "overview", 1, "ru");
      expect(dashboard.text).toContain("| YouTube RU | 124 | +2 | 50 | 2 | 1 | — | — |");
    });
  });

  it("does not label a stale YouTube channel snapshot as a 24-hour delta", async () => {
    await withDb(async (backendDb) => {
      const now = new Date();
      const stale = new Date(now.getTime() - 48 * 60 * 60_000).toISOString();
      backendDb.db
        .insert(creatorProfileSnapshots)
        .values([
          {
            platform: "youtube_ru",
            account: "marux",
            // The bucket is the day the reading belongs to, not a label for it.
            sampledOn: stale.slice(0, 10),
            metricsJson: { viewCount: 100 },
            source: "youtube_data_api",
            sampledAt: stale,
          },
          {
            platform: "youtube_ru",
            account: "marux",
            sampledOn: now.toISOString().slice(0, 10),
            metricsJson: { viewCount: 300 },
            source: "youtube_data_api",
            sampledAt: now.toISOString(),
          },
        ])
        .run();
      expect(youtubeChannelViewDeltaSince(backendDb, new Date(now.getTime() - 24 * 60 * 60_000).toISOString(), "youtube_ru")).toBeNull();
    });
  });

  it("baselines new channels and evaluates channel, language, group and project milestones after the cycle", async () => {
    await withDb(async (backendDb) => {
      registerChannel(backendDb, { platform: "youtube", locale: "ru", provider: "native", label: "YouTube RU" });
      registerChannel(backendDb, {
        platform: "telegram",
        locale: "ru",
        provider: "native",
        targetId: "telegram",
        label: "Telegram RU",
      });
      recordProfileSnapshot(backendDb, {
        platform: "youtube_ru",
        account: "channel",
        source: "test",
        metrics: { subscriberCount: 493 },
      });
      recordProfileSnapshot(backendDb, {
        platform: "telegram",
        account: "channel",
        source: "test",
        metrics: { followersCount: 0 },
      });
      expect(evaluateAudienceMilestones(backendDb)).toBe(0);

      recordProfileSnapshot(backendDb, {
        platform: "youtube_ru",
        account: "channel",
        source: "test",
        metrics: { subscriberCount: 500 },
      });
      recordProfileSnapshot(backendDb, {
        platform: "telegram",
        account: "channel",
        source: "test",
        metrics: { followersCount: 100 },
      });
      expect(evaluateAudienceMilestones(backendDb)).toBe(6);

      const milestones = backendDb.db
        .select({ message: publicationEvents.message })
        .from(publicationEvents)
        .where(eq(publicationEvents.eventType, "analytics.milestone.reached"))
        .all()
        .map((row) => row.message);
      expect(milestones).toContain("🎉 YouTube RU: 500 подписчиков!");
      expect(milestones).toContain("🏆 🇷🇺 Видео RU-каналы: 500 подписчиков!");
      expect(milestones).toContain("🎉 Telegram RU: 100 подписчиков!");
      expect(milestones).toContain("🏆 🇷🇺 Текстовые RU-каналы: 100 подписчиков!");
      expect(milestones).toContain("🏆 🇷🇺 Все RU-каналы: 500 подписчиков!");
      expect(milestones).toContain("🏆 Все площадки: 500 подписчиков!");
      expect(evaluateAudienceMilestones(backendDb)).toBe(0);

      registerChannel(backendDb, { platform: "instagram", locale: "en", provider: "native", label: "Instagram EN" });
      recordProfileSnapshot(backendDb, {
        platform: "instagram_en",
        account: "new-channel",
        source: "test",
        metrics: { followersCount: 600 },
      });
      expect(evaluateAudienceMilestones(backendDb)).toBe(0);
    });
  });

  // The defect this state shape exists for: Instagram Stories was registered as
  // a second audience for one account, the RU scopes counted it twice for five
  // days, and 1000 was marked as passed while nothing was announced. When the
  // duplicate went away the real 1000, weeks later, had to still arrive.
  it("withdraws the thresholds an account counted twice was holding up", async () => {
    await withDb(async (backendDb) => {
      registerChannel(backendDb, { platform: "youtube", locale: "ru", provider: "native", label: "YouTube RU" });
      recordProfileSnapshot(backendDb, { platform: "youtube_ru", account: "channel", source: "test", metrics: { subscriberCount: 400 } });
      expect(evaluateAudienceMilestones(backendDb)).toBe(0);

      const duplicate = registerChannel(backendDb, { platform: "instagram", locale: "ru", provider: "native", label: "Instagram RU" });
      recordProfileSnapshot(backendDb, {
        platform: "instagram_ru",
        account: "channel",
        source: "test",
        metrics: { followersCount: 700 },
      });
      // 1100 across the language, and not one of it announced: a new member is
      // a new baseline, never growth.
      expect(evaluateAudienceMilestones(backendDb)).toBe(0);

      backendDb.channels.disable(duplicate.id, new Date().toISOString());
      // The scope shrank back to one account, and is credited only with what
      // that account actually holds.
      expect(evaluateAudienceMilestones(backendDb)).toBe(0);
      expect(milestoneState(backendDb, "locale:ru")?.reachedThrough).toBe(400);

      recordProfileSnapshot(backendDb, { platform: "youtube_ru", account: "channel", source: "test", metrics: { subscriberCount: 1003 } });
      const messages = () =>
        backendDb.db
          .select({ message: publicationEvents.message })
          .from(publicationEvents)
          .where(eq(publicationEvents.eventType, "analytics.milestone.reached"))
          .all()
          .map((row) => row.message);
      expect(evaluateAudienceMilestones(backendDb)).toBeGreaterThan(0);
      expect(messages()).toContain("🏆 🇷🇺 Все RU-каналы: 1000 подписчиков!");
      // One line per scope, naming the highest count passed, not a burst of
      // every threshold between the old audience and the new one.
      expect(messages().filter((message) => message.startsWith("🎉 YouTube RU"))).toEqual(["🎉 YouTube RU: 1000 подписчиков!"]);
    });
  });

  it("announces nothing for a scope the Studio switched off, and credits it anyway", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setMilestones({ channelEnabled: false, thresholds: [1000] });
      registerChannel(backendDb, { platform: "youtube", locale: "ru", provider: "native", label: "YouTube RU" });
      recordProfileSnapshot(backendDb, { platform: "youtube_ru", account: "channel", source: "test", metrics: { subscriberCount: 900 } });
      expect(evaluateAudienceMilestones(backendDb)).toBe(0);

      recordProfileSnapshot(backendDb, { platform: "youtube_ru", account: "channel", source: "test", metrics: { subscriberCount: 1001 } });
      // Only the language, group and project scopes speak; the channel scope is off.
      expect(evaluateAudienceMilestones(backendDb)).toBe(3);
      expect(milestoneState(backendDb, "channel:youtube_ru")?.reachedThrough).toBe(1000);

      settingsService(backendDb).setMilestones({ channelEnabled: true });
      expect(evaluateAudienceMilestones(backendDb)).toBe(0);
    });
  });

  it("rebases milestones when a route is connected to another account", async () => {
    await withDb(async (backendDb) => {
      registerChannel(backendDb, {
        platform: "instagram",
        locale: "ru",
        provider: "zernio",
        providerAccountId: "old-account",
      });
      recordProfileSnapshot(backendDb, {
        platform: "instagram_ru",
        account: "old-account",
        source: "test",
        metrics: { followersCount: 100 },
      });
      expect(evaluateAudienceMilestones(backendDb)).toBe(0);

      registerChannel(backendDb, {
        platform: "instagram",
        locale: "ru",
        provider: "zernio",
        providerAccountId: "new-account",
      });
      recordProfileSnapshot(backendDb, {
        platform: "instagram_ru",
        account: "new-account",
        source: "test",
        metrics: { followersCount: 10_000 },
      });

      expect(evaluateAudienceMilestones(backendDb)).toBe(0);
    });
  });
});
