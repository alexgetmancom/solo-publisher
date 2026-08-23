import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X_ANALYTICS_SOURCE } from "../src/analytics/x-activity-linking.js";
import { TARGETS } from "../src/botTargets.js";
import { metricSchedule } from "../src/db/schema.js";
import { formatSupportSummary, seedFormatSupport } from "../src/operations/format-support.js";
import {
  applyMetricsBackfill,
  auditOperations,
  backupDatabase,
  buildMetricsBackfillPlan,
  publicationConsistencyReport,
  repairPublicationConsistency,
  withMaintenanceLock,
} from "../src/operations/maintenance.js";
import { diagnoseMediaProcessor, mediaProcessorStatus, reprocessPostMedia } from "../src/operations/media-processor.js";
import { compactOperationsStatus } from "../src/operations/status.js";
import { publicationTimeline } from "../src/operations/timeline.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

function insertVideoAsset(backendDb: ReturnType<typeof openBackendDb>): void {
  backendDb.sqlite
    .query(
      "INSERT INTO studio_media_assets(id,actor_id,kind,mime_type,filename,local_path,byte_size,sha256,source,created_at) VALUES (1,1,'video','video/mp4','test.mp4','/tmp/test.mp4',1,'test','test',?)",
    )
    .run(new Date().toISOString());
}

describe("TypeScript operations tooling", () => {
  it("builds a durable publication timeline with parsed details and durations", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.sqlite
        .query(
          "INSERT INTO publish_jobs(publication_key,target,status,locked_at,created_at,updated_at) VALUES ('post:106','telegram','published',?,?,?)",
        )
        .run(now, now, new Date(Date.parse(now) + 25).toISOString());
      backendDb.sqlite
        .query("INSERT INTO publication_targets(publication_key,target,status,updated_at) VALUES ('post:106','telegram','published',?)")
        .run(now);
      backendDb.sqlite
        .query(
          "INSERT INTO publication_events(publication_key,event_type,severity,target,message,details_json,created_at) VALUES ('post:106','publish.job.phase','info','telegram','done','{\"phase\":\"provider.publish\",\"duration_ms\":25}',?)",
        )
        .run(now);
      const timeline = publicationTimeline(backendDb, "post:106");
      expect(timeline.jobs).toEqual([expect.objectContaining({ target: "telegram", durationMs: 25 })]);
      expect(timeline.events).toEqual([expect.objectContaining({ details: { phase: "provider.publish", duration_ms: 25 } })]);
    } finally {
      backendDb.close();
    }
  });

  it("diagnoses the remote media processor with an authenticated idempotent fixture", async () => {
    const config = loadTestConfig({
      MEDIA_PROCESSOR_PROVIDER: "remote_http",
      MEDIA_PROCESSOR_URL: "http://127.0.0.1:9087",
      MEDIA_PROCESSOR_TOKEN: "a".repeat(16),
    });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ ok: true, queued: 0, active: 0, concurrency: 1, version: "test", vaapi: true });
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${"a".repeat(16)}` });
      return Response.json({ job: "fixture", timings: { uploadMs: 1, queueWaitMs: 0, ffmpegMs: 2, totalMs: 3, cacheHit: true } });
    }) as typeof fetch;
    expect(await mediaProcessorStatus(config, fetchImpl)).toMatchObject({ ok: true, version: "test", vaapi: true });
    expect(await diagnoseMediaProcessor(config, fetchImpl)).toMatchObject({
      ok: true,
      authenticatedFixture: { ok: true, status: 200, result: { job: "fixture" } },
    });
  });

  it("keeps media reprocessing read-only unless apply is explicit", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.sqlite
        .query(
          "INSERT INTO publish_jobs(publication_key,target,status,payload_json,created_at,updated_at) VALUES ('post:106','instagram_stories','published',?,?,?)",
        )
        .run(JSON.stringify({ locale: "en", media: [{ type: "IMAGE", localPath: "/tmp/source.jpg" }] }), now, now);
      const plan = await reprocessPostMedia(backendDb, loadTestConfig({}), "post:106", false);
      expect(plan).toMatchObject({ ok: true, apply: false, count: 1 });
    } finally {
      backendDb.close();
    }
  });

  it("creates a consistent SQLite backup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alexgetman-backup-"));
    const dbPath = join(directory, "pipeline.db");
    const backendDb = openBackendDb(dbPath);
    try {
      backendDb.sqlite.prepare("INSERT INTO worker_state(name,state_json,updated_at) VALUES ('test','{}',?)").run(new Date().toISOString());
      const backup = await backupDatabase(backendDb, dbPath);
      expect(existsSync(backup)).toBe(true);
      const restored = new Database(backup, { readonly: true });
      try {
        expect(restored.prepare("SELECT name FROM worker_state").get()).toEqual({ name: "test" });
      } finally {
        restored.close();
      }
    } finally {
      backendDb.close();
    }
  });

  it("seeds all media capability cases", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedFormatSupport(backendDb);
      expect(formatSupportSummary(backendDb)).toHaveLength(9);
      // One row per (target, format), derived rather than restated: a new target
      // must widen the grid instead of failing an arithmetic assertion.
      expect((backendDb.sqlite.prepare("SELECT count(*) AS count FROM format_support").get() as { count: number }).count).toBe(
        TARGETS.length * 9,
      );
    } finally {
      backendDb.close();
    }
  });

  it("plans and applies a metrics backfill under a maintenance lock", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 1, now });
      backendDb.sqlite
        .prepare("INSERT INTO publication_targets(publication_key,target,status,updated_at) VALUES ('post:1','threads_ru','published',?)")
        .run(now);
      const plan = buildMetricsBackfillPlan(backendDb, { targets: ["threads_ru"] });
      expect(plan).toHaveLength(1);
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
      expect(withMaintenanceLock(backendDb, () => applyMetricsBackfill(backendDb, config, plan, true))).toBe(1);
      expect(
        backendDb.sqlite
          .prepare("SELECT check_count,frozen_at FROM metric_schedule WHERE publication_key='post:1' AND target='threads_ru'")
          .get(),
      ).toEqual({ check_count: 0, frozen_at: null });
      expect((backendDb.sqlite.prepare("SELECT count(*) AS count FROM maintenance_locks").get() as { count: number }).count).toBe(0);
    } finally {
      backendDb.close();
    }
  });

  it("keeps frozen terminal metric history out of audit errors", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(metricSchedule)
        .values([
          { publicationKey: "post:active", target: "telegram", lastError: "temporary", updatedAt: now },
          { publicationKey: "post:frozen", target: "telegram", lastError: "terminal", frozenAt: now, updatedAt: now },
        ])
        .run();
      expect(auditOperations(backendDb).metricScheduleErrors).toEqual([{ target: "telegram", count: 1, latest: now }]);
    } finally {
      backendDb.close();
    }
  });

  it("keeps publication status compact while reporting publication health", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 1, now });
      backendDb.sqlite
        .prepare("INSERT INTO publication_targets(publication_key,target,status,updated_at) VALUES ('post:1','telegram','published',?)")
        .run(now);
      backendDb.sqlite
        .prepare(
          "INSERT INTO publish_jobs(publication_key,target,status,created_at,updated_at) VALUES ('post:1','telegram','published',?,?)",
        )
        .run(now, now);
      backendDb.sqlite
        .prepare('INSERT INTO worker_state(name,state_json,updated_at) VALUES (\'queue\',\'{"ok":true,"last_run_at":"2026-01-01"}\',?)')
        .run(now);

      const status = compactOperationsStatus(loadTestConfig({}), backendDb);

      expect(status.ok).toBe(false);
      expect(status.missingWorkers).toContain("story-cards");
      expect(status.posts).toEqual({
        total: 1,
        targets: { total: 1, byStatus: { published: 1 } },
        jobs: { total: 1, byStatus: { published: 1 } },
      });
      expect(status.videos.drafts.total).toBe(0);
      expect(status.workers).toHaveLength(1);
      expect(status.workers[0]).toMatchObject({
        name: "queue",
        ok: true,
        lastRunAt: "2026-01-01",
        lastError: null,
        ageSeconds: expect.any(Number),
        lastHeartbeatAt: expect.any(String),
        stale: false,
      });
      expect(JSON.stringify(status).length).toBeLessThan(2_000);
      expect(status).not.toHaveProperty("jobs");
    } finally {
      backendDb.close();
    }
  });

  it("reports actionable video failures in Studio status", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      insertVideoAsset(backendDb);
      backendDb.sqlite
        .prepare(
          "INSERT INTO video_drafts(id,actor_id,label,studio_media_asset_id,status,created_at,updated_at) VALUES (1,1,'video',1,'partial',?,?)",
        )
        .run(now, now);
      backendDb.sqlite
        .prepare(
          "INSERT INTO video_targets(video_draft_id,target,metadata_json,status,last_error,created_at,updated_at) VALUES (1,'instagram_reels','{}','failed','boom',?,?)",
        )
        .run(now, now);
      backendDb.sqlite
        .prepare("INSERT INTO video_jobs(video_draft_id,kind,run_at,status,created_at,updated_at) VALUES (1,'publish',?,'failed',?,?)")
        .run(now, now, now);
      const config = loadTestConfig({});
      const status = compactOperationsStatus(config, backendDb);

      expect(status.ok).toBe(false);
      expect(status.videos).toEqual({
        drafts: { total: 1, byStatus: { partial: 1 } },
        targets: { total: 1, byStatus: { failed: 1 }, actionableFailures: 1 },
        jobs: { total: 1, byStatus: { failed: 1 } },
      });
      expect(status.posts.total).toBe(0);
    } finally {
      backendDb.close();
    }
  });

  it("reports only actionable video failures, not draft or cancelled lifecycle history", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      insertVideoAsset(backendDb);
      for (const [id, status] of [
        [1, "draft"],
        [2, "cancelled"],
        [3, "partial"],
      ] as const) {
        backendDb.sqlite
          .query(
            "INSERT INTO video_drafts(id,actor_id,label,studio_media_asset_id,status,created_at,updated_at) VALUES (?,1,'test',1,?,?,?)",
          )
          .run(id, status, now, now);
        backendDb.sqlite
          .query(
            "INSERT INTO video_targets(video_draft_id,target,metadata_json,status,last_error,created_at,updated_at) VALUES (?,'instagram_reels','{}','failed','boom',?,?)",
          )
          .run(id, now, now);
      }

      expect(auditOperations(backendDb).recentVideoFailures).toEqual([
        expect.objectContaining({ videoDraftId: 3, status: "failed", lastError: "boom" }),
      ]);
    } finally {
      backendDb.close();
    }
  });

  it("reports a published video target whose publish job still says failed", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      insertVideoAsset(backendDb);
      backendDb.sqlite
        .query(
          "INSERT INTO video_drafts(id,actor_id,label,studio_media_asset_id,status,created_at,updated_at) VALUES (1,1,'test',1,'published',?,?)",
        )
        .run(now, now);
      backendDb.sqlite
        .query(
          "INSERT INTO video_targets(id,video_draft_id,target,metadata_json,status,provider_post_id,created_at,updated_at) VALUES (1,1,'instagram_reels','{}','published','zernio-1',?,?)",
        )
        .run(now, now);
      backendDb.sqlite
        .query(
          "INSERT INTO video_jobs(video_draft_id,video_target_id,kind,run_at,status,last_error,created_at,updated_at) VALUES (1,1,'publish',?,'failed','stale failure',?,?)",
        )
        .run(now, now, now);

      expect(publicationConsistencyReport(backendDb).videoTargetJobMismatches).toEqual([
        expect.objectContaining({
          video_draft_id: 1,
          video_target_id: 1,
          target_status: "published",
          job_status: "failed",
        }),
      ]);
      expect(repairPublicationConsistency(backendDb, { ref: "video:1" })).toMatchObject({ repairedVideoJobs: 1, skippedVideoJobs: 0 });
      expect(backendDb.sqlite.query("SELECT status,last_error FROM video_jobs WHERE id=1").get()).toEqual({
        status: "completed",
        last_error: null,
      });
    } finally {
      backendDb.close();
    }
  });

  it("surfaces unresolved ordinary and video publications separately from failures", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      insertVideoAsset(backendDb);
      backendDb.sqlite
        .query(
          "INSERT INTO publish_jobs(publication_key,target,status,last_error,created_at,updated_at) VALUES ('post:1','x','verification_required','socket closed',?,?)",
        )
        .run(now, now);
      backendDb.sqlite
        .query(
          "INSERT INTO publication_targets(publication_key,target,status,error,updated_at) VALUES ('post:1','x','verification_required','socket closed',?)",
        )
        .run(now);
      backendDb.sqlite
        .query(
          "INSERT INTO video_drafts(id,actor_id,label,studio_media_asset_id,status,created_at,updated_at) VALUES (1,1,'video',1,'partial',?,?)",
        )
        .run(now, now);
      backendDb.sqlite
        .query(
          "INSERT INTO video_targets(video_draft_id,target,metadata_json,status,last_error,created_at,updated_at) VALUES (1,'instagram_reels','{}','verification_required','timeout',?,?)",
        )
        .run(now, now);

      const audit = auditOperations(backendDb);
      expect(audit.deliveryIssues).toEqual([
        { source: "post_target", status: "verification_required", target: "x", count: 1, latest: now },
        { source: "publish_job", status: "verification_required", target: "x", count: 1, latest: now },
      ]);
      expect(audit.recentVideoVerificationRequired).toEqual([
        expect.objectContaining({ videoDraftId: 1, target: "instagram_reels", lastError: "timeout" }),
      ]);
    } finally {
      backendDb.close();
    }
  });

  it("repairs orphaned publication rows and canonical state mismatches", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.sqlite.run("PRAGMA foreign_keys=OFF");
      backendDb.sqlite.query("INSERT INTO metric_schedule(publication_key,target,updated_at) VALUES ('post:orphan','telegram',?)").run(now);
      backendDb.sqlite
        .query(
          "INSERT INTO video_targets(id,video_draft_id,target,metadata_json,status,created_at,updated_at) VALUES (1,999,'instagram_reels','{}','failed',?,?)",
        )
        .run(now, now);
      backendDb.sqlite
        .query(
          "INSERT INTO video_jobs(id,video_draft_id,video_target_id,kind,run_at,status,created_at,updated_at) VALUES (1,999,1,'publish',?,'failed',?,?)",
        )
        .run(now, now, now);
      backendDb.sqlite
        .query("INSERT INTO video_metric_schedule(video_target_id,checkpoint_index,next_check_at,updated_at) VALUES (1,0,?,?)")
        .run(now, now);
      backendDb.sqlite
        .query("INSERT INTO video_metric_snapshots(video_target_id,platform,metrics_json,sampled_at) VALUES (1,'instagram_reels','{}',?)")
        .run(now);
      backendDb.sqlite.run("PRAGMA foreign_keys=ON");
      seedTextPost(backendDb, { postId: 1, actorId: 1, status: "failed", ru: "text", now });
      backendDb.sqlite
        .query(
          "INSERT INTO publication_targets(publication_key,target,status,error,updated_at) VALUES ('post:1','telegram','failed','stale',?)",
        )
        .run(now);
      backendDb.sqlite
        .query("INSERT INTO publish_jobs(publication_key,target,status,created_at,updated_at) VALUES ('post:1','telegram','published',?,?)")
        .run(now, now);
      expect(publicationConsistencyReport(backendDb).targetMismatches).toHaveLength(1);
      expect(repairPublicationConsistency(backendDb)).toMatchObject({
        foreignKeyViolations: 2,
        deletedOrphans: 5,
        repairedTargets: 1,
        repairedPublications: 1,
      });
      expect(backendDb.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        backendDb.sqlite.query("SELECT status,error FROM publication_targets WHERE publication_key='post:1' AND target='telegram'").get(),
      ).toEqual({
        status: "published",
        error: null,
      });
      expect(backendDb.sqlite.query("SELECT status FROM drafts WHERE id=1").get()).toEqual({ status: "published" });
      expect(backendDb.sqlite.query("SELECT count(*) AS count FROM video_targets").get()).toEqual({ count: 0 });
      expect(backendDb.sqlite.query("SELECT count(*) AS count FROM video_jobs").get()).toEqual({ count: 0 });
      expect(backendDb.sqlite.query("SELECT count(*) AS count FROM video_metric_schedule").get()).toEqual({ count: 0 });
      expect(backendDb.sqlite.query("SELECT count(*) AS count FROM video_metric_snapshots").get()).toEqual({ count: 0 });
    } finally {
      backendDb.close();
    }
  });

  it("does not call an X post attached from analytics a mismatch", () => {
    // The post is on X; it just did not get there through this queue. Its old
    // job was cancelled, and reading that as the truth about the target is how
    // two live posts sat in the report for a month — and repairing them would
    // have marked them cancelled and stopped their metrics.
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 2, actorId: 1, status: "published", ru: "text", now });
      backendDb.sqlite
        .query(
          `INSERT INTO publication_targets(publication_key,target,status,external_id,url,updated_at,raw_json)
           VALUES ('post:2','x','published','2075644218979057803','https://x.com/i/web/status/2075644218979057803',?,?)`,
        )
        .run(now, JSON.stringify({ source: X_ANALYTICS_SOURCE, x_post_id: "2075644218979057803", matched_by: "direct_text" }));
      backendDb.sqlite
        .query(
          "INSERT INTO publish_jobs(publication_key,target,status,last_error,created_at,updated_at) VALUES ('post:2','x','cancelled','Cancelled by user',?,?)",
        )
        .run(now, now);
      expect(publicationConsistencyReport(backendDb).targetMismatches).toEqual([]);

      // A target this queue did deliver is still compared to its job.
      backendDb.sqlite
        .query("INSERT INTO publication_targets(publication_key,target,status,updated_at) VALUES ('post:2','telegram','published',?)")
        .run(now);
      backendDb.sqlite
        .query("INSERT INTO publish_jobs(publication_key,target,status,created_at,updated_at) VALUES ('post:2','telegram','cancelled',?,?)")
        .run(now, now);
      expect(publicationConsistencyReport(backendDb).targetMismatches).toMatchObject([{ publication_key: "post:2", target: "telegram" }]);
    } finally {
      backendDb.close();
    }
  });

  it("scopes publication repair without deleting unrelated orphan rows", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.sqlite.query("INSERT INTO metric_schedule(publication_key,target,updated_at) VALUES ('post:orphan','telegram',?)").run(now);
      for (const postId of [1, 2]) {
        seedTextPost(backendDb, { postId, status: "failed", now });
        backendDb.sqlite
          .query("INSERT INTO publication_targets(publication_key,target,status,error,updated_at) VALUES (?,'telegram','failed','stale',?)")
          .run(`post:${postId}`, now);
        backendDb.sqlite
          .query("INSERT INTO publish_jobs(publication_key,target,status,created_at,updated_at) VALUES (?,'telegram','published',?,?)")
          .run(`post:${postId}`, now, now);
      }

      expect(repairPublicationConsistency(backendDb, { ref: "post:1" })).toMatchObject({
        deletedOrphans: 0,
        repairedTargets: 1,
        repairedPublications: 1,
      });
      expect(backendDb.sqlite.query("SELECT count(*) AS count FROM metric_schedule WHERE publication_key='post:orphan'").get()).toEqual({
        count: 1,
      });
      expect(backendDb.sqlite.query("SELECT status FROM publication_targets WHERE publication_key='post:1'").get()).toEqual({
        status: "published",
      });
      expect(backendDb.sqlite.query("SELECT status FROM publication_targets WHERE publication_key='post:2'").get()).toEqual({
        status: "failed",
      });
    } finally {
      backendDb.close();
    }
  });
  it("leaves a publication open while a locale still has no date", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      // RU went out; EN is an enabled target the operator has not dated yet, so
      // the publication is deliberately still scheduled. The channels are
      // registered because only a target this Studio still publishes to can
      // hold a publication open.
      for (const target of ["telegram", "threads_en"])
        backendDb.channels.upsert(
          {
            id: target,
            platform: target,
            locale: target === "telegram" ? "ru" : "en",
            provider: "native",
            providerAccountId: null,
            targetId: target,
            label: target,
            enabled: 1,
            source: "test",
          },
          now,
        );
      seedTextPost(backendDb, {
        postId: 70,
        status: "scheduled",
        targets: { telegram: true, threads_en: true },
        publishMode: "scheduled",
        scheduledAt: now,
        now,
      });
      backendDb.sqlite
        .query(
          "INSERT INTO publish_jobs(publication_key,target,status,created_at,updated_at) VALUES ('post:70','telegram','published',?,?)",
        )
        .run(now, now);

      expect(repairPublicationConsistency(backendDb)).toMatchObject({ repairedPublications: 0 });
      expect(backendDb.sqlite.query("SELECT status FROM drafts WHERE post_id=70").get()).toEqual({ status: "scheduled" });
    } finally {
      backendDb.close();
    }
  });

  it("still repairs a publication whose locales are all settled", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 71, status: "scheduled", now });
      backendDb.sqlite
        .query(
          "INSERT INTO publish_jobs(publication_key,target,status,created_at,updated_at) VALUES ('post:71','telegram','published',?,?)",
        )
        .run(now, now);

      expect(repairPublicationConsistency(backendDb)).toMatchObject({ repairedPublications: 1 });
      expect(backendDb.sqlite.query("SELECT status FROM drafts WHERE post_id=71").get()).toEqual({ status: "published" });
    } finally {
      backendDb.close();
    }
  });
});
