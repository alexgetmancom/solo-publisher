import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { postLocales, siteJobs } from "../src/db/schema.js";
import { materializeSitePosts, recoverStaleSiteJobs, runSiteJobCycle } from "../src/delivery/site-jobs.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

let backendDb: UnsafeBackendDb | null = null;
let tempDir: string | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("site jobs", () => {
  it("ends stale lock recovery when the retry budget is exhausted", () => {
    backendDb = openBackendDb(":memory:");
    const lockedAt = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    backendDb.db
      .insert(siteJobs)
      .values({
        publicationKey: "post:11",
        reason: "publish",
        status: "rendering",
        attemptCount: 4,
        lockedBy: "dead-worker",
        lockedAt,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    expect(recoverStaleSiteJobs(backendDb, 1)).toBe(1);
    expect(backendDb.db.select().from(siteJobs).get()).toMatchObject({
      status: "failed",
      attemptCount: 5,
      nextAttemptAt: null,
      lockedBy: null,
      lockedAt: null,
      lastError: "stale site lock recovered",
    });
  });

  it("persists materialized media in the public read model", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const config = loadTestConfig({ DATA_DIR: tempDir });
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    seedTextPost(backendDb, { postId: 1, messageId: 11, ru: "RU", en: "EN", siteRu: true, siteEn: true, slugRu: "ru", slugEn: "en", now });
    await materializeSitePosts(config, backendDb);
    expect(backendDb.db.select({ locale: postLocales.locale, media: postLocales.siteMediaJson }).from(postLocales).all()).toEqual([
      { locale: "ru", media: [] },
      { locale: "en", media: [] },
    ]);
  });

  it("claims and completes queued site jobs", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const config = loadTestConfig({ DATA_DIR: tempDir });
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    backendDb.db
      .insert(siteJobs)
      .values({ publicationKey: "post:1", reason: "publish", status: "queued", createdAt: now, updatedAt: now })
      .run();

    expect(await runSiteJobCycle(config, backendDb)).toBe(1);
    const job = backendDb.db.select({ status: siteJobs.status }).from(siteJobs).get();
    if (!job) throw new Error("expected site job");
    expect(job.status).toBe("published");
  });

  it("publishes the EN site job while a later RU site job remains queued", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const config = loadTestConfig({ DATA_DIR: tempDir });
    backendDb = openBackendDb(":memory:");
    const now = new Date(Date.now() - 1_000).toISOString();
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    seedTextPost(backendDb, { postId: 7, ru: "RU", en: "EN", siteRu: true, siteEn: true, scheduledAt: later, scheduledEnAt: now, now });
    backendDb.db
      .insert(siteJobs)
      .values([
        { publicationKey: "post:7", reason: "site_en", status: "queued", nextAttemptAt: now, createdAt: now, updatedAt: now },
        {
          publicationKey: "post:7",
          reason: "site_ru",
          status: "queued",
          nextAttemptAt: later,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    expect(await runSiteJobCycle(config, backendDb)).toBe(1);
    expect(backendDb.db.select({ reason: siteJobs.reason, status: siteJobs.status }).from(siteJobs).orderBy(siteJobs.reason).all()).toEqual(
      [
        { reason: "site_en", status: "published" },
        { reason: "site_ru", status: "queued" },
      ],
    );
  });

  it("does not re-materialize a locale after its site target was cancelled", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const config = loadTestConfig({ DATA_DIR: tempDir });
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    seedTextPost(backendDb, {
      postId: 7,
      ru: "RU",
      en: "EN",
      siteRu: true,
      siteEn: true,
      siteMediaRu: [{ type: "image", path: "keep.jpg" }],
      scheduledAt: now,
      scheduledEnAt: now,
      now,
    });
    backendDb.db
      .insert(siteJobs)
      .values({
        publicationKey: "post:7",
        reason: "site_ru",
        status: "cancelled",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    backendDb.db
      .insert(siteJobs)
      .values({
        publicationKey: "post:7",
        reason: "site_en",
        status: "published",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await materializeSitePosts(config, backendDb);
    expect(backendDb.db.select({ locale: postLocales.locale, media: postLocales.siteMediaJson }).from(postLocales).all()).toEqual([
      { locale: "ru", media: [{ type: "image", path: "keep.jpg" }] },
      { locale: "en", media: [] },
    ]);
  });

  it("fails only the publication that could not render, not the batch it was claimed with", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const config = loadTestConfig({ DATA_DIR: tempDir });
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    for (const postId of [1, 2]) {
      seedTextPost(backendDb, {
        postId,
        ru: "RU",
        siteRu: true,
        slugRu: `ru-${postId}`,
        mediaRu: postId === 2 ? [{ type: "photo", url: "https://media.invalid/gone.jpg" }] : [],
        now,
      });
      backendDb.db
        .insert(siteJobs)
        .values({
          publicationKey: `post:${postId}`,
          reason: "site_ru",
          status: "queued",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("media host is unreachable"))) as unknown as typeof fetch;
    try {
      await runSiteJobCycle(config, backendDb);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(
      backendDb.db
        .select({ publicationKey: siteJobs.publicationKey, status: siteJobs.status, attemptCount: siteJobs.attemptCount })
        .from(siteJobs)
        .all(),
    ).toEqual([
      { publicationKey: "post:1", status: "published", attemptCount: 0 },
      { publicationKey: "post:2", status: "queued", attemptCount: 1 },
    ]);
  });
});
