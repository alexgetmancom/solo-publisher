import { describe, expect, it } from "bun:test";
import type { PipelinePost } from "../src/analytics/pipeline-payload.js";
import { calendarDays } from "../src/analytics/reach/daily-reach.js";
import { textDailyReach, textOverviewOf } from "../src/analytics/reach/text-overview.js";
import type { XActivityDashboardItem } from "../src/analytics/x-activity-dashboard.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { creatorProfileSnapshots, videoDrafts, videoMetricSnapshots, videoTargets } from "../src/db/schema.js";
import { type CombinedSectionInput, renderCombinedSection } from "../src/interfaces/web/dashboard/combined-section.js";
import { renderHeroCard } from "../src/interfaces/web/dashboard/hero-section.js";
import { buildOverviewData, loadDashboardReadModel } from "../src/interfaces/web/dashboard/overview-data.js";
import {
  createVideoOverviewCache,
  emptyVideoOverview,
  setVideoOverviewCacheRange,
  videoOverview,
} from "../src/interfaces/web/dashboard/video-overview.js";
import { videoAnalyticsBundle } from "../src/interfaces/web/dashboard/video-overview-data.js";
import { xActivityPost } from "../src/interfaces/web/dashboard/x-activity-posts.js";
import { registerTestChannels, VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { withOpenDb } from "./helpers/db.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoAsset } from "./helpers/video.js";

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

function openOverviewDb() {
  const memory = ":memory:";
  const backendDb = openBackendDb(memory);
  registerTestChannels(backendDb, VIDEO_TEST_CHANNELS);
  return backendDb;
}

const withOverviewDb = <T>(fn: (backendDb: UnsafeBackendDb) => T | Promise<T>): Promise<T> => withOpenDb(openOverviewDb, fn);

/** rollingPeriodDates hands the renderer a UTC-midnight Date carrying the
 * zone's calendar fields; the chart reads it back with getUTC*. */
function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function seedVideo(backendDb: ReturnType<typeof openBackendDb>, publishedAt = hoursAgo(3)): void {
  const draft = backendDb.db
    .insert(videoDrafts)
    .values({
      actorId: 1,
      locale: "ru",
      label: "Seedance 2.5",
      studioMediaAssetId: createTestVideoAsset(backendDb),
      status: "published",
      createdAt: publishedAt,
      updatedAt: publishedAt,
    })
    .returning({ id: videoDrafts.id })
    .get();
  const target = backendDb.db
    .insert(videoTargets)
    .values({
      videoDraftId: draft.id,
      target: "youtube_shorts",
      metadataJson: { title: "Seedance 2.5", description: "", tags: [], videoDurationMs: 24_000 },
      status: "published",
      publishedAt,
      externalUrl: "https://youtube.com/shorts/abc",
      createdAt: publishedAt,
      updatedAt: publishedAt,
    })
    .returning({ id: videoTargets.id })
    .get();
  // Two observations of the same target: the later one must replace the earlier,
  // not be added to it.
  for (const [hours, views] of [
    [3, 400],
    [1, 1_000],
  ] as const)
    backendDb.db
      .insert(videoMetricSnapshots)
      .values({
        videoTargetId: target.id,
        platform: "youtube_shorts",
        metricsJson: {
          views,
          likes: views / 10,
          comments: 4,
          ...(hours === 1 ? { totalWatchTimeMs: 12_000_000 } : {}),
        },
        sampledAt: hoursAgo(hours),
      })
      .run();
  backendDb.db
    .insert(creatorProfileSnapshots)
    .values({
      platform: "youtube_ru",
      account: "alexgetman",
      sampledOn: new Date().toISOString().slice(0, 10),
      metricsJson: { subscriberCount: 8_400 },
      source: "fixture",
      sampledAt: hoursAgo(1),
    })
    .run();
}

function seedLocalizedVideoProfiles(backendDb: ReturnType<typeof openBackendDb>): void {
  for (const [platform, account, followers] of [
    ["youtube_ru", "Marux_play", 8_400],
    ["youtube_en", "Marux_plays", 1_260],
    ["instagram_ru", "marux_play", 5_120],
    ["instagram_en", "marux_plays", 940],
  ] as const)
    backendDb.db
      .insert(creatorProfileSnapshots)
      .values({
        platform,
        account,
        sampledOn: new Date().toISOString().slice(0, 10),
        metricsJson: { subscriberCount: followers },
        source: "fixture",
        sampledAt: new Date().toISOString(),
      })
      .run();
}

function seedHistoricalVideo(backendDb: ReturnType<typeof openBackendDb>): void {
  const publishedAt = "2026-07-30T08:00:00.000Z";
  const draft = backendDb.db
    .insert(videoDrafts)
    .values({
      actorId: 1,
      locale: "ru",
      label: "Historical clip",
      studioMediaAssetId: createTestVideoAsset(backendDb),
      status: "published",
      createdAt: publishedAt,
      updatedAt: publishedAt,
    })
    .returning({ id: videoDrafts.id })
    .get();
  const target = backendDb.db
    .insert(videoTargets)
    .values({
      videoDraftId: draft.id,
      target: "youtube_shorts",
      metadataJson: { title: "Historical clip", description: "", tags: [] },
      status: "published",
      publishedAt,
      externalUrl: "https://youtube.com/shorts/historical",
      createdAt: publishedAt,
      updatedAt: publishedAt,
    })
    .returning({ id: videoTargets.id })
    .get();
  for (const [sampledAt, views] of [
    ["2026-07-30T12:00:00.000Z", 100],
    ["2026-07-30T20:00:00.000Z", 800],
    ["2026-07-31T20:00:00.000Z", 1_500],
    ["2026-08-01T20:00:00.000Z", 2_300],
  ] as const)
    backendDb.db
      .insert(videoMetricSnapshots)
      .values({
        videoTargetId: target.id,
        platform: "youtube_shorts",
        metricsJson: { views, likes: views / 10, comments: 2 },
        sampledAt,
      })
      .run();
  backendDb.db
    .insert(creatorProfileSnapshots)
    .values([
      {
        platform: "youtube_ru",
        account: "marux",
        sampledOn: "2026-07-29T20",
        metricsJson: { subscriberCount: 100 },
        source: "fixture",
        sampledAt: "2026-07-29T20:00:00.000Z",
      },
      {
        platform: "youtube_ru",
        account: "marux",
        sampledOn: "2026-07-30T20",
        metricsJson: { subscriberCount: 107 },
        source: "fixture",
        sampledAt: "2026-07-30T20:00:00.000Z",
      },
    ])
    .run();
}

/** The renderer reads daily reach, which the read model derives from these very
 * posts; the tests derive it the same way instead of restating the numbers. */
function renderOverview(
  input: Omit<CombinedSectionInput, "textReach" | "videoReach" | "textLocales" | "videoLocales"> &
    Partial<Pick<CombinedSectionInput, "textLocales" | "videoLocales">>,
): string {
  const start = new Date(input.rangeEnd);
  start.setUTCDate(start.getUTCDate() - (input.periodDays + 40));
  const days = calendarDays(start, new Date(input.rangeEnd.getTime() + 86_400_000 - 1), "UTC");
  // Without a database the X rows arrive as items, so they stand in for the
  // series the read model would load — including the rule that an X row wins
  // over the pipeline's own copy of the same tweet.
  const items = input.xItems ?? [];
  const covered = new Set(items.map((item) => item.linkedPublicationKey).filter(Boolean));
  const posts = [...(input.data?.posts ?? []), ...(input.previousData?.posts ?? [])].map((post) =>
    post.publication_key && covered.has(post.publication_key) ? { ...post, targets: { ...post.targets, x: undefined } } : post,
  );
  return String(
    renderCombinedSection(
      {
        textLocales: ["ru", "en"],
        videoLocales: ["ru", "en"],
        ...input,
        videoReach: input.video.dailyByDay,
        textReach: textOverviewOf([...posts, ...items.map(xActivityPost)], [], days, "UTC"),
      },
      "ru",
    ),
  );
}

/** The two locale columns of a track's platform legend, RU first. */
function localeColumns(html: string, kind: "text" | "video"): [string, string] {
  const start = html.indexOf(`class="overview-track overview-track--${kind}`);
  const rows = html.indexOf('<div class="overview-platforms__rows">', start);
  const stop = html.indexOf('<div class="overview-publications"', rows);
  const columns = html
    .slice(rows, stop < 0 ? undefined : stop)
    .split('<div class="overview-platforms__column">')
    .slice(1);
  return [columns[0] ?? "", columns[1] ?? ""];
}

function seedCrosspostedVideo(backendDb: ReturnType<typeof openBackendDb>): void {
  const publishedAt = hoursAgo(3);
  const draft = backendDb.db
    .insert(videoDrafts)
    .values({
      actorId: 1,
      locale: "ru",
      label: "Один ролик, две площадки",
      studioMediaAssetId: createTestVideoAsset(backendDb),
      status: "published",
      createdAt: publishedAt,
      updatedAt: publishedAt,
    })
    .returning({ id: videoDrafts.id })
    .get();
  for (const [target, views] of [
    ["youtube_shorts", 600],
    ["instagram_reels", 400],
  ] as const) {
    const row = backendDb.db
      .insert(videoTargets)
      .values({
        videoDraftId: draft.id,
        target,
        metadataJson: { title: "Один ролик, две площадки", description: "", tags: [] },
        status: "published",
        publishedAt,
        externalUrl: `https://example.com/${target}`,
        createdAt: publishedAt,
        updatedAt: publishedAt,
      })
      .returning({ id: videoTargets.id })
      .get();
    backendDb.db
      .insert(videoMetricSnapshots)
      .values({
        videoTargetId: row.id,
        platform: target,
        metricsJson: { views, likes: views / 10, comments: 1 },
        sampledAt: hoursAgo(1),
      })
      .run();
  }
}

/** One window, asked the way the dashboard asks it: a cache whose range is the
 * window, then the overview cut from that. The bucket matches what the read
 * model picks for a span of this length. */
function overviewFor(backendDb: ReturnType<typeof openOverviewDb>, start: Date, end: Date) {
  const cache = createVideoOverviewCache(end.getTime() - start.getTime() > 7 * 86_400_000 ? 86_400 : 3_600);
  setVideoOverviewCacheRange(cache, start, end);
  return videoOverview(backendDb, start, end, "Europe/Moscow", cache);
}

describe("unified overview video read model", () => {
  it("includes videos published during the selected current day", () =>
    withOverviewDb(async (backendDb) => {
      seedVideo(backendDb, new Date().toISOString());
      const config = loadTestConfig({});

      const readModel = loadDashboardReadModel(config, backendDb, createVideoOverviewCache(), 0, 1, undefined);
      const overview = buildOverviewData(readModel, undefined, "reach");

      expect(overview.video.items).toHaveLength(1);
      expect(overview.video.totals.posts).toBe(1);
    }));

  // The text side has always shown one row per post with a badge for the places
  // it went; a clip that went to two destinations now reads the same way.
  it("keeps one clip on two destinations as one publication", () =>
    withOverviewDb(async (backendDb) => {
      seedCrosspostedVideo(backendDb);
      const overview = overviewFor(backendDb, new Date(Date.now() - 86_400_000), new Date());

      expect(overview.items).toHaveLength(1);
      expect(overview.totals.posts).toBe(1);
      expect(overview.items[0]?.destinations.map((destination) => destination.label)).toEqual(["YouTube RU", "Instagram RU"]);
      expect(overview.items[0]?.views).toBe(1_000);
      // The badge counts destinations, and the best performing one owns the link.
      expect(overview.items[0]?.url).toBe("https://example.com/youtube_shorts");
      // Both destinations still stand on their own in the platform panel.
      expect(overview.platforms.filter((platform) => platform.views > 0).map((platform) => platform.views)).toEqual([600, 400]);
    }));

  it("reports the latest sample per publication and names the destination", () =>
    withOverviewDb(async (backendDb) => {
      seedVideo(backendDb);
      const overview = overviewFor(backendDb, new Date(Date.now() - 86_400_000), new Date());

      expect(overview.items).toHaveLength(1);
      expect(overview.totals.views).toBe(1_000);
      expect(overview.totals.reactions).toBe(100);
      // Comments are the video answer to replies.
      expect(overview.totals.replies).toBe(4);
      expect(overview.items[0]?.url).toBe("https://youtube.com/shorts/abc");
      // The platform alone is not the destination: a Russian draft on Shorts is
      // the Russian channel.
      expect(overview.items[0]?.destinations.map((destination) => destination.label)).toEqual(["YouTube RU"]);

      expect(overview.platforms.map((platform) => platform.label)).toEqual(["YouTube RU"]);
      expect(overview.platforms[0]?.views).toBe(1_000);
      // The Russian destination has its own audience snapshot.
      expect(overview.platforms[0]?.followers).toBe(8_400);
      expect(overview.summary.completionRate).toBe(50);
      expect(overview.summary.subscribers).toBeNull();
    }));

  it("uses a collected permalink when an older video target has no stored URL", () =>
    withOverviewDb(async (backendDb) => {
      const publishedAt = hoursAgo(3);
      const draft = backendDb.db
        .insert(videoDrafts)
        .values({
          actorId: 1,
          locale: "ru",
          label: "Instagram reel",
          studioMediaAssetId: createTestVideoAsset(backendDb),
          status: "published",
          createdAt: publishedAt,
          updatedAt: publishedAt,
        })
        .returning({ id: videoDrafts.id })
        .get();
      const target = backendDb.db
        .insert(videoTargets)
        .values({
          videoDraftId: draft.id,
          target: "instagram_reels",
          metadataJson: {},
          status: "published",
          publishedAt,
          externalId: "ig-media-1",
          createdAt: publishedAt,
          updatedAt: publishedAt,
        })
        .returning({ id: videoTargets.id })
        .get();
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({
          videoTargetId: target.id,
          platform: "instagram_reels",
          metricsJson: { views: 120, likes: 12, comments: 3, url: "https://www.instagram.com/reel/CODE123/" },
          sampledAt: hoursAgo(1),
        })
        .run();

      const overview = overviewFor(backendDb, new Date(Date.now() - 86_400_000), new Date());

      expect(overview.items[0]?.url).toBe("https://www.instagram.com/reel/CODE123/");
    }));

  it("keeps declared destinations and their audiences independent of the period", () =>
    withOverviewDb(async (backendDb) => {
      seedVideo(backendDb);
      seedLocalizedVideoProfiles(backendDb);
      const overview = overviewFor(backendDb, new Date(Date.now() - 86_400_000), new Date());

      expect(overview.platforms.map((platform) => platform.label)).toEqual(["YouTube RU", "YouTube EN", "Instagram RU", "Instagram EN"]);
      expect(overview.platforms.map((platform) => platform.followers)).toEqual([16_800, 1_260, 5_120, 940]);
      expect(overview.platforms.map((platform) => platform.views)).toEqual([1_000, 0, 0, 0]);

      const quiet = overviewFor(backendDb, new Date(Date.now() - 10 * 86_400_000), new Date(Date.now() - 5 * 86_400_000));
      expect(quiet.platforms.map((platform) => platform.label)).toEqual(["YouTube RU", "YouTube EN", "Instagram RU", "Instagram EN"]);
      expect(quiet.platforms.every((platform) => platform.views === 0)).toBe(true);
    }));

  it("excludes publications outside the window", () =>
    withOverviewDb(async (backendDb) => {
      seedVideo(backendDb);
      const older = overviewFor(backendDb, new Date(Date.now() - 10 * 86_400_000), new Date(Date.now() - 5 * 86_400_000));
      expect(older.items).toHaveLength(0);
      expect(older.totals.views).toBe(0);
    }));

  it("freezes a historical period and exposes later lifetime growth separately", () =>
    withOverviewDb(async (backendDb) => {
      seedHistoricalVideo(backendDb);
      const overview = overviewFor(backendDb, new Date("2026-07-29T21:00:00.000Z"), new Date("2026-07-30T20:59:59.999Z"));

      // 800 by the last reading inside the period, plus the slice of the next
      // interval that the growth curve places before the period closed.
      expect(overview.totals.views).toBe(870);
      expect(overview.items[0]?.views).toBe(870);
      expect(overview.items[0]?.lifetimeViews).toBe(2_300);
      expect(overview.items[0]?.afterPeriodViews).toBe(1_500);
      expect(overview.summary.subscribers).toBe(7);
      expect(overview.dailyByDay["2026-07-30"]?.subscribers).toBe(7);
      expect(overview.dailyByDay["2026-07-30"]?.views).toBe(870);
      expect(overview.viewEvents.map((event) => event.value)).toEqual([100, 800]);
    }));

  it("sums daily increments for a multi-day period instead of lifetime totals", () =>
    withOverviewDb(async (backendDb) => {
      seedHistoricalVideo(backendDb);
      const overview = overviewFor(backendDb, new Date("2026-07-29T21:00:00.000Z"), new Date("2026-07-31T20:59:59.999Z"));

      expect(overview.totals.views).toBe(1_557);
      expect(overview.dailyByDay["2026-07-30"]?.views).toBe(843);
      expect(overview.dailyByDay["2026-07-31"]?.views).toBe(714);
      expect(overview.dailyByDay["2026-07-30"]?.subscribers).toBe(7);
      expect(overview.dailyByDay["2026-07-31"]?.subscribers).toBe(0);
      expect(overview.items[0]?.afterPeriodViews).toBe(800);
    }));

  // The bug this locks: a day used to mean "what clips published that day
  // earned" when it was the selected day, and "what the whole catalogue earned"
  // on every other bar of the same chart — 3k against 65k for one date.
  it("reports catalogue reach for a day whose clips were published earlier", () =>
    withOverviewDb(async (backendDb) => {
      seedHistoricalVideo(backendDb);
      const cache = createVideoOverviewCache(24 * 60 * 60);
      setVideoOverviewCacheRange(cache, new Date("2026-07-29T21:00:00.000Z"), new Date("2026-08-01T20:59:59.999Z"));
      const day = (start: string, end: string) => videoOverview(backendDb, new Date(start), new Date(end), "Europe/Moscow", cache);

      const publicationDay = day("2026-07-29T21:00:00.000Z", "2026-07-30T20:59:59.999Z");
      expect(publicationDay.totals.views).toBe(843);
      expect(publicationDay.dailyByDay["2026-07-30"]?.freshViews).toBe(843);
      expect(publicationDay.totals.posts).toBe(1);

      const quietDay = day("2026-07-30T21:00:00.000Z", "2026-07-31T20:59:59.999Z");
      expect(quietDay.totals.views).toBe(714);
      expect(quietDay.dailyByDay["2026-07-31"]?.views).toBe(714);
      expect(quietDay.dailyByDay["2026-07-31"]?.freshViews).toBe(0);
      expect(quietDay.totals.posts).toBe(0);
      expect(quietDay.platforms.find((platform) => platform.label === "YouTube RU")?.views).toBe(714);
    }));
});

describe("text daily reach", () => {
  const sampled = (values: Array<[string, number]>): PipelinePost => ({
    publication_key: "post:1",
    date: "2026-07-30T08:00:00.000Z",
    targets: { telegram: { status: "published" } },
    metrics: {
      telegram: {
        views: { value: values.at(-1)?.[1] ?? 0, samples: values.map(([sampled_at, value]) => ({ sampled_at, value })) },
      },
    },
  });

  // The text twin of the video fix: a day earns what arrived on it, whoever
  // published it and whenever.
  it("credits a later day with an older post's growth and marks it as back catalogue", () => {
    const overview = textOverviewOf(
      [
        sampled([
          ["2026-07-30T20:00:00.000Z", 800],
          ["2026-07-31T20:00:00.000Z", 1_500],
        ]),
      ],
      [],
      calendarDays(new Date("2026-07-30T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"), "UTC"),
      "UTC",
    );
    const daily = textDailyReach(overview, ["telegram"]);

    // The 700 gained between the two readings is spread along the growth curve
    // over the day and a half they span: the post is young at the start of that
    // stretch and nearly spent at its end, so most of it lands on the 30th.
    expect(daily["2026-07-30"]?.views).toBe(967);
    expect(daily["2026-07-30"]?.freshViews).toBe(967);
    expect(daily["2026-07-31"]?.views).toBe(533);
    expect(daily["2026-07-31"]?.freshViews).toBe(0);
    expect((daily["2026-07-30"]?.views ?? 0) + (daily["2026-07-31"]?.views ?? 0)).toBe(1_500);
  });

  it("spreads a publication first read a day later back over the days it earned", () => {
    // The X export is sent when the operator sends it, so a post that went out
    // on the 30th can be read for the first time on the 31st. That reading is
    // its lifetime, not the 31st's earnings — it used to count on neither, and
    // then on the 31st alone.
    const overview = textOverviewOf(
      [sampled([["2026-07-31T20:00:00.000Z", 1_500_000]])],
      [],
      calendarDays(new Date("2026-07-30T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"), "UTC"),
      "UTC",
    );
    const daily = textDailyReach(overview, ["telegram"]);

    expect(daily["2026-07-30"]?.views).toBe(689_362);
    expect(daily["2026-07-30"]?.freshViews).toBe(689_362);
    expect(daily["2026-07-31"]?.views).toBe(810_638);
  });

  // The shape itself, on the sampling this account actually has: one export,
  // weeks after the fact, is the only reading a post ever gets.
  it("lays a single late reading out along the growth curve", () => {
    const days = calendarDays(new Date("2026-07-30T00:00:00.000Z"), new Date("2026-08-29T23:59:59.999Z"), "UTC");
    const overview = textOverviewOf(
      [
        {
          publication_key: "post:3",
          date: "2026-07-30T00:00:00.000Z",
          targets: { telegram: { status: "published" } },
          metrics: {
            telegram: { views: { value: 1_000_000, samples: [{ sampled_at: "2026-08-29T00:00:00.000Z", value: 1_000_000 }] } },
          },
        },
      ],
      [],
      days,
      "UTC",
    );
    const daily = textDailyReach(overview, ["telegram"]);

    expect(daily["2026-07-30"]?.views).toBe(551_330);
    expect(daily["2026-07-31"]?.views).toBe(299_747);
    expect(daily["2026-08-01"]?.views).toBe(91_247);
    expect(daily["2026-08-02"]?.views).toBe(32_275);
    // Nothing is lost on the way: the bars still sum to what was measured.
    expect(days.reduce((total, day) => total + (daily[day.key]?.views ?? 0), 0)).toBe(1_000_002);
  });

  it("keeps an unsampled publication on its own day instead of dropping it", () => {
    const overview = textOverviewOf(
      [
        {
          publication_key: "post:2",
          date: "2026-07-30T08:00:00.000Z",
          targets: { telegram: { status: "published" } },
          metrics: { telegram: { views: { value: 250 } } },
        },
      ],
      [],
      calendarDays(new Date("2026-07-30T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"), "UTC"),
      "UTC",
    );
    const daily = textDailyReach(overview, ["telegram"]);

    expect(daily["2026-07-30"]?.views).toBe(250);
    expect(daily["2026-07-31"]?.views).toBe(0);
  });
});

describe("unified overview rendering", () => {
  const baseInput = {
    data: { posts: [] },
    previousData: { posts: [] },
    xItems: [],
    previousXItems: [],
    dayComparisonData: { posts: [] },
    previousVideo: emptyVideoOverview(),
    dayComparisonVideo: emptyVideoOverview(),
    followers: [{ key: "telegram", label: "Telegram", followers: 135 }],
    // The seeded samples are relative to now, so the window has to be too.
    rangeStart: today(),
    rangeEnd: today(),
    periodDays: 1,
    weekOffset: 0,
    timeZone: "Europe/Moscow",
    platformMetric: "reach" as const,
  };

  it("draws one locale column for a half that publishes one language", () =>
    withOverviewDb(async (backendDb) => {
      seedVideo(backendDb);
      const video = overviewFor(backendDb, new Date(Date.now() - 86_400_000), new Date());
      // The text half of a Studio with only Russian channels used to carry a
      // permanently empty EN column, an EN label and a "0% · 0" legend, while
      // its video half genuinely publishes in both.
      const html = renderOverview({ ...baseInput, video, textLocales: ["ru"] });
      const textPlatforms = html.slice(
        html.indexOf('class="overview-track overview-track--text'),
        html.indexOf('class="overview-track overview-track--video'),
      );
      const videoPlatforms = html.slice(html.indexOf('class="overview-track overview-track--video'));

      expect(textPlatforms).toContain("--locale-columns:1");
      expect(textPlatforms).not.toContain("<span>EN</span>");
      expect(videoPlatforms).toContain("--locale-columns:2");
      expect(videoPlatforms).toContain("<span>EN</span>");
    }));

  it("shows both halves separately and never their sum", () =>
    withOverviewDb(async (backendDb) => {
      seedVideo(backendDb);
      const video = overviewFor(backendDb, new Date(Date.now() - 86_400_000), new Date());
      const html = renderOverview({ ...baseInput, video });

      expect(html).toContain("<strong>1k</strong>");
      expect(html).toContain("Текст");
      expect(html).toContain("Видео");
      expect(html).toContain('class="overview-split"');
      expect(html).toContain('class="overview-track overview-track--text"');
      expect(html).toContain('class="overview-track overview-track--video"');
      expect(html).toContain('class="overview-spark"');
      expect(html).toContain('class="overview-spark__cap"');
      expect(html).not.toContain('class="overview-spark__head"');
      expect(html).not.toContain('class="overview-spark__view');
      expect(html).not.toContain("логарифмическая");
      expect(html).toContain("норма дня");
      expect(html).toContain("досмотры");
      expect(html).not.toContain('class="kpi-table');
      expect(html).not.toContain("kpi-table__row--head");
      expect(html).not.toContain("vs медиана за 30д");
      expect(html).not.toContain("вчера к этому времени");
      expect(html).not.toContain("Детальная динамика и публикации");
      expect(html).not.toContain('class="overview-details"');
      expect(html).not.toContain('class="metric-chart--dual"');
    }));

  it("compares a multi-day period with the previous thirty days of daily norm", () => {
    const post = (views: number, daysAgo: number): PipelinePost => ({
      date: new Date(Date.UTC(today().getUTCFullYear(), today().getUTCMonth(), today().getUTCDate() - daysAgo, 12)).toISOString(),
      targets: { telegram: { status: "published" } },
      metrics: { telegram: { views: { value: views } } },
    });
    const currentVideo = {
      ...emptyVideoOverview(),
      totals: { views: 300, reactions: 0, replies: 0, posts: 0 },
    };
    const previousVideo = {
      ...emptyVideoOverview(),
      totals: { views: 100, reactions: 0, replies: 0, posts: 0 },
    };
    const html = renderOverview({
      ...baseInput,
      periodDays: 30,
      data: { posts: Array.from({ length: 30 }, (_, index) => post(300, index)) },
      previousData: { posts: Array.from({ length: 30 }, (_, index) => post(100, index + 30)) },
      video: currentVideo,
      previousVideo,
    });

    // 9k over the period against a 100/day norm scaled to thirty days.
    expect(html).toContain("+200%");
    expect(html).not.toContain("vs прошлый период");
    expect(html).not.toContain("↑ 2900%");
  });

  it("does not show platform deltas while the selected period is still zero", () => {
    const post = (views: number, daysAgo: number): PipelinePost => ({
      date: new Date(Date.UTC(today().getUTCFullYear(), today().getUTCMonth(), today().getUTCDate() - daysAgo, 12)).toISOString(),
      targets: { telegram: { status: "published" } },
      metrics: { telegram: { views: { value: views } } },
    });
    const html = renderOverview({
      ...baseInput,
      periodDays: 30,
      data: { posts: [post(0, 0)] },
      previousData: { posts: [post(100, 40)] },
      video: emptyVideoOverview(),
    });

    expect(html).toContain("<strong>0</strong>");
    expect(html).not.toContain("−100%");
  });

  it("compares one-day totals with the previous 30-day median", () => {
    const post = (views: number, date: string): PipelinePost => ({
      date,
      targets: { telegram: { status: "published" } },
      metrics: { telegram: { views: { value: views } } },
    });
    const dayAt = (daysAgo: number) =>
      new Date(Date.UTC(today().getUTCFullYear(), today().getUTCMonth(), today().getUTCDate() - daysAgo, 12)).toISOString();
    const previousPosts = Array.from({ length: 30 }, (_, index) => post(100, dayAt(index + 1)));
    const html = renderOverview({
      ...baseInput,
      data: { posts: [post(200, dayAt(0))] },
      previousData: { posts: previousPosts },
      video: emptyVideoOverview(),
    });

    expect(html).toContain("+100%");
    expect(html).not.toContain("vs медиана за 30д");
    expect(html).toContain("<strong>200</strong>");
  });

  it("derives the locale badge from the data rather than from the platform name", () =>
    withOverviewDb(async (backendDb) => {
      seedVideo(backendDb);
      const video = overviewFor(backendDb, new Date(Date.now() - 86_400_000), new Date());
      // The seeded draft is Russian, so its platform is badged RU.
      expect(video.platforms.find((platform) => platform.target === "youtube_shorts")?.locales).toEqual(["RU"]);
      // Nothing published on Reels this period, so its language is unknown and
      // the panel must not invent one.
      expect(video.platforms.some((platform) => platform.target === "instagram_reels")).toBe(false);

      const html = renderOverview({
        ...baseInput,
        video,
        // Telegram declares "ru" and X declares "en" in the target table; the
        // panel must not be reading the "_ru"/"_en" suffix of the id.
        followers: [
          { key: "telegram", label: "Telegram", followers: 135 },
          { key: "x", label: "X", followers: 83 },
        ],
      });
      // The locale decides which column a destination stands in, and it must
      // come from the data rather than from a guessed suffix in the target id.
      const [ru, en] = localeColumns(html, "text");
      expect(ru).toContain('title="Telegram"');
      expect(en).toContain('title="X"');
      expect(ru).not.toContain('title="X"');
      // The badge is gone with the split: the column already names the locale.
      expect(html).not.toContain('class="overview-platform__name"');
    }));

  it("switches platform rows between reach and followers", () => {
    const followers = [
      { key: "telegram", label: "Telegram", followers: 135 },
      { key: "x", label: "X", followers: 85 },
    ];
    const reachHtml = renderOverview({ ...baseInput, followers, video: emptyVideoOverview() });
    const followerHtml = renderOverview({
      ...baseInput,
      followers,
      video: emptyVideoOverview(),
      videoView: "instagram_reels:ru",
      platformMetric: "followers",
    });

    expect(reachHtml).toContain('href="/command-center?period=1&amp;week_offset=0&amp;metric=followers"');
    expect(reachHtml).toContain('class="platform-metric-btn platform-metric-btn--active"');
    expect(followerHtml).toContain(">135</strong>");
    // The metric is named by the active switch itself; the panel carries no
    // separate heading repeating it.
    expect(followerHtml).toContain('aria-pressed="true">Подписчики</a>');
    expect(followerHtml).toContain('href="/command-center?period=1&amp;week_offset=0&amp;video_view=instagram_reels%3Aru"');
  });

  it("scopes the new overview to the selected text platform", () => {
    const post: PipelinePost = {
      publication_key: "scoped-post",
      date: hoursAgo(2),
      text_en: "Threads EN publication",
      targets: {
        threads_en: { status: "published" },
        telegram: { status: "published" },
      },
      metrics: {
        threads_en: { views: { value: 5_000 }, likes: { value: 20 }, replies: { value: 3 } },
        telegram: { views: { value: 200 }, likes: { value: 9 }, replies: { value: 1 } },
      },
    };
    const html = renderOverview({
      ...baseInput,
      data: { posts: [post] },
      video: emptyVideoOverview(),
      followers: [
        { key: "threads_en", label: "Threads EN", followers: 100 },
        { key: "telegram", label: "Telegram", followers: 200 },
      ],
      textTargetIds: ["threads_en"],
      textView: "threads_en",
    });

    expect(html).toContain("<strong>5k</strong>");
    // The selected destination is marked, and its own link is the way back out.
    expect(html).toContain('class="overview-platform overview-platform--active"');
    expect(html).toContain('title="Threads EN · снять фильтр"');
    expect(html).toContain('class="overview-track__filter" href="/command-center?period=1&amp;week_offset=0"');
    expect(html).not.toContain("Telegram");
    expect(html).toContain("Threads EN publication");
    expect(html).not.toContain("Детальная динамика и публикации");
  });

  it("turns the heading gauge green once the norm is beaten", () => {
    const metrics = {
      kind: "text" as const,
      views: 4_128,
      freshViews: 1_200,
      medianViews: 3_600,
      reactions: 147,
      replies: 23,
      reposts: 9,
      conversationViews: 0,
      engagementRate: 3.6,
      countLabel: "3 поста сегодня",
      normLabel: "норма дня",
      contextLabel: "ОХВАТ · 2 АВГ",
      paceLabel: "норма побита · прогноз 9.3k",
      projectionViews: 9_300,
      progressPercent: 114,
    };
    const won = String(renderHeroCard(metrics, "ru"));
    const behind = String(renderHeroCard({ ...metrics, views: 1_200, paceLabel: "до нормы 2.4k", progressPercent: 33 }, "ru"));

    expect(won).toContain("overview-hero-card__heading--win");
    // The norm is an aside on the number's line, not a stacked second KPI.
    expect(won).toContain("норма дня · <b>3.6k</b>");
    // The headline number says which part of it is today's own output.
    expect(won).toContain("<b>1.2k</b> новые");
    expect(won).toContain("<b>2.9k</b> каталог");
    expect(won).not.toContain("Просмотры");
    expect(behind).not.toContain("overview-hero-card__heading--win");
  });

  it("sorts text and video platform rows by the selected metric", () => {
    const post: PipelinePost = {
      date: today().toISOString(),
      targets: {
        telegram: { status: "published" },
        threads_ru: { status: "published" },
        site_ru: { status: "published" },
        x: { status: "published" },
      },
      metrics: {
        telegram: { views: { value: 100 } },
        threads_ru: { views: { value: 50 } },
        site_ru: { views: { value: 28 } },
        x: { views: { value: 20 } },
      },
    };
    const video = {
      ...emptyVideoOverview(),
      platforms: [
        { target: "instagram_reels", label: "Instagram EN", locales: ["EN"], views: 20, followers: 2 },
        { target: "youtube_shorts", label: "YouTube RU", locales: ["RU"], views: 10, followers: 500 },
        { target: "instagram_reels", label: "Instagram RU", locales: ["RU"], views: 30, followers: 250 },
      ],
    };
    const followers = [
      { key: "telegram", label: "Telegram", followers: 10 },
      { key: "threads_ru", label: "Threads RU", followers: 200 },
      { key: "x", label: "X", followers: 400 },
    ];
    const assertOrder = (html: string, labels: string[]): void => {
      const positions = labels.map((label) => html.indexOf(`title="${label}"`));
      expect(positions.every((position) => position >= 0)).toBe(true);
      for (let index = 1; index < positions.length; index += 1) expect(positions[index - 1] ?? -1).toBeLessThan(positions[index] ?? -1);
    };

    const reachHtml = renderOverview({
      ...baseInput,
      data: { posts: [post] },
      followers,
      video,
      platformMetric: "reach",
    });
    const [reachRu, reachEn] = localeColumns(reachHtml, "text");
    const [videoRu, videoEn] = localeColumns(reachHtml, "video");
    assertOrder(reachRu, ["Telegram", "Threads RU", "Site RU"]);
    assertOrder(reachEn, ["X"]);
    assertOrder(videoRu, ["Instagram RU", "YouTube RU"]);
    assertOrder(videoEn, ["Instagram EN"]);

    const followerHtml = renderOverview({
      ...baseInput,
      data: { posts: [post] },
      followers,
      video,
      platformMetric: "followers",
    });
    const [followerRu, followerEn] = localeColumns(followerHtml, "text");
    const [followerVideoRu, followerVideoEn] = localeColumns(followerHtml, "video");
    assertOrder(followerRu, ["Threads RU", "Telegram"]);
    assertOrder(followerEn, ["X"]);
    assertOrder(followerVideoRu, ["YouTube RU", "Instagram RU"]);
    assertOrder(followerVideoEn, ["Instagram EN"]);
  });

  it("lists the top three destinations of each locale and no drawer", () => {
    const post: PipelinePost = {
      publication_key: "post:1",
      date: today().toISOString(),
      targets: {
        site_ru: { status: "published" },
        site_en: { status: "published" },
        telegram_stories: { status: "published" },
        instagram_stories: { status: "published" },
        threads_ru: { status: "published" },
      },
      metrics: {
        site_ru: { views: { value: 4 }, bot_views: { value: 0 } },
        site_en: { views: { value: 8 }, bot_views: { value: 0 } },
        telegram_stories: { views: { value: 12 } },
        instagram_stories: { views: { value: 3 } },
        threads_ru: { views: { value: 2 } },
      },
    };
    const html = renderOverview({
      ...baseInput,
      data: { posts: [post] },
      video: emptyVideoOverview(),
    });
    const [ru, en] = localeColumns(html, "text");

    // Each side keeps its own three largest; the fourth Russian destination —
    // Telegram, which earned nothing this period — is dropped rather than
    // hidden behind a control.
    expect(ru).toContain('title="Telegram Stories"');
    expect(ru).toContain('title="Site RU"');
    expect(ru).toContain('title="Threads RU"');
    expect(ru).not.toContain('title="Telegram"');
    expect(en).toContain('title="Site EN"');
    expect(en).toContain('title="Instagram Stories EN"');
    expect(ru).not.toContain('title="Site EN"');
    expect(html).not.toContain("platform-more");
    expect(html).not.toContain("Ещё <span>");

    const followersHtml = renderOverview({
      ...baseInput,
      data: { posts: [post] },
      video: emptyVideoOverview(),
      platformMetric: "followers",
    });
    // Followers rank the primary destinations only, so the story feeds drop out.
    expect(localeColumns(followersHtml, "text")[0]).not.toContain('title="Telegram Stories"');
    expect(followersHtml).not.toContain("platform-more");
  });

  it("splits the video legend by locale and leaves no control under it", () => {
    const video = {
      ...emptyVideoOverview(),
      platforms: [
        { target: "instagram_reels", label: "Instagram RU", locales: ["RU"], views: 48_000, followers: null },
        { target: "instagram_reels", label: "Instagram EN", locales: ["EN"], views: 34_000, followers: null },
        { target: "youtube_shorts", label: "YouTube EN", locales: ["EN"], views: 15_000, followers: null },
        { target: "youtube_shorts", label: "YouTube RU", locales: ["RU"], views: 9_000, followers: null },
      ],
    };
    const html = renderOverview({ ...baseInput, video });
    const [ru, en] = localeColumns(html, "video");

    expect(ru).toContain('title="Instagram RU"');
    expect(ru).toContain('title="YouTube RU"');
    expect(en).toContain('title="Instagram EN"');
    expect(en).toContain('title="YouTube EN"');
    // Nothing sits between the legend and the publication list any more.
    expect(html).not.toContain("overview-platforms__more");
    expect(html).not.toContain("overview-platform--empty");
    expect(html).toContain('id="overview-publications-video"');
  });

  it("uses linked X activity when the pipeline row has no X metric", () => {
    const xItems: XActivityDashboardItem[] = [
      {
        xPostId: "x-1",
        kind: "standalone",
        publishedAt: new Date().toISOString(),
        text: "An X post",
        url: "https://x.com/example/status/x-1",
        linkedPublicationKey: "post:1",
        metrics: { views: 42 },
      },
    ];
    const post: PipelinePost = {
      publication_key: "post:1",
      targets: { x: { status: "published" } },
      metrics: { x: { views: { value: 0 } } },
    };
    const html = renderOverview({
      ...baseInput,
      data: { posts: [post] },
      xItems,
      followers: [{ key: "x", label: "X", followers: 85 }],
      video: emptyVideoOverview(),
    });

    expect(html).toContain("<strong>42</strong>");
  });

  it("filters one half without disturbing the other", () =>
    withOverviewDb(async (backendDb) => {
      seedVideo(backendDb);
      const video = overviewFor(backendDb, new Date(Date.now() - 86_400_000), new Date());
      const post: PipelinePost = {
        publication_key: "post:1",
        date: today().toISOString(),
        targets: { telegram: { status: "published" }, threads_en: { status: "published" } },
        metrics: { telegram: { views: { value: 400 } }, threads_en: { views: { value: 90 } } },
      };
      const html = renderOverview({
        ...baseInput,
        data: { posts: [post] },
        video,
        textTargetIds: ["telegram"],
        textView: "telegram",
        followers: [{ key: "telegram", label: "Telegram", followers: 10 }],
      });

      // The video half is still there, still whole, and its own rows point at
      // the video parameter while carrying the text filter along.
      expect(html).toContain('class="overview-track overview-track--video');
      expect(html).toContain("video_view=youtube_shorts%3Aru");
      expect(html).toContain("view=telegram");
    }));

  it("points each half's list loader at its own publications", () =>
    withOverviewDb(async (backendDb) => {
      seedVideo(backendDb);
      const loaded = overviewFor(backendDb, new Date(Date.now() - 86_400_000), new Date());
      // Both lists have to overflow before either offers to load more.
      const video = {
        ...loaded,
        items: Array.from({ length: 6 }, (_, index) => ({ ...(loaded.items[0] as (typeof loaded.items)[number]), key: `video:${index}` })),
      };
      const posts = Array.from({ length: 6 }, (_, index) => ({
        publication_key: `post:${index}`,
        date: today().toISOString(),
        targets: { telegram: { status: "published" } },
        metrics: { telegram: { views: { value: 10 } } },
      })) as PipelinePost[];
      const html = renderOverview({ ...baseInput, data: { posts }, video });

      // One endpoint, two callers: without the track the clip list appended
      // posts when it was asked for more.
      expect(html).toContain("publication-details?period=1&amp;week_offset=0&amp;track=text");
      expect(html).toContain("publication-details?period=1&amp;week_offset=0&amp;track=video");
    }));

  it("keeps both halves available in the single overview mode", () =>
    withOverviewDb(async (backendDb) => {
      seedVideo(backendDb);
      const video = overviewFor(backendDb, new Date(Date.now() - 86_400_000), new Date());
      const html = renderOverview({ ...baseInput, video });
      expect(html).toContain("YouTube RU");
      expect(html).toContain("Telegram");
    }));
});

describe("video bundle reuse", () => {
  // The bundle used to expire on a clock, so an operator tapping through
  // periods -- slower than three seconds -- reloaded every snapshot on every
  // tap, while a tap inside the window could still be served data that had just
  // changed. It is keyed on what it was built from instead.
  it("reuses one load across renders until the data moves", () =>
    withOverviewDb(async (backendDb) => {
      seedHistoricalVideo(backendDb);
      const window = [new Date("2026-07-29T21:00:00.000Z"), new Date("2026-08-01T20:59:59.999Z")] as const;
      const load = () => {
        const cache = createVideoOverviewCache(24 * 60 * 60);
        setVideoOverviewCacheRange(cache, window[0], window[1]);
        return videoAnalyticsBundle(backendDb, window[0], window[1], cache);
      };
      const first = load();
      // A second render, with its own request-scoped cache, must land on the
      // very same object rather than reading the tables again.
      expect(load()).toBe(first);

      seedCrosspostedVideo(backendDb);
      expect(load()).not.toBe(first);
    }));
});

describe("one render, one version", () => {
  // Five windows share a bundle, and each used to ask the database whether the
  // data had moved -- counting rows across seven tables to do it. In production
  // 36 of 38 windows then reloaded the bundle they existed to share. The render
  // states the version once, which also means the five windows of one screen
  // cannot disagree about what they are drawing.
  it("keeps every window of one render on the bundle the render started with", () =>
    withOverviewDb(async (backendDb) => {
      seedHistoricalVideo(backendDb);
      const [start, end] = [new Date("2026-07-29T21:00:00.000Z"), new Date("2026-08-01T20:59:59.999Z")];
      const cache = createVideoOverviewCache(24 * 60 * 60);
      setVideoOverviewCacheRange(cache, start, end, 24 * 60 * 60, "version-of-this-render");
      const first = videoAnalyticsBundle(backendDb, start, end, cache);

      // A collection lands mid-render. The screen still draws one consistent
      // moment rather than half of one and half of another.
      seedCrosspostedVideo(backendDb);
      expect(videoAnalyticsBundle(backendDb, start, end, cache)).toBe(first);

      // The next render says a new version and gets the new data.
      const next = createVideoOverviewCache(24 * 60 * 60);
      setVideoOverviewCacheRange(next, start, end, 24 * 60 * 60, "version-of-the-next-render");
      expect(videoAnalyticsBundle(backendDb, start, end, next)).not.toBe(first);
    }));
});
