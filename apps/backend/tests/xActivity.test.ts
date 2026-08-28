import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importXAnalyticsCsv } from "../src/analytics/import-x-csv.js";
import { calendarDays } from "../src/analytics/reach/daily-reach.js";
import { textOverviewOf } from "../src/analytics/reach/text-overview.js";
import { xActivityDashboard } from "../src/analytics/x-activity-dashboard.js";
import { attachXActivityToPosts } from "../src/analytics/x-activity-linking.js";
import { xAnalyticsReport } from "../src/analytics/x-activity-report.js";
import { recordPublishedXActivity } from "../src/analytics/x-activity-store.js";
import { xActivityItems, xActivityMetricSnapshots } from "../src/db/schema.js";
import { type CombinedSectionInput, renderCombinedSection } from "../src/interfaces/web/dashboard/combined-section.js";
import { emptyVideoOverview } from "../src/interfaces/web/dashboard/video-overview.js";
import { xActivityPost } from "../src/interfaces/web/dashboard/x-activity-posts.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";

const HEADERS = [
  "Идентификатор поста",
  "Дата",
  "Текст поста",
  "Ссылка на пост",
  "Показы",
  "Нравится",
  "Взаимодействия",
  "Закладки",
  "Поделились",
  "Новые читатели",
  "Ответы",
  "Репосты",
  "Посещения профиля",
  "Разворачивания подробных сведений",
  "Клики по URL-адресам",
  "Клики по хештегам",
  "Клики по постоянным ссылкам",
];

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
  return renderCombinedSection(
    {
      textLocales: ["ru", "en"],
      videoLocales: ["ru", "en"],
      ...input,
      videoReach: input.video.dailyByDay,
      textReach: textOverviewOf([...posts, ...items.map(xActivityPost)], [], days, "UTC"),
    },
    "ru",
  );
}

function writeExport(rows: string[][], name = "account_analytics_content_2026-08-14_2026-08-27.csv"): string {
  const directory = mkdtempSync(join(tmpdir(), "x-activity-guard-"));
  const file = join(directory, name);
  writeFileSync(file, [HEADERS.join(","), ...rows.map((row) => row.join(","))].join("\n"), "utf8");
  return file;
}

describe("x analytics import guards", () => {
  const row = ["200", '"Thu, Aug 20, 2026"', "A standalone post", "https://x.com/test/status/200", "1000", ...Array(12).fill("0")];

  /** A reading is keyed by the moment it was taken, so a wrong moment cannot be
   * corrected by importing again: it sorts above every window and disappears
   * from the charts while every report still lists it. */
  it("refuses a sampled_at that is not a full instant", () =>
    withDb(async (backendDb) => {
      const file = writeExport([row]);
      // What a shell left of "2026-08-27T14:01:34Z" after cutting at the last colon.
      expect(() => importXAnalyticsCsv(backendDb, file, "34Z")).toThrow(/full ISO timestamp/);
      expect(() => importXAnalyticsCsv(backendDb, file, "2026-08-27")).toThrow(/full ISO timestamp/);
      expect(importXAnalyticsCsv(backendDb, file, "2026-08-27T14:01:34Z").rows).toBe(1);
    }));

  /** The export dates a post by calendar day; resolving that day against the
   * importing machine's timezone put one file on two different days. */
  it("dates a post by the day the export names, wherever it is imported", () =>
    withDb(async (backendDb) => {
      importXAnalyticsCsv(backendDb, writeExport([row]), "2026-08-27T14:01:34Z");
      const item = backendDb.db.select().from(xActivityItems).all()[0];
      expect(item?.publishedAt).toBe("2026-08-20T00:00:00.000Z");
    }));
});

describe("X Activity", () => {
  it("records a published X target idempotently and reads the newest metric snapshots", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 1, ru: "Русский текст", en: "English text", now });

      recordPublishedXActivity(backendDb, { publicationKey: "post:1", xPostId: "x-1", url: null, publishedAt: now });
      recordPublishedXActivity(backendDb, {
        publicationKey: "post:1",
        xPostId: "x-1",
        url: "https://x.com/alex/status/x-1",
        publishedAt: new Date(Date.now() + 1_000).toISOString(),
      });

      expect(backendDb.db.select().from(xActivityItems).all()).toMatchObject([
        { xPostId: "x-1", kind: "standalone", text: "English text", url: "https://x.com/alex/status/x-1", linkedPublicationKey: "post:1" },
      ]);

      const replyAt = new Date(Date.now() - 60 * 60_000).toISOString();
      const repostAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const unknownAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
      backendDb.db
        .insert(xActivityItems)
        .values([
          {
            xPostId: "x-reply",
            kind: "reply",
            publishedAt: replyAt,
            text: "reply",
            url: "https://x.com/reply",
            linkedPublicationKey: null,
            firstSeenAt: now,
            lastSeenAt: now,
          },
          {
            xPostId: "x-repost",
            kind: "repost",
            publishedAt: repostAt,
            text: "repost",
            url: "https://x.com/repost",
            linkedPublicationKey: null,
            firstSeenAt: now,
            lastSeenAt: now,
          },
          {
            xPostId: "x-unknown",
            kind: "quote",
            publishedAt: unknownAt,
            text: "quote",
            url: "https://x.com/quote",
            linkedPublicationKey: null,
            firstSeenAt: now,
            lastSeenAt: now,
          },
        ])
        .run();
      backendDb.db
        .insert(xActivityMetricSnapshots)
        .values([
          { xPostId: "x-reply", metricName: "views", value: 10, sampledAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() },
          { xPostId: "x-reply", metricName: "views", value: 25, sampledAt: replyAt },
          { xPostId: "x-reply", metricName: "likes", value: 3, sampledAt: replyAt },
        ])
        .run();

      expect(xActivityDashboard(backendDb, 0, 30, "UTC")).toMatchObject([
        { xPostId: "x-1", kind: "standalone", metrics: {} },
        { xPostId: "x-reply", kind: "reply", metrics: { views: 25, likes: 3 } },
        { xPostId: "x-repost", kind: "repost", metrics: {} },
        { xPostId: "x-unknown", kind: "standalone", metrics: {} },
      ]);
    }));

  it("imports linked posts and account-wide replies without adding editorial posts", () =>
    withDb(async (backendDb) => {
      const now = "2026-07-29T11:49:00.000Z";
      seedTextPost(backendDb, { postId: 1, en: "A linked Studio post", now });
      backendDb.sqlite
        .prepare(
          "INSERT INTO publication_targets(publication_key,target,status,external_id,url,updated_at) VALUES ('post:1','x','published','100','https://x.com/test/status/100',?)",
        )
        .run(now);
      const directory = mkdtempSync(join(tmpdir(), "x-activity-"));
      const file = join(directory, "account_analytics_content_2026-07-23_2026-07-29.csv");
      const metricValues = (views: number) => [views, 2, 4, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0];
      writeFileSync(
        file,
        [
          HEADERS.join(","),
          ["100", '"Wed, Jul 29, 2026"', "A linked Studio post", "https://x.com/test/status/100", ...metricValues(50)].join(","),
          ["101", '"Wed, Jul 29, 2026"', "@friend Useful answer", "https://x.com/test/status/101", ...metricValues(500)].join(","),
        ].join("\n"),
      );

      const result = importXAnalyticsCsv(backendDb, file, now);

      expect(result).toMatchObject({ linkedByExternalId: 1, linkedByText: 0, activityItems: 2, activitySamples: 26, insertedSamples: 13 });
      expect(backendDb.db.select().from(xActivityItems).all()).toMatchObject([
        { xPostId: "100", kind: "standalone", linkedPublicationKey: "post:1" },
        { xPostId: "101", kind: "reply", linkedPublicationKey: null },
      ]);
      expect(backendDb.db.select().from(xActivityMetricSnapshots).all()).toHaveLength(26);
      expect(
        (backendDb.sqlite.prepare("SELECT count(*) AS count FROM drafts WHERE post_id IS NOT NULL").get() as { count: number }).count,
      ).toBe(1);

      const repeated = importXAnalyticsCsv(backendDb, file, now);
      expect(repeated.activitySamples).toBe(0);
      expect(backendDb.db.select().from(xActivityItems).all()).toHaveLength(2);
    }));

  it("links imported activity to a post that only exists afterwards, and projects its metrics", () =>
    withDb(async (backendDb) => {
      const now = "2026-07-29T11:49:00.000Z";
      const text = "A Studio post written well after the export was imported";
      const directory = mkdtempSync(join(tmpdir(), "x-activity-relink-"));
      const file = join(directory, "account_analytics_content_2026-07-23_2026-07-29.csv");
      writeFileSync(
        file,
        [
          HEADERS.join(","),
          ["100", '"Wed, Jul 29, 2026"', `"${text}"`, "https://x.com/test/status/100", 50, 2, 4, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0].join(","),
        ].join("\n"),
      );
      expect(importXAnalyticsCsv(backendDb, file, now)).toMatchObject({ linkedByText: 0, insertedSamples: 0 });
      seedTextPost(backendDb, { postId: 1, en: text, now });

      expect(attachXActivityToPosts(backendDb, false)).toMatchObject({
        links: [{ xPostId: "100", publicationKey: "post:1", matchedBy: "direct_text" }],
        insertedSamples: 0,
      });
      // The plan wrote nothing: the same call is still available to apply.
      expect(attachXActivityToPosts(backendDb, true)).toMatchObject({ insertedSamples: 13, updatedMetrics: 13 });
      expect(attachXActivityToPosts(backendDb, true)).toMatchObject({ links: [], insertedSamples: 0, updatedMetrics: 0 });

      const samples = backendDb.sqlite
        .prepare("SELECT metric_name AS metric, value FROM metric_samples WHERE publication_key='post:1' AND metric_name='views'")
        .all();
      expect(samples).toMatchObject([{ metric: "views", value: 50 }]);
    }));

  it("links a tweet whose text is spelled differently or was edited on the same day", () =>
    withDb(async (backendDb) => {
      const now = "2026-07-29T11:49:00.000Z";
      const cases = [
        // The post reads `⚡️` and `>`; the export writes `⚡` and `&gt;`.
        {
          key: "post:1",
          post: "⚡️ OpenAI plans to sell resets > higher limits cost more money",
          x: "⚡ OpenAI plans to sell resets &gt; higher limits cost more money",
        },
        // Same publication, wording changed after it went out.
        {
          key: "post:2",
          post: "Alibaba released Qwen 3.8 Max and now it is up to users to see whether it wins",
          x: "Alibaba released Qwen 3.8 Max and now users will decide whether it wins",
        },
      ];
      for (const [index, item] of cases.entries()) seedTextPost(backendDb, { postId: index + 1, en: item.post, now });
      const directory = mkdtempSync(join(tmpdir(), "x-activity-spelling-"));
      const file = join(directory, "account_analytics_content_2026-07-23_2026-07-29.csv");
      const metrics = [50, 2, 4, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0];
      writeFileSync(
        file,
        [
          HEADERS.join(","),
          ...cases.map((item, index) =>
            [200 + index, '"Wed, Jul 29, 2026"', `"${item.x}"`, `https://x.com/test/status/${200 + index}`, ...metrics].join(","),
          ),
          // The same wording a day later belongs to no post: an edit explains one
          // publication reading two ways, not two publications on two days.
          ["300", '"Thu, Jul 30, 2026"', `"${cases[1]?.x}"`, "https://x.com/test/status/300", ...metrics].join(","),
        ].join("\n"),
      );

      const result = importXAnalyticsCsv(backendDb, file, now);

      expect(result).toMatchObject({ linkedByText: 2 });
      expect(
        backendDb.sqlite.prepare("SELECT x_post_id AS id, linked_publication_key AS post FROM x_activity_items ORDER BY id").all(),
      ).toMatchObject([
        { id: "200", post: "post:1" },
        { id: "201", post: "post:2" },
        { id: "300", post: null },
      ]);
    }));

  it("reports coverage and the near-miss links an import declined to make", () =>
    withDb(async (backendDb) => {
      const now = "2026-07-29T11:49:00.000Z";
      // Long enough for the linker to act on, and one that only clears the
      // report's lower bar: the second is the near miss the report exists for.
      const linked = "A long enough Studio post about the newest frontier model and what it changes for everyone";
      const short = "Shorter post about pricing";
      seedTextPost(backendDb, { postId: 1, en: `${linked} and a tail`, now });
      seedTextPost(backendDb, { postId: 2, en: `${short} and a tail`, now });
      backendDb.sqlite
        .prepare(
          "INSERT INTO publication_targets(publication_key,target,status,external_id,url,updated_at) VALUES ('post:9','x','published','900','https://x.com/test/status/900',?)",
        )
        .run(now);
      const directory = mkdtempSync(join(tmpdir(), "x-activity-report-"));
      const file = join(directory, "account_analytics_content_2026-07-23_2026-07-29.csv");
      const metricValues = (views: number) => [views, 2, 4, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0];
      writeFileSync(
        file,
        [
          HEADERS.join(","),
          ["100", '"Wed, Jul 29, 2026"', `"${linked}"`, "https://x.com/test/status/100", ...metricValues(50)].join(","),
          ["101", '"Wed, Jul 29, 2026"', `"${short}"`, "https://x.com/test/status/101", ...metricValues(500)].join(","),
        ].join("\n"),
      );
      importXAnalyticsCsv(backendDb, file, now);

      const report = xAnalyticsReport(backendDb, 10);

      expect(report.imports).toMatchObject([{ id: 1, rowCount: 2, sampledAt: now, items: 2 }]);
      expect(report.items).toMatchObject({ total: 2, linked: 1, unlinked: 1 });
      // post:9 was published to X but no export row carries it.
      expect(report.editorialCoverage).toMatchObject({ xTargets: 2, covered: 1, uncovered: [{ publicationKey: "post:9" }] });
      expect(report.linkCandidates).toMatchObject([{ xPostId: "101", publicationKey: "post:2" }]);
      expect(report.topUnlinked[0]).toMatchObject({ xPostId: "101", metrics: { views: 500, likes: 2, replies: 1 } });
    }));

  it("adds only X activity that is not already represented in the editorial totals", () => {
    const editorial = {
      posts: [
        {
          publication_key: "post:1",
          date: "2026-07-29T10:00:00.000Z",
          text_en: "Editorial post",
          targets: {
            telegram: { status: "published" },
            x: { status: "published" },
          },
          metrics: {
            telegram: {
              views: { value: 100 },
              likes: { value: 4 },
              replies: { value: 2 },
              reposts: { value: 1 },
            },
            x: {
              views: { value: 50 },
              likes: { value: 2 },
              replies: { value: 1 },
              reposts: { value: 1 },
            },
          },
        },
      ],
    };
    const items = [
      {
        xPostId: "100",
        kind: "standalone" as const,
        publishedAt: "2026-07-29T10:00:00.000Z",
        text: "Editorial post",
        url: "https://x.com/test/status/100",
        linkedPublicationKey: "post:1",
        metrics: { views: 50, interactions: 8, replies: 1 },
      },
      {
        xPostId: "101",
        kind: "reply" as const,
        publishedAt: "2026-07-29T11:00:00.000Z",
        text: "@friend Useful answer",
        url: "https://x.com/test/status/101",
        linkedPublicationKey: null,
        metrics: { views: 500, interactions: 40, replies: 3 },
      },
    ];

    const html = renderOverview({
      data: editorial,
      previousData: { posts: [] },
      xItems: items,
      previousXItems: [],
      dayComparisonData: { posts: [] },
      video: emptyVideoOverview(),
      previousVideo: emptyVideoOverview(),
      dayComparisonVideo: emptyVideoOverview(),
      followers: [{ key: "x", label: "X", followers: 83 }],
      rangeStart: new Date("2026-07-29"),
      rangeEnd: new Date("2026-07-29"),
      periodDays: 1,
      weekOffset: 0,
      timeZone: "Europe/Moscow",
      platformMetric: "reach",
    });

    // Standalone X activity is folded into the text half: 150 from the post's
    // targets plus 500 from the unlinked reply.
    expect(html).toContain("<strong>650</strong>");
    expect(html).toContain("ПУБЛИКАЦИИ");
    expect(html).not.toContain("Детальная динамика и публикации");
    // The two halves are reported separately and never added together.
    expect(html).toContain("Текст");
    expect(html).toContain("Видео");
    // The unified overview has no content-type mode switch.
    expect(html).not.toContain('class="mode-filter"');
  });
});
