import { describe, expect, it, mock } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { TerminalMetricError } from "../src/analytics/collection/collectors/errors.js";
import { createMetricCollectors, SUPPORTED_METRIC_TARGETS } from "../src/analytics/collection/collectors/index.js";
import { claimDueMetricTasks, type MetricTask } from "../src/analytics/collection/metric-schedule.js";
import { runMetricsCycle } from "../src/analytics/collection/metrics-cycle.js";
import { metricSamples, metricSchedule, postMetrics, publicationTargets, workerState } from "../src/db/schema.js";
import { withDb } from "./helpers/db.js";
import type { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("metrics cycle", () => {
  it("schedules published targets and persists metric samples", () =>
    withDb(async (backendDb) => {
      seedPublishedPost(backendDb, "post:1", "threads_ru");
      const checked = await runMetricsCycle(loadTestConfig({ MAX_METRIC_TASKS_PER_CYCLE: "10" }), backendDb, {
        threads_ru: async () => ({
          metrics: { views: 120, likes: 9 },
          source: "test_api",
          raw: { id: 1 },
          url: "https://threads.test/new-url",
        }),
      });
      expect(checked).toBe(1);
      expect(
        backendDb.db
          .select({
            metricName: postMetrics.metricName,
            value: postMetrics.value,
            source: postMetrics.source,
            rawJson: postMetrics.rawJson,
          })
          .from(postMetrics)
          .orderBy(asc(postMetrics.metricName))
          .all(),
      ).toEqual([
        { metricName: "likes", value: 9, source: "test_api", rawJson: { id: 1 } },
        { metricName: "views", value: 120, source: "test_api", rawJson: { id: 1 } },
      ]);
      expect(backendDb.db.select({ rawJson: metricSamples.rawJson }).from(metricSamples).all()).toEqual([
        { rawJson: null },
        { rawJson: null },
      ]);
      expect(backendDb.db.select({ url: publicationTargets.url }).from(publicationTargets).get()).toEqual({
        url: "https://threads.test/new-url",
      });
      expect(
        backendDb.db.select({ checkCount: metricSchedule.checkCount, lastError: metricSchedule.lastError }).from(metricSchedule).get(),
      ).toEqual({ checkCount: 1, lastError: null });
      expect(
        backendDb.db.select({ stateJson: workerState.stateJson }).from(workerState).where(eq(workerState.name, "metrics")).get()?.stateJson,
      ).toMatchObject({
        checked: 1,
        ok: true,
        last_error: null,
      });
    }));

  it("stores collector errors and retries the same durable checkpoint", () =>
    withDb(async (backendDb) => {
      seedPublishedPost(backendDb, "post:2", "threads_ru");
      await runMetricsCycle(loadTestConfig({}), backendDb, {
        threads_ru: async () => {
          throw new Error("upstream unavailable");
        },
      });
      expect(backendDb.db.select({ value: postMetrics.value, error: postMetrics.error }).from(postMetrics).get()).toEqual({
        value: null,
        error: "upstream unavailable",
      });
      expect(
        backendDb.db.select({ checkCount: metricSchedule.checkCount, lastError: metricSchedule.lastError }).from(metricSchedule).get(),
      ).toEqual({ checkCount: 0, lastError: "upstream unavailable" });
    }));

  it("does not schedule or run X metrics unless explicitly enabled", () =>
    withDb(async (backendDb) => {
      seedPublishedPost(backendDb, "post:3", "x");
      const config = loadTestConfig({ MAX_METRIC_TASKS_PER_CYCLE: "10" });
      const collectors = createMetricCollectors(config);
      expect(collectors.x).toBeUndefined();
      expect(await runMetricsCycle(config, backendDb, collectors)).toBe(0);
      expect(backendDb.db.select().from(metricSchedule).all()).toEqual([]);
    }));

  it("freezes a terminal collector error instead of retrying it", () =>
    withDb(async (backendDb) => {
      seedPublishedPost(backendDb, "post:4", "threads_ru");
      await runMetricsCycle(loadTestConfig({}), backendDb, {
        threads_ru: async () => {
          throw new TerminalMetricError("post expired");
        },
      });
      expect(
        backendDb.db.select({ frozenAt: metricSchedule.frozenAt, lastError: metricSchedule.lastError }).from(metricSchedule).get(),
      ).toEqual({ frozenAt: expect.any(String), lastError: "post expired" });
    }));

  it("claims the oldest due metric checkpoint before newer posts", () =>
    withDb(async (backendDb) => {
      seedPublishedPost(backendDb, "post:5", "threads_ru");
      seedPublishedPost(backendDb, "post:6", "threads_ru");
      const now = Date.now();
      backendDb.db
        .insert(metricSchedule)
        .values([
          {
            publicationKey: "post:5",
            target: "threads_ru",
            nextCheckAt: new Date(now - 60_000).toISOString(),
            updatedAt: new Date(now - 60_000).toISOString(),
          },
          {
            publicationKey: "post:6",
            target: "threads_ru",
            nextCheckAt: new Date(now - 1_000).toISOString(),
            updatedAt: new Date(now - 1_000).toISOString(),
          },
        ])
        .run();
      expect(claimDueMetricTasks(backendDb, loadTestConfig({ MAX_METRIC_TASKS_PER_CYCLE: "1" }), ["threads_ru"])[0]?.publicationKey).toBe(
        "post:5",
      );
    }));

  it("does not let schedules without collectors block supported targets", () =>
    withDb(async (backendDb) => {
      seedPublishedPost(backendDb, "post:7", "site_en");
      seedPublishedPost(backendDb, "post:8", "threads_ru");
      const now = Date.now();
      backendDb.db
        .insert(metricSchedule)
        .values({
          publicationKey: "post:7",
          target: "site_en",
          nextCheckAt: new Date(now - 60_000).toISOString(),
          updatedAt: new Date(now - 60_000).toISOString(),
        })
        .run();

      const checked = await runMetricsCycle(loadTestConfig({ MAX_METRIC_TASKS_PER_CYCLE: "1" }), backendDb, {
        threads_ru: async () => ({ metrics: { views: 42 }, source: "test_api", raw: null }),
      });

      expect(checked).toBe(1);
      expect(
        backendDb.db
          .select({ publicationKey: postMetrics.publicationKey, value: postMetrics.value })
          .from(postMetrics)
          .where(eq(postMetrics.publicationKey, "post:8"))
          .get(),
      ).toEqual({ publicationKey: "post:8", value: 42 });
      expect(
        backendDb.db
          .select({ checkCount: metricSchedule.checkCount })
          .from(metricSchedule)
          .where(eq(metricSchedule.publicationKey, "post:7"))
          .get(),
      ).toEqual({ checkCount: 0 });
    }));

  it("retires schedules for targets the product no longer collects", () =>
    withDb(async (backendDb) => {
      seedPublishedPost(backendDb, "post:9", "bluesky");
      seedPublishedPost(backendDb, "post:10", "x");
      const overdue = new Date(Date.now() - 60_000).toISOString();
      backendDb.db
        .insert(metricSchedule)
        .values([
          { publicationKey: "post:9", target: "bluesky", nextCheckAt: overdue, updatedAt: overdue },
          { publicationKey: "post:10", target: "x", nextCheckAt: overdue, updatedAt: overdue },
        ])
        .run();

      await runMetricsCycle(loadTestConfig({ ENABLE_X_METRICS: "1" }), backendDb, {});

      expect(
        backendDb.db
          .select({ target: metricSchedule.target, frozenAt: metricSchedule.frozenAt, nextCheckAt: metricSchedule.nextCheckAt })
          .from(metricSchedule)
          .orderBy(asc(metricSchedule.target))
          .all(),
      ).toEqual([
        { target: "bluesky", frozenAt: expect.any(String), nextCheckAt: null },
        // Paid targets are switched by a flag, not retired: freezing them would
        // silently drop a live schedule the next time X metrics are turned on.
        { target: "x", frozenAt: null, nextCheckAt: overdue },
      ]);
    }));

  it("keeps the static supported list in step with the collectors it guards", () => {
    expect([...(SUPPORTED_METRIC_TARGETS as readonly string[])].sort()).toEqual(
      Object.keys(createMetricCollectors(loadTestConfig({ ENABLE_X_METRICS: "1" }))).sort(),
    );
  });
});

describe("Telegram public metrics", () => {
  // The channel is the subject of these tests, so they name it rather than
  // leaning on a default. It used to be a live channel of this deployment.
  const telegramConfig = () => loadTestConfig({ TELEGRAM_CHANNEL_USERNAME: "alexgetmancom" });
  it("loads the target post directly, parses compact views, and sums reactions", async () => {
    const html = `<section><div data-post="alexgetmancom/523"><span class="tgme_widget_message_views">1.2K</span><span class="tgme_reaction"><i></i>3</span><span class="tgme_reaction"><i></i>2</span></div></section>`;
    let requestedUrl = "";
    const fetchImpl = mock(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(html, { status: 200 });
    }) as unknown as typeof fetch;
    const collector = createMetricCollectors(telegramConfig(), fetchImpl).telegram;
    if (!collector) throw new Error("Telegram collector is missing");
    const result = await collector(task("telegram"));
    expect(requestedUrl).toBe("https://t.me/alexgetmancom/523?embed=1&mode=tme");
    expect(result).toMatchObject({ metrics: { views: 1200, likes: 5 }, source: "t_me_public" });
  });

  it("treats a missing target post as terminal", async () => {
    const fetchImpl = mock(async () => new Response("<html></html>", { status: 200 })) as unknown as typeof fetch;
    const collector = createMetricCollectors(telegramConfig(), fetchImpl).telegram;
    if (!collector) throw new Error("Telegram collector is missing");
    await expect(collector(task("telegram"))).rejects.toBeInstanceOf(TerminalMetricError);
  });

  it("recovers a legacy message ID from the canonical Telegram URL", async () => {
    const html = `<section><div data-post="alexgetmancom/436"><span class="tgme_widget_message_views">42</span></div></section>`;
    let requestedUrl = "";
    const fetchImpl = mock(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(html, { status: 200 });
    }) as unknown as typeof fetch;
    const collector = createMetricCollectors(telegramConfig(), fetchImpl).telegram;
    if (!collector) throw new Error("Telegram collector is missing");
    const legacyTask = { ...task("telegram"), externalId: null, url: "https://t.me/alexgetmancom/436" };
    expect(await collector(legacyTask)).toMatchObject({ metrics: { views: 42 } });
    expect(requestedUrl).toBe("https://t.me/alexgetmancom/436?embed=1&mode=tme");
  });
});

function seedPublishedPost(backendDb: ReturnType<typeof openBackendDb>, publicationKey: string, target: string): void {
  const date = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const postId = Number(publicationKey.replace("post:", ""));
  seedTextPost(backendDb, { postId, messageId: 42, now: date });
  backendDb.db
    .insert(publicationTargets)
    .values({
      publicationKey,
      target,
      status: "published",
      externalId: "external-1",
      url: "https://example.test/post",
      publishedAt: date,
      updatedAt: date,
    })
    .run();
}

function task(target: string): MetricTask {
  return {
    publicationKey: "post:42",
    target,
    checkCount: 0,
    messageId: 42,
    dateUtc: new Date().toISOString(),
    externalId: "523",
    externalIds: ["523"],
    url: null,
    lockId: "test-worker",
  };
}
