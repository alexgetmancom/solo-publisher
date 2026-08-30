import { describe, expect, it } from "bun:test";
import { asc, count, eq } from "drizzle-orm";
import { drafts, publicationEvents, publicationTargets, publishJobs, siteJobs } from "../src/db/schema.js";
import { runOperationCommand } from "../src/operations/commands.js";
import { newDeliveryPayload } from "../src/publishing/delivery-payload.js";
import { enqueuePublishJobTx } from "../src/publishing/queue.js";
import { postService } from "../src/studio/services/posts.js";
import { registerTestChannels } from "./helpers/channels.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("command center actions", () => {
  it("rebuilds retried jobs from the source using the target locale", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const source = newDeliveryPayload({});
      seedTextPost(backendDb, {
        postId: 52,
        messageId: 492,
        ru: "Русский текст",
        en: "English text",
        mediaRu: [{ type: "photo", file_id: "ru-photo" }],
        mediaEn: [{ type: "photo", file_id: "en-photo" }],
        slugRu: "russian",
        slugEn: "english",
        now,
      });

      for (const target of ["threads_ru", "threads_en"]) {
        const id = enqueuePublishJobTx(backendDb.db, {
          publicationKey: "post:52",
          target,
          payload: source,
        });
        backendDb.db.update(publishJobs).set({ status: "failed" }).where(eq(publishJobs.jobId, id)).run();
        await runOperationCommand(backendDb, {
          action: "retry",
          apply: true,
          ref: "post:52",
          target,
        });
      }

      const jobs = backendDb.db
        .select({
          target: publishJobs.target,
          payloadJson: publishJobs.payloadJson,
        })
        .from(publishJobs)
        .where(eq(publishJobs.publicationKey, "post:52"))
        .orderBy(asc(publishJobs.target))
        .all();
      const payloads = Object.fromEntries(jobs.map((job) => [job.target, job.payloadJson ?? {}]));
      expect(payloads.threads_ru).toMatchObject({
        locale: "ru",
        text: "Русский текст",
        media: [{ type: "IMAGE", fileId: "ru-photo" }],
      });
      expect(payloads.threads_en).toMatchObject({
        locale: "en",
        text: "English text",
        media: [{ type: "IMAGE", fileId: "en-photo" }],
      });
      expect(backendDb.db.select({ count: count() }).from(publishJobs).where(eq(publishJobs.publicationKey, "post:52")).get()?.count).toBe(
        2,
      );
    }));

  it("does not edit unsupported English targets", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 8, ru: "RU", en: "EN", now });
      backendDb.db
        .insert(publicationTargets)
        .values([{ publicationKey: "post:8", target: "threads_en", status: "published", externalId: "en-post", updatedAt: now }])
        .run();
      const requests: Array<{ url: string; body: string }> = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const result = await runOperationCommand(
        backendDb,
        { action: "edit", ref: "post:8", locale: "en", text: "Updated EN", apply: true },
        loadTestConfig({}),
        fetchImpl,
      );

      expect(requests).toEqual([]);
      // Reported as an explicit skip, not silence: the caller must be able to
      // tell "there is no edit port for this platform" from "the edit landed".
      expect(result.external).toEqual([{ target: "threads_en", ok: false, skipped: true, error: "no_edit_port_for_target" }]);
    }));

  it("deletes a selected locale target and queues its replacement", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const source = newDeliveryPayload({ text_ru: "RU", text_en: "EN", media: [], media_en: [] });
      seedTextPost(backendDb, { postId: 9, ru: "RU", en: "EN", now });
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey: "post:9",
        target: "threads_en",
        payload: source,
      });
      backendDb.db.update(publishJobs).set({ status: "published" }).where(eq(publishJobs.jobId, jobId)).run();
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:9", target: "threads_en", status: "published", externalId: "page_post", updatedAt: now })
        .run();
      const requests: Array<{ url: string; method: string }> = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), method: init?.method ?? "GET" });
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      const result = await runOperationCommand(
        backendDb,
        { action: "delete", ref: "post:9", locale: "en", republish: true, apply: true },
        loadTestConfig({ THREADS_EN_ACCESS_TOKEN: "token" }),
        fetchImpl,
      );
      expect(requests).toEqual([{ url: "https://graph.threads.net/v1.0/page_post?access_token=token", method: "DELETE" }]);
      expect(result.removed).toEqual([{ target: "threads_en", ok: true, deleted: 1 }]);
      expect(backendDb.db.select().from(publicationTargets).where(eq(publicationTargets.target, "threads_en")).get()?.status).toBe(
        "queued",
      );
    }));

  it("does not requeue a newer target when deletion loses its external-id fence", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const source = newDeliveryPayload({ text_ru: "RU", text_en: "EN", media: [], media_en: [] });
      seedTextPost(backendDb, { postId: 19, ru: "RU", en: "EN", now });
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey: "post:19",
        target: "threads_en",
        payload: source,
      });
      backendDb.db.update(publishJobs).set({ status: "published" }).where(eq(publishJobs.jobId, jobId)).run();
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:19", target: "threads_en", status: "published", externalId: "old-post", updatedAt: now })
        .run();
      const fetchImpl = (async () => {
        backendDb.db
          .update(publicationTargets)
          .set({ externalId: "new-post", updatedAt: new Date().toISOString() })
          .where(eq(publicationTargets.target, "threads_en"))
          .run();
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const result = await runOperationCommand(
        backendDb,
        { action: "delete", ref: "post:19", target: "threads_en", republish: true, apply: true },
        loadTestConfig({ THREADS_EN_ACCESS_TOKEN: "token" }),
        fetchImpl,
      );

      expect(result.removed).toEqual([
        {
          target: "threads_en",
          ok: false,
          stale: true,
          deleted: 1,
          remaining: 0,
          error: "target changed while remote deletion was in flight",
        },
      ]);
      expect(result.republish).toEqual({ ok: false, results: [] });
      expect(backendDb.db.select().from(publicationTargets).where(eq(publicationTargets.target, "threads_en")).get()).toMatchObject({
        status: "published",
        externalId: "new-post",
      });
      expect(backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get()?.status).toBe("published");
    }));

  it("marks a deleted target's delivery job cancelled when it stays down", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const source = newDeliveryPayload({ text_ru: "RU", text_en: "EN", media: [], media_en: [] });
      seedTextPost(backendDb, { postId: 21, ru: "RU", en: "EN", now });
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey: "post:21",
        target: "threads_en",
        payload: source,
      });
      backendDb.db.update(publishJobs).set({ status: "published" }).where(eq(publishJobs.jobId, jobId)).run();
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:21", target: "threads_en", status: "published", externalId: "post-21", updatedAt: now })
        .run();

      await runOperationCommand(
        backendDb,
        { action: "delete", ref: "post:21", target: "threads_en", apply: true },
        loadTestConfig({ THREADS_EN_ACCESS_TOKEN: "token" }),
        (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      );

      expect(backendDb.db.select().from(publicationTargets).where(eq(publicationTargets.target, "threads_en")).get()?.status).toBe(
        "deleted",
      );
      expect(backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get()?.status).toBe("cancelled");
      expect(backendDb.db.select().from(publicationEvents).where(eq(publicationEvents.eventType, "operations.command")).all()).toHaveLength(
        1,
      );
    }));

  it("rolls back a requeue when its audit record cannot be written", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 20, ru: "RU", en: "EN", now });
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey: "post:20",
        target: "threads_en",
        payload: newDeliveryPayload({ text: "RU", text_en: "EN" }),
      });
      backendDb.db.update(publishJobs).set({ status: "failed", lastError: "boom" }).where(eq(publishJobs.jobId, jobId)).run();
      backendDb.sqlite.exec(
        "CREATE TRIGGER reject_ops_audit BEFORE INSERT ON publication_events WHEN NEW.event_type = 'operations.command' BEGIN SELECT RAISE(ABORT, 'audit failed'); END",
      );

      expect(runOperationCommand(backendDb, { action: "retry", ref: "post:20", target: "threads_en", apply: true })).rejects.toThrow(
        "audit failed",
      );
      expect(backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get()).toMatchObject({
        status: "failed",
        lastError: "boom",
      });
      expect(backendDb.db.select().from(drafts).where(eq(drafts.postId, 20)).get()?.status).toBe("published");
      expect(backendDb.db.select().from(publicationEvents).where(eq(publicationEvents.eventType, "operations.command")).all()).toEqual([]);
    }));

  it("reports the scope and touches nothing until the caller applies it", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 9, ru: "RU", en: "EN", now });
      backendDb.db
        .insert(publicationTargets)
        .values([
          {
            publicationKey: "post:9",
            target: "threads_en",
            status: "published",
            externalId: "page_post",
            url: "https://t/1",
            updatedAt: now,
          },
          { publicationKey: "post:9", target: "threads_ru", status: "published", externalId: "ru_post", updatedAt: now },
        ])
        .run();
      const requests: string[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        requests.push(String(input));
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const plan = await runOperationCommand(
        backendDb,
        { action: "delete", ref: "post:9", locale: "en", republish: true },
        loadTestConfig({ THREADS_EN_ACCESS_TOKEN: "token" }),
        fetchImpl,
      );

      expect(plan.applied).toBe(false);
      expect(plan.targets).toEqual([{ target: "threads_en", status: "published", url: "https://t/1", published: true }]);
      expect(requests).toEqual([]);
      expect(backendDb.db.select().from(publicationTargets).where(eq(publicationTargets.target, "threads_en")).get()?.status).toBe(
        "published",
      );
    }));

  /** A string is what an HTML form and a JSON body both send, and "false" read
   * as truthy would arm the gate the caller spelled out to keep shut. */
  it("does not read the string false as an armed apply", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 9, ru: "RU", now });

      const plan = await runOperationCommand(backendDb, { action: "retry", ref: "post:9", apply: "false" });

      expect(plan.applied).toBe(false);
    }));

  it("refreshes only the requested site locale without queuing social targets", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 10, now });
      const result = await runOperationCommand(backendDb, { action: "refresh_site", ref: "post:10", locale: "en" });
      expect(result).toMatchObject({ ok: true, post_id: 10, locale: "en", site_refresh: true });
      await runOperationCommand(backendDb, { action: "refresh_site", ref: "post:10", locale: "en" });
      expect(backendDb.db.select().from(siteJobs).get()).toMatchObject({
        publicationKey: "post:10",
        reason: "refresh_en_site",
        status: "queued",
      });
      expect(backendDb.db.select({ count: count() }).from(siteJobs).get()?.count).toBe(1);
      expect(backendDb.db.select().from(publishJobs).all()).toHaveLength(0);
    }));

  it("reschedules a Studio post by locale through the operations command", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
      const posts = postService(backendDb, config);
      registerTestChannels(backendDb, ["telegram", "threads_en"]);
      const draftId = posts.create(42, { text: "RU", textEn: "EN", entities: [], media: [] });
      const initialAt = new Date(Date.now() + 60 * 60_000);
      const postId = posts.schedule(42, draftId, { ruAt: initialAt, enAt: initialAt });
      const nextAt = new Date(Date.now() + 2 * 60 * 60_000);

      const result = await runOperationCommand(
        backendDb,
        { action: "reschedule", ref: `post:${postId}`, schedule_locale: "ru", at: nextAt.toISOString() },
        config,
      );

      expect(result).toMatchObject({ ok: true, action: "reschedule", draft_id: draftId, post_id: postId, locale: "ru" });
      expect(result.ru_at).toBe(nextAt.toISOString());
      expect(result.en_at).toBe(initialAt.toISOString());
    }));
  it("refuses to requeue a target a worker is still publishing", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 61, ru: "RU", en: "EN", now });
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey: "post:61",
        target: "threads_en",
        payload: newDeliveryPayload({ text: "RU", text_en: "EN" }),
      });
      // Mid-flight: a worker holds the lock and has already reached the provider.
      backendDb.db
        .update(publishJobs)
        .set({ status: "publishing", lockedBy: "worker-1", lockedAt: now, currentPhase: "provider.publish" })
        .where(eq(publishJobs.jobId, jobId))
        .run();

      const result = await runOperationCommand(backendDb, { action: "retry", ref: "post:61", target: "threads_en", apply: true });

      expect(result).toMatchObject({ ok: false, results: [{ target: "threads_en", outcome: "not_retryable", status: "publishing" }] });
      // Untouched: stealing the lock would make the worker discard a publication
      // that already went out, and the next claim would send it again.
      const job = backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
      expect(job).toMatchObject({ status: "publishing", lockedBy: "worker-1" });
    }));

  it("clears the previous attempt's phase when it requeues a failed target", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 62, ru: "RU", en: "EN", now });
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey: "post:62",
        target: "threads_en",
        payload: newDeliveryPayload({ text: "RU", text_en: "EN" }),
      });
      backendDb.db
        .update(publishJobs)
        .set({ status: "failed", currentPhase: "provider.publish", lastError: "boom" })
        .where(eq(publishJobs.jobId, jobId))
        .run();

      await runOperationCommand(backendDb, { action: "retry", ref: "post:62", target: "threads_en", apply: true });

      // A leftover phase would make recoverStalePublishJobs treat the next lost
      // lock as "the provider may already have run" and demand manual verification.
      const job = backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
      expect(job).toMatchObject({ status: "queued", currentPhase: null, lastError: null, lockedBy: null });
    }));
  it("requeues a site target through its render job, not as a publish job", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 90, ru: "RU", en: "EN", now });
      backendDb.db
        .insert(siteJobs)
        .values({
          publicationKey: "post:90",
          messageId: 90,
          reason: "site_ru",
          status: "failed",
          attemptCount: 2,
          lastError: "render boom",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:90", target: "site_ru", status: "failed", error: "render boom", skipped: 0, updatedAt: now })
        .run();

      const result = await runOperationCommand(backendDb, { action: "retry", ref: "post:90", target: "site_ru", apply: true });

      expect(result).toMatchObject({ ok: true, results: [{ target: "site_ru", outcome: "requeued" }] });
      expect(backendDb.db.select().from(siteJobs).get()).toMatchObject({ status: "queued", attemptCount: 0, lastError: null });
      // No publisher serves "site_ru": a publish job for it would be failed as an
      // unsupported target while the site itself was never re-rendered.
      expect(backendDb.db.select().from(publishJobs).all()).toEqual([]);
    }));

  it("routes site and social targets apart when republishing a whole locale", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 91, ru: "RU", en: "EN", now });
      backendDb.db
        .insert(siteJobs)
        .values({
          publicationKey: "post:91",
          messageId: 91,
          reason: "site_ru",
          status: "published",
          attemptCount: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      for (const target of ["telegram", "site_ru"])
        backendDb.db
          .insert(publicationTargets)
          .values({ publicationKey: "post:91", target, status: "published", skipped: 0, updatedAt: now })
          .run();

      await runOperationCommand(backendDb, { action: "retry", ref: "post:91", locale: "ru", apply: true });

      expect(
        backendDb.db
          .select()
          .from(publishJobs)
          .all()
          .map((job) => job.target),
      ).toEqual(["telegram"]);
      expect(backendDb.db.select().from(siteJobs).get()).toMatchObject({ status: "queued" });
    }));
  it("rejects an unknown target before it becomes a durable job", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 92, ru: "RU", en: "EN", now });

      expect(runOperationCommand(backendDb, { action: "retry", ref: "post:92", target: "threds_en" })).rejects.toThrow(
        "unknown target: threds_en",
      );
      // Nothing durable was written on the way to the rejection.
      expect(backendDb.db.select().from(publishJobs).all()).toEqual([]);
    }));
});
