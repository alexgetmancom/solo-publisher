import { describe, expect, it } from "bun:test";
import { zonedRollingPeriodBounds } from "../src/foundation/time.js";
import { pipelineOverviewPayload } from "../src/operations/read-model.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig, MSK_STUDIO_PROFILE } from "./helpers/studio-config.js";

describe("dashboard read model bounds", () => {
  it("puts a publication in the period it reached its audience, not the one it was drafted in", () =>
    withDb(async (backendDb) => {
      const [todayStart] = zonedRollingPeriodBounds(0, 1, "Europe/Moscow");
      const publishedToday = new Date(Date.parse(todayStart) + 60_000).toISOString();
      const draftedThreeDaysAgo = new Date(Date.parse(todayStart) - 3 * 86_400_000).toISOString();

      seedTextPost(backendDb, { postId: 1, ru: "Scheduled ahead", siteRu: true, publishedAt: publishedToday, now: draftedThreeDaysAgo });
      backendDb.sqlite
        .prepare(
          "INSERT INTO publication_targets(publication_key,target,status,published_at,updated_at) VALUES ('post:1','telegram','published',?,?)",
        )
        .run(publishedToday, publishedToday);

      // Scheduled on Friday, published on Monday: the dashboard's "today" used
      // to ask when the row was made, so the post was live everywhere and
      // missing from the only view its author was looking at.
      const today = pipelineOverviewPayload(loadTestConfig({}, MSK_STUDIO_PROFILE), backendDb, 0, 1);
      expect(today.posts.map((post) => post.post_id)).toEqual([1]);
    }));

  it("filters samples, aggregates them into time buckets, and omits provider raw payloads", () =>
    withDb(async (backendDb) => {
      const [periodStart] = zonedRollingPeriodBounds(0, 1, "Europe/Moscow");
      const periodStartMs = Date.parse(periodStart);
      const [periodStart30] = zonedRollingPeriodBounds(0, 30, "Europe/Moscow");
      const periodStart30Ms = Date.parse(periodStart30);
      const postAt = new Date(periodStartMs + 1_000).toISOString();
      const raw = JSON.stringify({ provider: "fixture", response: "x".repeat(2_000) });

      seedTextPost(backendDb, { postId: 1, ru: "Fixture", siteRu: true, publishedAt: postAt, now: postAt });
      backendDb.sqlite
        .prepare(
          "INSERT INTO publication_targets(publication_key,target,status,updated_at,raw_json) VALUES ('post:1','telegram','published',?,?)",
        )
        .run(postAt, raw);
      backendDb.sqlite
        .prepare(
          "INSERT INTO post_metrics(publication_key,target,metric_name,value,unit,source,sampled_at,raw_json) VALUES ('post:1','telegram','views',250,'count','fixture',?,?)",
        )
        .run(postAt, raw);

      const sampleInsert = backendDb.sqlite.prepare(
        "INSERT INTO metric_samples(publication_key,target,metric_name,value,sampled_at,source,raw_json) VALUES ('post:1','telegram','views',?,?,?,?)",
      );
      sampleInsert.run(999, new Date(periodStartMs - 1_000).toISOString(), "fixture", raw);
      for (let index = 0; index < 30 * 24; index += 1) {
        sampleInsert.run(index, new Date(periodStart30Ms + index * 60 * 60 * 1_000 + 2_000).toISOString(), "fixture", raw);
      }
      for (let index = 0; index < 24 * 12; index += 1) {
        sampleInsert.run(1_000 + index, new Date(periodStartMs + index * 5 * 60 * 1_000 + 2_000).toISOString(), "fixture", raw);
      }

      type TestPost = {
        metrics: { telegram: { views: { raw?: unknown; samples: Array<{ value: number; sampled_at: string }> } } };
        targets: { telegram: Record<string, unknown> };
      };
      const payload = pipelineOverviewPayload(loadTestConfig({}, MSK_STUDIO_PROFILE), backendDb, 0, 1, 0, undefined, {
        includeSamples: true,
        sampleLimitPerSeries: 200,
      }) as unknown as { posts: TestPost[] };
      const post = payload.posts[0];
      if (!post) throw new Error("Expected one pipeline post");
      const metric = post.metrics.telegram.views;
      const target = post.targets.telegram;

      expect(metric.samples).toHaveLength(24);
      // A bucket keeps its last reading, reported at the moment it was taken.
      expect(metric.samples[0]).toEqual({
        value: 1_011,
        sampled_at: new Date(periodStartMs + 11 * 5 * 60 * 1_000 + 2_000).toISOString(),
      });
      expect(metric.samples.some((sample: { value: number }) => sample.value === 999)).toBe(false);
      expect(metric).not.toHaveProperty("raw");
      expect(target).not.toHaveProperty("raw");

      const longPeriod = pipelineOverviewPayload(loadTestConfig({}, MSK_STUDIO_PROFILE), backendDb, 0, 30, 0, undefined, {
        includeSamples: true,
        sampleLimitPerSeries: 200,
      }) as unknown as { posts: TestPost[] };
      expect(longPeriod.posts[0]?.metrics.telegram.views.samples).toHaveLength(30);
      expect(longPeriod.posts[0]?.metrics.telegram.views.samples[0]?.sampled_at).toBe(
        new Date(periodStart30Ms + 23 * 60 * 60 * 1_000 + 2_000).toISOString(),
      );

      const compact = pipelineOverviewPayload(loadTestConfig({}, MSK_STUDIO_PROFILE), backendDb, 0, 1, 0, undefined, {
        includeSamples: false,
        includeContent: false,
        compact: true,
      }) as unknown as { posts: Array<Record<string, unknown>> };
      expect(compact.posts[0]).not.toHaveProperty("full_text_en");
      expect(compact.posts[0]).not.toHaveProperty("media_en_json");
      expect(compact.posts[0]).toMatchObject({ post_id: 1, telegram_url: null });
      expect(compact.posts[0]?.targets).toEqual({ telegram: { status: "published", url: null } });
      expect(compact.posts[0]?.metrics).toEqual({ telegram: { views: { value: 250 } } });
    }));
});
