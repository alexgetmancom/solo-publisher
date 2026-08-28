import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { registerChannel } from "../src/channels/registry.js";
import {
  credentialChecks,
  drafts,
  publicationEvents,
  publicationTargets,
  publishJobs,
  siteJobs,
  videoJobs,
  videoTargets,
} from "../src/db/schema.js";
import { RECONCILE_MAX_ATTEMPTS, runPublicationReconciliation } from "../src/delivery/publication-reconciliation.js";
import { newDeliveryPayload } from "../src/publishing/delivery-payload.js";
import { refreshPublicationStatus } from "../src/publishing/publication-status.js";
import { enqueuePublishJobTx } from "../src/publishing/queue.js";
import { replaceVideoTargets } from "../src/publishing/video-service.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoDraft } from "./helpers/video.js";

describe("publication reconciliation", () => {
  it("emits one completion event for an earlier locale while a later locale waits", () =>
    withDb((backendDb) => {
      const now = new Date("2026-08-05T21:32:13.000Z");
      const later = new Date("2026-08-06T07:00:00.000Z");
      seedTextPost(backendDb, {
        postId: 90,
        actorId: 42,
        status: "scheduled",
        targets: { telegram: true, site_ru: true, threads_en: true, site_en: true },
        ru: "RU",
        en: "EN",
        publishMode: "scheduled",
        scheduledAt: later.toISOString(),
        scheduledEnAt: now.toISOString(),
        now: now.toISOString(),
      });
      backendDb.db
        .insert(publishJobs)
        .values([
          {
            publicationKey: "post:90",
            target: "threads_en",
            status: "published",
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
          {
            publicationKey: "post:90",
            target: "telegram",
            status: "queued",
            publishAt: later.toISOString(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        ])
        .run();
      backendDb.db
        .insert(siteJobs)
        .values([
          {
            publicationKey: "post:90",
            messageId: 90,
            reason: "site_en",
            status: "published",
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
          {
            publicationKey: "post:90",
            messageId: 90,
            reason: "site_ru",
            status: "queued",
            nextAttemptAt: later.toISOString(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        ])
        .run();

      refreshPublicationStatus(backendDb, 90);
      refreshPublicationStatus(backendDb, 90);

      const events = backendDb.db.select().from(publicationEvents).all();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: "delivery.post.locale.completed", target: "en" });
      expect(JSON.parse(events[0]?.detailsJson ?? "{}")).toMatchObject({
        locale: "en",
        published: 2,
        remaining: [{ locale: "ru", scheduled_at: later.toISOString() }],
      });
    }));

  it("emits one aggregate when social and site targets are terminal", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        postId: 91,
        actorId: 42,
        status: "scheduled",
        targets: { telegram_ru: true, site_en: true },
        ru: "Terminal post",
        now,
      });
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:91",
          target: "telegram_ru",
          status: "failed",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(siteJobs)
        .values({ publicationKey: "post:91", messageId: 91, reason: "site_en", status: "published", createdAt: now, updatedAt: now })
        .run();

      refreshPublicationStatus(backendDb, 91);
      expect(backendDb.db.select({ eventType: publicationEvents.eventType }).from(publicationEvents).all()).toHaveLength(1);
      expect(backendDb.db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, 91)).get()).toEqual({ status: "failed" });

      refreshPublicationStatus(backendDb, 91);
      expect(backendDb.db.select({ eventType: publicationEvents.eventType }).from(publicationEvents).all()).toHaveLength(1);
    }));

  it("announces the completion again once a retried target lands", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        postId: 92,
        actorId: 42,
        status: "scheduled",
        targets: { telegram_ru: true, instagram_stories: true },
        ru: "Retried post",
        now,
      });
      backendDb.db
        .insert(publishJobs)
        .values([
          {
            publicationKey: "post:92",
            target: "telegram_ru",
            status: "published",
            createdAt: now,
            updatedAt: now,
          },
          {
            publicationKey: "post:92",
            target: "instagram_stories",
            status: "failed",
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run();

      refreshPublicationStatus(backendDb, 92);
      expect(completionEvents(backendDb)).toHaveLength(1);

      // The operator hits retry and the story lands minutes later: the second
      // completion is a different outcome, not a duplicate of the first.
      backendDb.db
        .update(publishJobs)
        .set({ status: "published" })
        .where(and(eq(publishJobs.publicationKey, "post:92"), eq(publishJobs.target, "instagram_stories")))
        .run();
      refreshPublicationStatus(backendDb, 92);

      const events = completionEvents(backendDb);
      expect(events).toHaveLength(2);
      expect(JSON.parse(events[1]?.detailsJson ?? "{}")).toMatchObject({ published: 2, failed: 0 });
      expect(backendDb.db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, 92)).get()).toEqual({ status: "published" });
    }));

  it("settles a publication that already has durable provider evidence", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey: "post:81",
        target: "threads_ru",
        payload: newDeliveryPayload({ text: "published" }),
      });
      const now = new Date().toISOString();
      // One attempt short of the budget, so this cycle is the one that exhausts it.
      backendDb.db
        .update(publishJobs)
        .set({ status: "verification_required", reconcileAttemptCount: RECONCILE_MAX_ATTEMPTS - 1, updatedAt: now })
        .where(eq(publishJobs.jobId, jobId))
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:81",
          target: "threads_ru",
          status: "verification_required",
          externalId: "thread-81",
          updatedAt: now,
        })
        .run();

      const fetchImpl = (async () =>
        new Response(JSON.stringify({ id: "thread-81", permalink: "https://www.threads.net/@owner/post/81" }), {
          status: 200,
        })) as unknown as typeof fetch;
      expect(await runPublicationReconciliation(backendDb, loadTestConfig({ THREADS_RU_ACCESS_TOKEN: "token" }), fetchImpl)).toMatchObject({
        checked: 1,
        resolved: 1,
        unresolved: 0,
      });
      expect(
        backendDb.db
          .select({
            status: publicationTargets.status,
            confirmationSource: publicationTargets.confirmationSource,
          })
          .from(publicationTargets)
          .where(and(eq(publicationTargets.publicationKey, "post:81"), eq(publicationTargets.target, "threads_ru")))
          .get(),
      ).toEqual({ status: "published", confirmationSource: "provider_verify" });
    }));

  it("reconciles a Zernio Threads target through Zernio rather than treating its provider id as a Threads id", () =>
    withDb(async (backendDb) => {
      registerChannel(backendDb, {
        platform: "threads",
        locale: "ru",
        provider: "zernio",
        providerAccountId: "account-82",
        targetId: "threads_ru",
      });
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey: "post:82",
        target: "threads_ru",
        payload: newDeliveryPayload({ text: "published through Zernio" }),
      });
      const now = new Date().toISOString();
      backendDb.db.update(publishJobs).set({ status: "verification_required", updatedAt: now }).where(eq(publishJobs.jobId, jobId)).run();
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:82",
          target: "threads_ru",
          status: "verification_required",
          externalId: "zernio-82",
          rawJson: JSON.stringify({ ok: true, providerPostId: "zernio-82" }),
          updatedAt: now,
        })
        .run();

      const requests: string[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            _id: "zernio-82",
            platforms: [{ platform: "threads", platformPostId: "thread-82", platformPostUrl: "https://threads.net/post/82" }],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
      const config = Object.assign(loadTestConfig({}), { ZERNIO_API_KEY: "z".repeat(16) });

      expect(await runPublicationReconciliation(backendDb, config, fetchImpl)).toMatchObject({ checked: 1, resolved: 1 });
      expect(requests).toEqual(["https://zernio.com/api/v1/posts/zernio-82"]);
      expect(
        backendDb.db
          .select({ externalId: publicationTargets.externalId, url: publicationTargets.url })
          .from(publicationTargets)
          .where(and(eq(publicationTargets.publicationKey, "post:82"), eq(publicationTargets.target, "threads_ru")))
          .get(),
      ).toEqual({ externalId: "thread-82", url: "https://threads.net/post/82" });
    }));

  it("polls a job that already spent its publish attempts", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey: "post:83",
        target: "threads_ru",
        payload: newDeliveryPayload({ text: "retried before it turned ambiguous" }),
      });
      const now = new Date().toISOString();
      const config = loadTestConfig({ PUBLISH_MAX_ATTEMPTS: "3", THREADS_RU_ACCESS_TOKEN: "token" });
      backendDb.db
        .update(publishJobs)
        // Two failed publishes, then a lost confirmation: the publish budget is
        // nearly gone but nothing has ever asked the provider what happened.
        .set({ status: "verification_required", attemptCount: 3, updatedAt: now })
        .where(eq(publishJobs.jobId, jobId))
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:83",
          target: "threads_ru",
          status: "verification_required",
          externalId: "thread-83",
          updatedAt: now,
        })
        .run();

      const fetchImpl = (async () =>
        new Response(JSON.stringify({ id: "thread-83", permalink: "https://www.threads.net/@owner/post/83" }), {
          status: 200,
        })) as unknown as typeof fetch;
      expect(await runPublicationReconciliation(backendDb, config, fetchImpl)).toMatchObject({ checked: 1, resolved: 1 });
      expect(
        backendDb.db
          .select({ status: publicationTargets.status })
          .from(publicationTargets)
          .where(and(eq(publicationTargets.publicationKey, "post:83"), eq(publicationTargets.target, "threads_ru")))
          .get(),
      ).toEqual({ status: "published" });
    }));

  it("counts provider auth failures found during reconciliation", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey: "post:84",
        target: "threads_ru",
        payload: newDeliveryPayload({ text: "unknown outcome" }),
      });
      const now = new Date().toISOString();
      // One attempt short of the budget, so this cycle is the one that exhausts it.
      backendDb.db
        .update(publishJobs)
        .set({ status: "verification_required", reconcileAttemptCount: RECONCILE_MAX_ATTEMPTS - 1, updatedAt: now })
        .where(eq(publishJobs.jobId, jobId))
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:84",
          target: "threads_ru",
          status: "verification_required",
          externalId: "thread-84",
          updatedAt: now,
        })
        .run();

      const fetchImpl = (async () => new Response("expired token", { status: 401 })) as unknown as typeof fetch;
      expect(await runPublicationReconciliation(backendDb, loadTestConfig({ THREADS_RU_ACCESS_TOKEN: "token" }), fetchImpl)).toMatchObject({
        checked: 1,
        resolved: 0,
        unresolved: 1,
      });
      const check = backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, "threads_ru")).get();
      expect(JSON.parse(check?.detailsJson ?? "{}")).toMatchObject({ authFailureStreak: 1 });
    }));

  it("keeps an id-less result unresolved and emits one owner-visible summary", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey: "post:82",
        target: "telegram",
        payload: newDeliveryPayload({ text: "unknown" }),
      });
      const now = new Date().toISOString();
      // One attempt short of the budget, so this cycle is the one that exhausts it.
      backendDb.db
        .update(publishJobs)
        .set({ status: "verification_required", reconcileAttemptCount: RECONCILE_MAX_ATTEMPTS - 1, updatedAt: now })
        .where(eq(publishJobs.jobId, jobId))
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:82", target: "telegram", status: "verification_required", updatedAt: now })
        .run();

      const config = loadTestConfig();
      expect(await runPublicationReconciliation(backendDb, config)).toMatchObject({ checked: 1, resolved: 0, unresolved: 1 });
      expect(
        backendDb.db
          .select({ reconcileAttemptCount: publishJobs.reconcileAttemptCount, nextAttemptAt: publishJobs.nextAttemptAt })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, jobId))
          .get(),
      ).toEqual({ reconcileAttemptCount: RECONCILE_MAX_ATTEMPTS, nextAttemptAt: null });
      expect(
        backendDb.db
          .select({ eventType: publicationEvents.eventType })
          .from(publicationEvents)
          .where(eq(publicationEvents.eventType, "studio.notification.publication_verification_required"))
          .all(),
      ).toHaveLength(1);
      expect(await runPublicationReconciliation(backendDb, config)).toMatchObject({ checked: 0, unresolved: 1 });
      expect(
        backendDb.db
          .select({ eventType: publicationEvents.eventType })
          .from(publicationEvents)
          .where(eq(publicationEvents.eventType, "studio.notification.publication_verification_required"))
          .all(),
      ).toHaveLength(1);
    }));

  it("restores a recovered YouTube prepare as prepared instead of calling its private upload published", () =>
    withDb(
      async (backendDb) => {
        const { draftId, targetId } = ambiguousYouTubeVideo(backendDb, "prepare");

        expect(await runPublicationReconciliation(backendDb, youtubeConfig(), youtubeFetch("private"))).toMatchObject({
          checked: 1,
          resolved: 1,
        });
        expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, targetId)).get()).toMatchObject({
          status: "prepared",
          externalId: "yt-private",
          publishedAt: null,
        });
        expect(backendDb.db.select().from(videoJobs).where(eq(videoJobs.videoDraftId, draftId)).get()?.status).toBe("completed");
      },
      ["youtube_ru"],
    ));

  it("keeps a recovered YouTube publish unresolved while the upload is still private", () =>
    withDb(
      async (backendDb) => {
        const { targetId } = ambiguousYouTubeVideo(backendDb, "publish");

        expect(await runPublicationReconciliation(backendDb, youtubeConfig(), youtubeFetch("private"))).toMatchObject({
          checked: 1,
          resolved: 0,
          unresolved: 1,
        });
        expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, targetId)).get()?.status).toBe("verification_required");
      },
      ["youtube_ru"],
    ));

  it("confirms a recovered YouTube publish only after YouTube reports it public", () =>
    withDb(
      async (backendDb) => {
        const { targetId } = ambiguousYouTubeVideo(backendDb, "publish");

        expect(await runPublicationReconciliation(backendDb, youtubeConfig(), youtubeFetch("public"))).toMatchObject({
          checked: 1,
          resolved: 1,
        });
        expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, targetId)).get()).toMatchObject({
          status: "published",
          confirmationSource: "provider_verify",
        });
      },
      ["youtube_ru"],
    ));
});

function completionEvents(backendDb: Parameters<Parameters<typeof withDb>[0]>[0]) {
  return backendDb.db.select().from(publicationEvents).where(eq(publicationEvents.eventType, "delivery.post.completed")).all();
}

function ambiguousYouTubeVideo(
  backendDb: Parameters<Parameters<typeof withDb>[0]>[0],
  kind: "prepare" | "publish",
): { draftId: number; targetId: number } {
  const now = new Date().toISOString();
  const draftId = createTestVideoDraft(backendDb, 42, "/tmp/recovered-youtube.mp4", 24);
  replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
  const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
  if (!target) throw new Error("YouTube target was not created");
  backendDb.db
    .update(videoTargets)
    .set({ status: "verification_required", externalId: "yt-private", externalUrl: "https://www.youtube.com/watch?v=yt-private" })
    .where(eq(videoTargets.id, target.id))
    .run();
  backendDb.db
    .insert(videoJobs)
    .values({
      videoDraftId: draftId,
      videoTargetId: target.id,
      kind,
      status: "verification_required",
      runAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { draftId, targetId: target.id };
}

function youtubeConfig() {
  return loadTestConfig({
    YOUTUBE_RU_CLIENT_ID: "client",
    YOUTUBE_RU_CLIENT_SECRET: "secret",
    YOUTUBE_RU_REFRESH_TOKEN: "refresh",
  });
}

function youtubeFetch(privacyStatus: "private" | "public"): typeof fetch {
  return (async (input: string | URL | Request) =>
    String(input).includes("oauth2.googleapis.com/token")
      ? new Response(JSON.stringify({ access_token: "token" }), { status: 200 })
      : new Response(JSON.stringify({ items: [{ id: "yt-private", status: { privacyStatus } }] }), { status: 200 })) as typeof fetch;
}
