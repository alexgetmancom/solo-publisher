import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drafts, publicationEvents, publicationTargets, publishJobs, siteJobs } from "../src/db/schema.js";
import { RETRY_UNLESS_HELD, requeuePublicationTargets } from "../src/publishing/requeue.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("post publication retry", () => {
  it("requeues failed social and site targets and refuses a second retry", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 7,
        postId: 700,
        actorId: 42,
        status: "failed",
        targets: { telegram: true, site_en: true },
        ru: "Retryable post",
        now,
      });
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:700",
          target: "telegram",
          status: "failed",
          payloadJson: { text: "Retryable post" },
          attemptCount: 4,
          lastError: "Telegram timed out",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:700",
          target: "threads_en",
          status: "verification_required",
          payloadJson: { text: "Retryable post" },
          attemptCount: 1,
          lastError: "Threads response was ambiguous",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(siteJobs)
        .values({
          publicationKey: "post:700",
          reason: "site_en",
          status: "verification_required",
          attemptCount: 2,
          lastError: "Site verification expired",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const posts = createStudioServices(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" })).posts;
      expect(backendDb.studioPosts.failedPublicationTargets(700).map((item) => item.target)).toEqual(["threads_en", "telegram", "site_en"]);

      expect(posts.retryTarget(42, 7)).toMatchObject({ requeued: 2, alreadyQueued: 0 });
      expect(
        backendDb.db
          .select({ target: publishJobs.target, status: publishJobs.status, attemptCount: publishJobs.attemptCount })
          .from(publishJobs)
          .all(),
      ).toEqual([
        { target: "telegram", status: "queued", attemptCount: 0 },
        { target: "threads_en", status: "verification_required", attemptCount: 1 },
      ]);
      expect(backendDb.db.select({ status: siteJobs.status, attemptCount: siteJobs.attemptCount }).from(siteJobs).all()).toEqual([
        { status: "queued", attemptCount: 0 },
      ]);
      expect(
        backendDb.db.select({ target: publicationTargets.target, status: publicationTargets.status }).from(publicationTargets).all(),
      ).toEqual([
        { target: "telegram", status: "queued" },
        { target: "site_en", status: "queued" },
      ]);
      expect(() => posts.retryTarget(42, 7)).toThrow("err.retry-only-failed");
    }));

  /** The incident this file exists to prevent a repeat of: a Threads chain whose
   * first message was published and whose reply kept failing was retried, and the
   * retry rebuilt the job from the publication source -- which knows the post and
   * not what already went out -- so the first message was published a second time
   * and the audience read the same post twice. */
  it("carries what a half-published chain already delivered into its retry", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 9,
        postId: 900,
        actorId: 42,
        status: "failed",
        targets: { threads_ru: true },
        ru: "Часть один",
        now,
      });
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:900",
          target: "threads_ru",
          status: "failed",
          payloadJson: { text: "Часть один", _threadsPublishedIds: ["18027986108896341"] },
          attemptCount: 4,
          lastError: "POST https://graph.threads.net/v1.0/me/threads failed: 500",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:900",
          target: "threads_ru",
          status: "failed",
          externalId: "18027986108896341",
          updatedAt: now,
        })
        .run();

      const posts = createStudioServices(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" })).posts;
      expect(posts.retryTarget(42, 9, "threads_ru")).toMatchObject({ requeued: 1 });

      const job = backendDb.db.select({ status: publishJobs.status, payloadJson: publishJobs.payloadJson }).from(publishJobs).all().at(0);
      expect(job?.status).toBe("queued");
      // Both halves: the text is rebuilt from the source, the delivered ids are
      // not, and the adapter needs them together to write only the reply.
      expect(job?.payloadJson).toMatchObject({ text: "Часть один", _threadsPublishedIds: ["18027986108896341"] });
      // The row still names the live first message: this delivery is being
      // finished, not replaced, and an id cleared here would be an orphan.
      expect(
        backendDb.db
          .select({ status: publicationTargets.status, externalId: publicationTargets.externalId })
          .from(publicationTargets)
          .all(),
      ).toEqual([{ status: "queued", externalId: "18027986108896341" }]);
      expect(
        backendDb.db
          .select({ type: publicationEvents.eventType })
          .from(publicationEvents)
          .all()
          .map((event) => event.type),
      ).not.toContain("publish.target.identity_dropped");
    }));

  it("refuses to send a target again when it named a live post and left nothing to continue from", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 10,
        postId: 1000,
        actorId: 42,
        status: "failed",
        targets: { threads_ru: true },
        ru: "Уже в ленте",
        now,
      });
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:1000",
          target: "threads_ru",
          status: "failed",
          payloadJson: { text: "Уже в ленте" },
          attemptCount: 4,
          lastError: "POST https://graph.threads.net/v1.0/me/threads failed: 500",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:1000",
          target: "threads_ru",
          status: "failed",
          externalId: "18027986108896341",
          updatedAt: now,
        })
        .run();

      const posts = createStudioServices(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" })).posts;
      expect(() => posts.retryTarget(42, 10, "threads_ru")).toThrow("err.retry-already-delivered");
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).all()).toEqual([{ status: "failed" }]);
    }));

  /** The mirror image of the same mistake: an operator whose posts are gone is
   * republishing, and continuing a chain onto a message that was deleted writes
   * the remainder onto nothing. */
  it("carries nothing forward when the caller is republishing", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 13,
        postId: 1300,
        actorId: 42,
        status: "failed",
        targets: { threads_ru: true },
        ru: "Снесённая цепочка",
        now,
      });
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:1300",
          target: "threads_ru",
          status: "failed",
          payloadJson: { text: "Снесённая цепочка", _threadsPublishedIds: ["18027986108896341"] },
          attemptCount: 4,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      requeuePublicationTargets(backendDb, { postId: 1300, publicationKey: "post:1300" }, ["threads_ru"], {
        from: RETRY_UNLESS_HELD,
        audienceReached: "republish",
        source: () => backendDb.studioPosts.publicationSource(1300),
      });

      const payload = backendDb.db
        .select({ payloadJson: publishJobs.payloadJson })
        .from(publishJobs)
        .where(eq(publishJobs.publicationKey, "post:1300"))
        .get()?.payloadJson;
      expect(payload).toMatchObject({ text: "Снесённая цепочка" });
      expect(payload).not.toHaveProperty("_threadsPublishedIds");
    }));

  it("journals the live post it stops referencing, whatever status the target reached", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 11,
        postId: 1100,
        actorId: 42,
        status: "failed",
        targets: { threads_ru: true },
        ru: "Забытый id",
        now,
      });
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:1100",
          target: "threads_ru",
          status: "failed",
          externalId: "18027986108896341",
          url: "https://www.threads.com/@marux_play/post/Dcla1FJDezj",
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:1100",
          target: "threads_ru",
          status: "failed",
          payloadJson: { text: "Забытый id" },
          attemptCount: 4,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      requeuePublicationTargets(backendDb, { postId: 1100, publicationKey: "post:1100" }, ["threads_ru"], {
        from: RETRY_UNLESS_HELD,
        audienceReached: "republish",
        source: () => backendDb.studioPosts.publicationSource(1100),
      });

      const journalled = backendDb.db
        .select({ type: publicationEvents.eventType, details: publicationEvents.detailsJson })
        .from(publicationEvents)
        .all()
        .filter((event) => event.type === "publish.target.identity_dropped");
      expect(journalled).toHaveLength(1);
      expect(JSON.parse(String(journalled[0]?.details))).toMatchObject({ external_id: "18027986108896341" });
    }));

  it("abandons a target the operator skips and settles the publication without it", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 8,
        postId: 800,
        actorId: 42,
        status: "failed",
        targets: { telegram: true, threads_ru: true },
        ru: "Skippable post",
        now,
      });
      for (const job of [
        { target: "telegram", status: "published", lastError: null },
        { target: "threads_ru", status: "failed", lastError: "Threads is unreachable" },
      ])
        backendDb.db
          .insert(publishJobs)
          .values({
            publicationKey: "post:800",
            target: job.target,
            status: job.status,
            payloadJson: { text: "Skippable post" },
            attemptCount: 4,
            lastError: job.lastError,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      backendDb.db
        .insert(publicationTargets)
        .values([
          { publicationKey: "post:800", target: "telegram", status: "published", updatedAt: now },
          { publicationKey: "post:800", target: "threads_ru", status: "failed", updatedAt: now },
        ])
        .run();

      const posts = createStudioServices(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" })).posts;
      expect(posts.skipTarget(42, 8, "threads_ru")).toMatchObject({ abandoned: 1 });

      expect(backendDb.db.select({ target: publishJobs.target, status: publishJobs.status }).from(publishJobs).all()).toEqual([
        { target: "telegram", status: "published" },
        { target: "threads_ru", status: "cancelled" },
      ]);
      expect(
        backendDb.db.select({ target: publicationTargets.target, status: publicationTargets.status }).from(publicationTargets).all(),
      ).toEqual([
        { target: "telegram", status: "published" },
        { target: "threads_ru", status: "cancelled" },
      ]);
      // The publication no longer holds the draft in the attention list.
      expect(backendDb.db.select({ status: drafts.status }).from(drafts).all()).toEqual([{ status: "published" }]);
      expect(backendDb.actionableIssues.list().filter((issue) => issue.publicationKey === "post:800")).toEqual([]);
      expect(
        backendDb.db.select({ type: publicationEvents.eventType, target: publicationEvents.target }).from(publicationEvents).all(),
      ).toContainEqual({
        type: "publish.target.abandoned",
        target: "threads_ru",
      });
      expect(() => posts.skipTarget(42, 8, "threads_ru")).toThrow("err.skip-only-failed");
    }));
});
