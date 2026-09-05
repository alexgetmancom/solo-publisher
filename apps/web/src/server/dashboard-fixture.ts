import { openBackendDb, unsafeDb } from "../../../backend/src/db/client.js";
import {
  creatorProfileSnapshots,
  metricSamples,
  metricSchedule,
  postMetrics,
  publicationTargets,
  publishJobs,
  siteJobs,
  studioMediaAssets,
  videoDrafts,
  videoMetricSnapshots,
  videoTargets,
  workerState,
  xActivityItems,
  xActivityMetricSnapshots,
} from "../../../backend/src/db/schema.js";
import type { RawBackendDb } from "../../../backend/src/db/unsafe.js";
import { daysAgo, fixtureDayWindow, fixtureSampleAt, fixtureSampleSlots, hoursAgo, hoursSince, iso } from "./fixture-utils.js";
import { fullFixtureDayCounts, PARITY_HISTORY_DAYS } from "./site-fixture.js";

/**
 * Adds the operational layer on top of a database already seeded by
 * site-fixture.ts, so /command-center renders a populated dashboard locally
 * instead of a screen of zeroes.
 *
 * The two fixtures are deliberately separate: site-fixture writes what the
 * public read model needs (publications, posts, locales, media on disk), this
 * one writes what only Command Center reads (per-target publish state, metric
 * history, queue and worker rows). A site-only seed stays cheap, and a
 * dashboard seed cannot drift into inventing posts of its own.
 *
 * What the shape is chosen to exercise, because none of it is visible on an
 * all-green fixture:
 *   - a failed target with an error, so the danger styling and the audit path
 *     have something to show;
 *   - a queued job and a retrying job, so the queue panel is not empty;
 *   - several days of metric samples, so the chart draws a line rather than a
 *     single point, and today vs. yesterday differ;
 *   - two locales' site targets, so the per-target columns are not identical.
 */

/** Targets seeded per post, with the status the dashboard should display. */
const TARGET_PLAN = [
  { target: "telegram", status: "published", views: 4100, likes: 210 },
  { target: "site_ru", status: "published", views: 980, likes: 24 },
  { target: "site_en", status: "published", views: 1240, likes: 31 },
  { target: "threads_en", status: "published", views: 420, likes: 12 },
  { target: "x", status: "failed", views: 760, likes: 28, error: "X API 401: token expired" },
] as const;

const DAYS_OF_HISTORY = 14;
/** Two-hourly samples: enough to draw a readable curve, few enough to seed fast. */
const HOURS_PER_SAMPLE = 2;
const SAMPLES_PER_DAY = 24 / HOURS_PER_SAMPLE;

/**
 * Clips for the video half of the unified overview. Deliberately lopsided
 * against the text plan above: video reach is an order of magnitude larger than
 * text reach in production, so the two halves of the overview scale their bars
 * to visibly different ceilings.
 *
 * The locales are mixed on purpose. The overview reads a video platform's
 * language off the drafts published there, so a single-locale fixture would
 * make the badges look hardcoded and hide the bilingual case entirely.
 */
const VIDEO_PLAN = [
  {
    label: "ByteDance выпустила Seedance 2.5",
    locale: "ru",
    hoursAgo: 6,
    targets: [{ target: "youtube_shorts", views: 46_800, likes: 2_010, comments: 180 }],
  },
  {
    label: "Seedance 2.5 is AGI for video",
    locale: "en",
    hoursAgo: 20,
    targets: [{ target: "instagram_reels", views: 31_700, likes: 1_240, comments: 96 }],
  },
  {
    label: "Gemini 3.5 Pro на Arena",
    locale: "ru",
    hoursAgo: 34,
    targets: [
      { target: "youtube_shorts", views: 20_200, likes: 780, comments: 41 },
      { target: "instagram_reels", views: 9_400, likes: 310, comments: 18 },
    ],
  },
] as const;

export type SeededDashboard = {
  targetRows: number;
  sampleRows: number;
};

type FullDashboardFixtureOptions = {
  days: number;
  minPostsPerDay: number;
  maxPostsPerDay: number;
};

export type DashboardFixtureOptions = {
  dbPath: string;
  postIds: number[];
  postDates?: Array<string | undefined>;
  full?: FullDashboardFixtureOptions;
  /** The text destinations this Studio publishes to. A fixture that seeds reach
   * for a destination the Studio never connected reads as a Studio that lost a
   * channel, which is a different screen from a Studio that only ever had one
   * language. */
  targets?: readonly string[];
};

type VideoFixtureTarget = {
  target: "youtube_shorts" | "instagram_reels";
  views: number;
  likes: number;
  comments: number;
};

type VideoFixturePlan = {
  label: string;
  locale: "ru" | "en";
  publishedAt: string;
  targets: VideoFixtureTarget[];
};

function deterministicUnit(seed: number): number {
  let state = seed >>> 0;
  state = (state * 1_664_525 + 1_013_904_223) >>> 0;
  return state / 4_294_967_296;
}

function fullPostReachMultiplier(index: number): number {
  const baseline = 0.7 + deterministicUnit(0x12340000 + index) * 1.7;
  const breakout =
    index % 13 === 0
      ? 8 + deterministicUnit(0x56780000 + index) * 8
      : deterministicUnit(0x9abc0000 + index) > 0.9
        ? 2.5 + deterministicUnit(0xdef00000 + index) * 3
        : 1;
  return baseline * breakout;
}

function fullTargetReachMultiplier(target: string, index: number): number {
  const platform =
    target === "telegram" ? 1 : target === "site_en" ? 0.3 : target === "site_ru" ? 0.22 : target === "threads_en" ? 0.12 : 0.18;
  return platform * (0.82 + deterministicUnit(0x24680000 + index + target.length) * 0.36);
}

function fullMetricValue(base: number, index: number, target: string, metricName: "views" | "likes"): number {
  const metricFactor = metricName === "likes" ? 0.82 : 1;
  return Math.max(0, Math.round(base * fullPostReachMultiplier(index) * fullTargetReachMultiplier(target, index) * metricFactor));
}

const FULL_VIDEO_TOPICS = [
  ["Новая модель за минуту", "The new model in one minute"],
  ["Почему этот апдейт важен", "Why this update matters"],
  ["Три детали, которые легко пропустить", "Three details everyone misses"],
  ["Эксперимент с неожиданным результатом", "An experiment with a surprising result"],
  ["Разбор инструмента в коротком формате", "A short-form tool breakdown"],
] as const;

function fullVideoPlans(options: FullDashboardFixtureOptions, now: Date): VideoFixturePlan[] {
  const counts = fullFixtureDayCounts(options.days, options.minPostsPerDay, options.maxPostsPerDay);
  let state = 0x13579bdf;
  const random = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  const plans: VideoFixturePlan[] = [];
  let serial = 1;

  counts.forEach((count, day) => {
    const [start, end] = fixtureDayWindow(day, now);
    const available = Math.max(60_000, end.getTime() - start.getTime());
    for (let index = 0; index < count; index += 1) {
      const publishedAt = new Date(Math.min(end.getTime(), start.getTime() + Math.round((available * (index + 1)) / (count + 1))));
      const locale: "ru" | "en" = random() > 0.52 ? "ru" : "en";
      const topic = FULL_VIDEO_TOPICS[(serial - 1) % FULL_VIDEO_TOPICS.length] ?? FULL_VIDEO_TOPICS[0];
      const label = locale === "ru" ? topic[0] : topic[1];
      const breakout = serial % 11 === 0 || random() > 0.86;
      const baseViews = 7_000 + random() * 18_000;
      const multiplier = breakout ? 4.5 + random() * 5.5 : 0.75 + random() * 1.8;
      const totalViews = Math.round(baseViews * multiplier);
      const primary: VideoFixtureTarget["target"] = random() > 0.5 ? "youtube_shorts" : "instagram_reels";
      const secondary: VideoFixtureTarget["target"] = primary === "youtube_shorts" ? "instagram_reels" : "youtube_shorts";
      const makeTarget = (target: VideoFixtureTarget["target"], reachFactor: number): VideoFixtureTarget => {
        const views = Math.max(1, Math.round(totalViews * reachFactor));
        return {
          target,
          views,
          likes: Math.max(1, Math.round(views * (0.035 + random() * 0.025))),
          comments: Math.max(0, Math.round(views * (0.0015 + random() * 0.003))),
        };
      };
      const targets = [makeTarget(primary, 1)];
      if (random() > 0.63) targets.push(makeTarget(secondary, 0.32 + random() * 0.3));
      plans.push({ label, locale, publishedAt: publishedAt.toISOString(), targets });
      serial += 1;
    }
  });

  return plans;
}

function fixtureVideoAsset(rawDb: RawBackendDb, createdAt: string): number {
  return rawDb.db
    .insert(studioMediaAssets)
    .values({
      actorId: 1,
      kind: "video",
      mimeType: "video/mp4",
      filename: "fixture.mp4",
      localPath: "/tmp/fixture.mp4",
      byteSize: 1,
      sha256: "fixture-video",
      source: "fixture",
      createdAt,
    })
    .onConflictDoUpdate({
      target: [studioMediaAssets.actorId, studioMediaAssets.sha256],
      set: { createdAt },
    })
    .returning({ id: studioMediaAssets.id })
    .get().id;
}

/** How one dataset spaces its metric samples and what it records at each. Both
 * seeders write the same draft/target/snapshot rows; only this differs, so it is
 * the parameter rather than a second copy of the loop. */
type VideoSeedShape = {
  /** Clip length the target metadata reports, when the dataset states one. */
  durationMs?: number;
  slots: (plan: VideoFixturePlan) => number;
  sampledAt: (plan: VideoFixturePlan, slot: number) => string;
  /** Metrics recorded at every sample on top of views/likes/comments. */
  extraMetrics?: Record<string, number>;
};

/** Publishes a set of video plans with their targets and a metric history each. */
function seedVideoPlans(
  rawDb: RawBackendDb,
  videoAssetId: number,
  nowIso: string,
  plans: readonly VideoFixturePlan[],
  shape: VideoSeedShape,
): { targetRows: number; sampleRows: number } {
  let targetRows = 0;
  let sampleRows = 0;
  for (const plan of plans) {
    const publishedAt = plan.publishedAt;
    const draft = rawDb.db
      .insert(videoDrafts)
      .values({
        actorId: 1,
        locale: plan.locale,
        label: plan.label,
        studioMediaAssetId: videoAssetId,
        status: "published",
        scheduledAt: publishedAt,
        createdAt: publishedAt,
        updatedAt: nowIso,
      })
      .returning({ id: videoDrafts.id })
      .get();

    for (const target of plan.targets) {
      const inserted = rawDb.db
        .insert(videoTargets)
        .values({
          videoDraftId: draft.id,
          target: target.target,
          metadataJson: {
            title: plan.label,
            description: "fixture",
            tags: [],
            ...(shape.durationMs === undefined ? {} : { videoDurationMs: shape.durationMs }),
          },
          status: "published",
          scheduledAt: publishedAt,
          publishedAt,
          externalId: `${target.target}-${draft.id}`,
          externalUrl: `https://example.com/${target.target}/${draft.id}`,
          createdAt: publishedAt,
          updatedAt: nowIso,
        })
        .returning({ id: videoTargets.id })
        .get();
      targetRows += 1;

      // Same two-hourly cadence as the text samples, so both lines on the
      // overview chart are drawn from observations on the same clock.
      const slots = shape.slots(plan);
      for (let slot = slots; slot >= 0; slot -= 1) {
        const progress = (slots - slot) / slots;
        rawDb.db
          .insert(videoMetricSnapshots)
          .values({
            videoTargetId: inserted.id,
            platform: target.target,
            metricsJson: {
              views: Math.round(target.views * progress),
              likes: Math.round(target.likes * progress),
              comments: Math.round(target.comments * progress),
              ...shape.extraMetrics,
            },
            sampledAt: shape.sampledAt(plan, slot),
          })
          .run();
        sampleRows += 1;
      }
    }
  }
  return { targetRows, sampleRows };
}

export function seedDashboardFixture(options: DashboardFixtureOptions): SeededDashboard {
  const backendDb = openBackendDb(options.dbPath);
  const rawDb = unsafeDb(backendDb);
  const now = new Date();
  const nowIso = iso(now);
  const videoAssetId = fixtureVideoAsset(rawDb, nowIso);
  let targetRows = 0;
  let sampleRows = 0;

  try {
    for (const [index, postId] of options.postIds.entries()) {
      const publicationKey = `post:${postId}`;
      // Spread the posts across recent days so the period filters (day, week,
      // month) each select a different slice instead of all showing everything.
      const publishedAt = options.postDates?.[index] ?? iso(daysAgo(index));

      for (const plan of options.targets ? TARGET_PLAN.filter((entry) => options.targets?.includes(entry.target)) : TARGET_PLAN) {
        const failed = options.full ? plan.target === "x" && index === 0 : plan.status === "failed";
        rawDb.db
          .insert(publicationTargets)
          .values({
            publicationKey,
            target: plan.target,
            status: failed ? "failed" : "published",
            externalId: failed ? null : `${plan.target}-${postId}`,
            url: failed ? null : `https://example.com/${plan.target}/${postId}`,
            error: failed ? ("error" in plan ? plan.error : null) : null,
            skipped: 0,
            publishedAt: failed ? null : publishedAt,
            updatedAt: nowIso,
          })
          .run();
        targetRows += 1;

        if (failed) continue;

        // Later posts are younger, so scale their totals down: a flat number
        // across every post makes the "best posts" ranking meaningless.
        for (const [metricName, base] of [
          ["views", plan.views],
          ["likes", plan.likes],
        ] as const) {
          const value = options.full
            ? fullMetricValue(base, index, plan.target, metricName)
            : Math.max(0, Math.round(base * (1 - index * 0.18)));
          rawDb.db
            .insert(postMetrics)
            .values({ publicationKey, target: plan.target, metricName, value, unit: "count", source: "fixture", sampledAt: nowIso })
            .run();

          // A growth curve rather than noise: the chart is read for shape, and
          // random values make a regression in the drawing code invisible.
          //
          // Samples are spread across the hours of each day, not written once
          // per day at whatever time the seed ran. The overview chart plots
          // today against yesterday by time of day; with a single timestamp per
          // day every point lands on one x and the line renders as a vertical
          // spike instead of a curve.
          const slots = options.full
            ? fixtureSampleSlots(publishedAt, now, options.full.days, HOURS_PER_SAMPLE)
            : DAYS_OF_HISTORY * SAMPLES_PER_DAY;
          for (let slot = slots; slot >= 0; slot -= 1) {
            const progress = (slots - slot) / slots;
            rawDb.db
              .insert(metricSamples)
              .values({
                publicationKey,
                target: plan.target,
                metricName,
                value: Math.round(value * progress),
                sampledAt: options.full
                  ? fixtureSampleAt(publishedAt, now, slot, HOURS_PER_SAMPLE)
                  : iso(hoursAgo(slot * HOURS_PER_SAMPLE, now)),
                source: "fixture",
              })
              .run();
            sampleRows += 1;
          }
        }

        rawDb.db
          .insert(metricSchedule)
          .values({
            publicationKey,
            target: plan.target,
            nextCheckAt: iso(daysAgo(-1)),
            lastCheckedAt: nowIso,
            checkCount: 12,
            updatedAt: nowIso,
          })
          .run();
      }

      rawDb.db
        .insert(publishJobs)
        .values({
          publicationKey,
          target: "x",
          status: index === 0 ? "failed" : "done",
          publishAt: publishedAt,
          lastError: index === 0 ? "X API 401: token expired" : null,
          attemptCount: index === 0 ? 3 : 1,
          createdAt: publishedAt,
          updatedAt: nowIso,
        })
        .run();
      rawDb.db
        .insert(siteJobs)
        .values({
          publicationKey: `post:${postId}`,
          reason: "publish",
          status: "done",
          attemptCount: 1,
          createdAt: publishedAt,
          updatedAt: nowIso,
        })
        .run();
    }

    // One job left in the queue, so the queue panel and the "in flight" counter
    // are exercised. It has no post of its own on purpose: the dashboard must
    // survive a job whose post row is not there yet.
    rawDb.db
      .insert(publishJobs)
      .values({
        publicationKey: "post:999",
        target: "telegram",
        status: "queued",
        publishAt: iso(daysAgo(-1)),
        attemptCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();

    rawDb.db
      .insert(workerState)
      .values({ name: "publisher", stateJson: { lastRunAt: nowIso, status: "idle" }, updatedAt: nowIso })
      .run();
    rawDb.db
      .insert(workerState)
      .values({ name: "metrics", stateJson: { lastRunAt: nowIso, status: "idle" }, updatedAt: nowIso })
      .run();

    // X activity is its own feed, but it is still one of this Studio's text
    // destinations: a Studio that has not connected X publishes nothing there.
    const xActivityPosts = options.targets && !options.targets.includes("x") ? 0 : 8;
    for (let index = 0; index < xActivityPosts; index += 1) {
      const xPostId = `fixture-x-${index + 1}`;
      const reply = index % 3 === 1;
      const publishedAt = iso(hoursAgo(index * 8));
      rawDb.db
        .insert(xActivityItems)
        .values({
          xPostId,
          kind: reply ? "reply" : "standalone",
          publishedAt,
          text: reply ? `@researcher Fixture reply number ${index + 1}` : `Fixture X publication number ${index + 1}`,
          url: `https://x.com/alexgetmancom/status/${xPostId}`,
          linkedPublicationKey: !reply && options.postIds[index] ? `post:${options.postIds[index]}` : null,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          rawJson: { source: "fixture" },
        })
        .run();
      for (const [metricName, value] of [
        ["views", 5_000 - index * 430],
        ["likes", 24 - index * 2],
        ["interactions", 120 - index * 8],
        ["replies", reply ? 18 - index : 4 + index],
      ] as const)
        rawDb.db
          .insert(xActivityMetricSnapshots)
          .values({ xPostId, metricName, value, sampledAt: nowIso, rawJson: { source: "fixture" } })
          .run();
    }
    const videoPlans: VideoFixturePlan[] = options.full
      ? fullVideoPlans(options.full, now)
      : VIDEO_PLAN.map((plan) => ({
          label: plan.label,
          locale: plan.locale,
          publishedAt: iso(hoursAgo(plan.hoursAgo)),
          targets: plan.targets.map((target) => ({ ...target })),
        }));
    const videoRows = seedVideoPlans(rawDb, videoAssetId, nowIso, videoPlans, {
      slots: (plan) =>
        options.full
          ? fixtureSampleSlots(plan.publishedAt, now, options.full.days, HOURS_PER_SAMPLE)
          : Math.max(1, Math.round(hoursSince(plan.publishedAt) / HOURS_PER_SAMPLE)),
      sampledAt: (plan, slot) =>
        options.full ? fixtureSampleAt(plan.publishedAt, now, slot, HOURS_PER_SAMPLE) : iso(hoursAgo(slot * HOURS_PER_SAMPLE, now)),
    });
    targetRows += videoRows.targetRows;
    sampleRows += videoRows.sampleRows;

    // Follower counts for the video column of the platforms panel, keyed per
    // destination the way production has recorded them since the RU/EN channels
    // were split. The text platforms read theirs from creator_profiles, which
    // site-fixture seeds.
    for (const [platform, followers] of [
      ["youtube_ru", 8_400],
      ["youtube_en", 1_260],
      ["instagram_ru", 5_120],
      ["instagram_en", 940],
    ] as const)
      rawDb.db
        .insert(creatorProfileSnapshots)
        .values({
          platform,
          account: "alexgetman",
          sampledOn: nowIso.slice(0, 10),
          metricsJson: { subscriberCount: followers },
          source: "fixture",
          sampledAt: nowIso,
        })
        .run();
  } finally {
    backendDb.close();
  }

  return { targetRows, sampleRows };
}

/* ------------------------------------------------------------------------- *
 * Reference-layout parity fixture
 *
 * Seeds the exact numbers of the overview reference layout so the two can be
 * compared side by side. Reconciled from the publication list rather than from
 * its platform panel: the reference assigns 4128 views two different ways
 * (posts give Telegram 2868 / X 1114 / Threads 146, the panel next to it says
 * Telegram 2480 / X 1502 / Threads 146). Only one of those can be true of real
 * rows, and the publication list is the one whose per-post numbers are visible.
 *
 * "X RU" and "X EN" cannot both exist here — `x` is a single target with a
 * single locale — so the reference's second X row is seeded as Threads RU. The
 * RU/EN split still lands exactly on its 86% / 14% · 558.
 * ------------------------------------------------------------------------- */

/** One primary target per publication, matching the reference list top to bottom. */
const PARITY_POSTS = [
  { target: "telegram", views: 1_420, likes: 55, reposts: 9, replies: 9 },
  { target: "telegram", views: 1_060, likes: 41, reposts: 0, replies: 7 },
  { target: "threads_ru", views: 702, likes: 22, reposts: 0, replies: 4 },
  { target: "x", views: 412, likes: 14, reposts: 0, replies: 2 },
  { target: "telegram", views: 388, likes: 6, reposts: 0, replies: 1 },
  { target: "threads_en", views: 146, likes: 5, reposts: 0, replies: 0 },
] as const;

/** Median daily reach the archived history is built around — the "норма дня"
 * the hero card reports is the median of these days, not any single one of
 * them, so the days themselves have to vary or the sparkline draws a flat
 * line and the norm stops looking like a norm. */
const PARITY_DAILY_TEXT_VIEWS = 3_600;
const PARITY_DAILY_VIDEO_VIEWS = 12_000;

/**
 * A day-by-day multiplier series with a median of exactly 1 by construction:
 * fifteen values below 1, fifteen at-or-above it, so `PARITY_DAILY_*_VIEWS *
 * series[i]` reproduces the stated median precisely while every individual day
 * still differs. Order (not just the multiset) matters here — this is read
 * day-by-day into the sparkline — so the values are shuffled by a small
 * deterministic generator rather than left sorted, which would draw a ramp.
 */
function dailyVarianceSeries(days: number, seed: number): number[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
  const below = Array.from({ length: Math.ceil(days / 2) }, () => 0.35 + next() * 0.6);
  const above = Array.from({ length: Math.floor(days / 2) }, () => 1 + next() * 1.4);
  const series = [...below, ...above];
  for (let i = series.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [series[i], series[j]] = [series[j] as number, series[i] as number];
  }
  return series;
}

/** Clips as the reference lists them: three bilingual drafts on two platforms
 * each, plus one EN clip per platform, so all four video rows carry a figure. */
const PARITY_VIDEO = [
  {
    label: "ТРЕНЕР НЕ УЗНАЕТ! 🤫 выпустили чела без трусов | Kitman",
    locale: "ru",
    hoursAgo: 5,
    targets: [
      { target: "instagram_reels", views: 4_400, likes: 57, comments: 0 },
      { target: "youtube_shorts", views: 822, likes: 16, comments: 1 },
    ],
  },
  {
    label: "ШКАФ УБИЛ ДРУГА?! 💀 | Call it a Day",
    locale: "ru",
    hoursAgo: 9,
    targets: [
      { target: "instagram_reels", views: 2_000, likes: 30, comments: 0 },
      { target: "youtube_shorts", views: 899, likes: 22, comments: 0 },
    ],
  },
  {
    label: "МЕНЯ СДЕЛАЛИ КЛОУНОМ! 🤡 Самый честный обзор",
    locale: "ru",
    hoursAgo: 13,
    targets: [
      { target: "instagram_reels", views: 887, likes: 11, comments: 1 },
      { target: "youtube_shorts", views: 10, likes: 4, comments: 0 },
    ],
  },
  {
    label: "BEHIND THE SCENES | day 4",
    locale: "en",
    hoursAgo: 17,
    targets: [{ target: "youtube_shorts", views: 367, likes: 6, comments: 0 }],
  },
  {
    label: "we broke the closet | shorts",
    locale: "en",
    hoursAgo: 21,
    targets: [{ target: "instagram_reels", views: 212, likes: 4, comments: 0 }],
  },
] as const;

/** Average watch time the reference reports, applied to every clip. */
const PARITY_WATCH_TIME_MS = 13_000;

/**
 * Seeds the parity dataset over a database already carrying
 * `overviewParityFixture()` posts. Kept separate from seedDashboardFixture:
 * that one is the everyday dev fixture and is deliberately not all-green, this
 * one exists to be held next to the reference layout.
 */
export function seedOverviewParityFixture(options: { dbPath: string; postIds: number[] }): SeededDashboard {
  const backendDb = openBackendDb(options.dbPath);
  const rawDb = unsafeDb(backendDb);
  const now = new Date();
  const nowIso = iso(now);
  const videoAssetId = fixtureVideoAsset(rawDb, nowIso);
  let targetRows = 0;
  let sampleRows = 0;

  const writeMetric = (publicationKey: string, target: string, metricName: string, value: number, sampledAt: string) => {
    rawDb.db.insert(postMetrics).values({ publicationKey, target, metricName, value, unit: "count", source: "fixture", sampledAt }).run();
  };
  const publishTarget = (publicationKey: string, target: string, publishedAt: string) => {
    rawDb.db
      .insert(publicationTargets)
      .values({
        publicationKey,
        target,
        status: "published",
        externalId: `${target}-${publicationKey}`,
        url: `https://example.com/${target}/${publicationKey}`,
        skipped: 0,
        publishedAt,
        updatedAt: nowIso,
      })
      .run();
    targetRows += 1;
  };

  try {
    const todayIds = options.postIds.slice(0, PARITY_POSTS.length);
    const historyIds = options.postIds.slice(PARITY_POSTS.length);

    for (const [index, plan] of PARITY_POSTS.entries()) {
      const postId = todayIds[index];
      if (postId === undefined) break;
      const publicationKey = `post:${postId}`;
      // Spread across the day so the daily chart draws a curve rather than a
      // single column, but all inside today's window.
      const publishedAt = iso(hoursAgo(3 + index * 2));
      publishTarget(publicationKey, plan.target, publishedAt);
      for (const [metricName, value] of [
        ["views", plan.views],
        ["likes", plan.likes],
        ["reposts", plan.reposts],
        ["replies", plan.replies],
      ] as const)
        writeMetric(publicationKey, plan.target, metricName, value, nowIso);

      const slots = Math.max(1, Math.round((3 + index * 2) / HOURS_PER_SAMPLE));
      for (let slot = slots; slot >= 0; slot -= 1) {
        rawDb.db
          .insert(metricSamples)
          .values({
            publicationKey,
            target: plan.target,
            metricName: "views",
            value: Math.round(plan.views * ((slots - slot) / slots)),
            sampledAt: iso(hoursAgo(slot * HOURS_PER_SAMPLE)),
            source: "fixture",
          })
          .run();
        sampleRows += 1;
      }
    }

    // Quiet history: one publication per past day carrying that day's whole
    // reach, so the sparkline has thirty different bars to draw and the norm is
    // their median rather than any single day's number.
    const textVariance = dailyVarianceSeries(historyIds.length, 11);
    for (const [index, postId] of historyIds.entries()) {
      const day = daysAgo(index + 1);
      const dayIso = iso(day);
      const publicationKey = `post:${postId}`;
      const factor = textVariance[index] ?? 1;
      publishTarget(publicationKey, "telegram", dayIso);
      for (const [metricName, base] of [
        ["views", PARITY_DAILY_TEXT_VIEWS],
        ["likes", 120],
        ["replies", 18],
      ] as const)
        writeMetric(publicationKey, "telegram", metricName, Math.round(base * factor), dayIso);
    }

    rawDb.db
      .insert(workerState)
      .values({ name: "publisher", stateJson: { lastRunAt: nowIso, status: "idle" }, updatedAt: nowIso })
      .run();
    rawDb.db
      .insert(workerState)
      .values({ name: "metrics", stateJson: { lastRunAt: nowIso, status: "idle" }, updatedAt: nowIso })
      .run();

    const parityVideoRows = seedVideoPlans(
      rawDb,
      videoAssetId,
      nowIso,
      PARITY_VIDEO.map((plan) => ({
        label: plan.label,
        locale: plan.locale,
        publishedAt: iso(hoursAgo(plan.hoursAgo)),
        targets: plan.targets.map((target) => ({ ...target })),
      })),
      {
        durationMs: 24_000,
        slots: (plan) => Math.max(1, Math.round(hoursSince(plan.publishedAt) / HOURS_PER_SAMPLE)),
        sampledAt: (_plan, slot) => iso(hoursAgo(slot * HOURS_PER_SAMPLE)),
        // averageWatchTimeMs directly, not totalWatchTimeMs: the summary derives
        // completion rate from total watch time divided by views times duration,
        // which is a percentage a handful of round input numbers cannot also land
        // on a round output — it was rendering as a seven-digit float. The
        // reference does not show a completion figure at all, so leaving it unset
        // is the accurate match, not a shortcut.
        extraMetrics: { averageWatchTimeMs: PARITY_WATCH_TIME_MS },
      },
    );
    targetRows += parityVideoRows.targetRows;
    sampleRows += parityVideoRows.sampleRows;

    // One archived clip carries the whole video history: the overview reads a
    // day's reach as the growth between two snapshots, so a single target whose
    // counter climbs by the same amount every day gives a flat, checkable norm.
    // It stops at yesterday, so none of it lands in today's total — and it is
    // published inside the 30-day median window, not before it: the daily chart
    // only ever looks at rows whose publish date falls inside the window it was
    // asked for, so a video published on day 31 contributes to none of it, no
    // matter how many older snapshots it carries.
    const historyPublishedAt = daysAgo(PARITY_HISTORY_DAYS - 1);
    const historyDraft = rawDb.db
      .insert(videoDrafts)
      .values({
        actorId: 1,
        locale: "ru",
        label: "Архивный ролик",
        studioMediaAssetId: videoAssetId,
        status: "published",
        scheduledAt: iso(historyPublishedAt),
        createdAt: iso(historyPublishedAt),
        updatedAt: nowIso,
      })
      .returning({ id: videoDrafts.id })
      .get();
    const historyTarget = rawDb.db
      .insert(videoTargets)
      .values({
        videoDraftId: historyDraft.id,
        target: "instagram_reels",
        metadataJson: { title: "Архивный ролик", description: "fixture", tags: [] },
        status: "published",
        publishedAt: iso(historyPublishedAt),
        createdAt: iso(historyPublishedAt),
        updatedAt: nowIso,
      })
      .returning({ id: videoTargets.id })
      .get();
    targetRows += 1;
    // The counter is cumulative, so a varying day-by-day *increment* still has
    // to be summed forward into a monotonic running total — the snapshot at
    // each point is "everything so far", not that day's number on its own.
    const videoVariance = dailyVarianceSeries(PARITY_HISTORY_DAYS - 1, 29);
    let cumulativeViews = 0;
    let cumulativeLikes = 0;
    let cumulativeComments = 0;
    for (let day = PARITY_HISTORY_DAYS - 1; day >= 1; day -= 1) {
      const step = PARITY_HISTORY_DAYS - day; // 1, 2, 3, … — one increment per day
      const factor = videoVariance[step - 1] ?? 1;
      cumulativeViews += Math.round(PARITY_DAILY_VIDEO_VIEWS * factor);
      cumulativeLikes += Math.round(120 * factor);
      cumulativeComments += Math.round(4 * factor);
      rawDb.db
        .insert(videoMetricSnapshots)
        .values({
          videoTargetId: historyTarget.id,
          platform: "instagram_reels",
          metricsJson: { views: cumulativeViews, likes: cumulativeLikes, comments: cumulativeComments },
          sampledAt: iso(daysAgo(day)),
        })
        .run();
      sampleRows += 1;
    }

    // Two snapshots a day apart per channel: the overview reports subscribers as
    // the summed growth across every channel, so only one of the four moves —
    // otherwise four flat +11s would read back as the reference's single "+11"
    // times four.
    for (const [platform, followers, gained] of [
      ["youtube_ru", 8_400, 11],
      ["youtube_en", 1_260, 0],
      ["instagram_ru", 5_120, 0],
      ["instagram_en", 940, 0],
    ] as const)
      for (const [when, value] of [
        [daysAgo(1), followers],
        [now, followers + gained],
      ] as const)
        rawDb.db
          .insert(creatorProfileSnapshots)
          .values({
            platform,
            account: "alexgetman",
            sampledOn: iso(when).slice(0, 10),
            metricsJson: { subscriberCount: value },
            source: "fixture",
            sampledAt: iso(when),
          })
          .run();
  } finally {
    backendDb.close();
  }

  return { targetRows, sampleRows };
}
