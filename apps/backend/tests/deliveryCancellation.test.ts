import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { publicationCancellations, publishJobs } from "../src/db/schema.js";
import { cancelRemainingDelivery, pendingDeliveryTargets } from "../src/publishing/cancellation.js";
import { newDeliveryPayload, resumedDeliveryPayload } from "../src/publishing/delivery-payload.js";
import { claimDuePublishJobs, enqueuePublishJobTx } from "../src/publishing/queue.js";
import { withDb } from "./helpers/db.js";

/** A draft with a publication id, which is what ties a cancellation to its jobs. */
function seedPublication(backendDb: Parameters<Parameters<typeof withDb>[0]>[0], draftId: number, postId: number): string {
  backendDb.db.run(
    `insert into drafts (id, actor_id, status, targets_json, post_id, created_at, updated_at)
     values (${draftId}, 42, 'scheduled', '{}', ${postId}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  return `post:${postId}`;
}

describe("cancelling the rest of a publication", () => {
  it("stops a queued target, and the worker refuses to start it afterwards", () =>
    withDb((backendDb) => {
      const publicationKey = seedPublication(backendDb, 1, 1);
      enqueuePublishJobTx(backendDb.db, { publicationKey, target: "telegram", payload: newDeliveryPayload({ text: "hi" }) });

      const report = cancelRemainingDelivery(backendDb, 1, 42);

      expect(report).toEqual({ stopped: ["telegram"], finishing: [] });
      expect(claimDuePublishJobs(backendDb, 10)).toEqual([]);
      expect(backendDb.db.select().from(publishJobs).all()[0]?.status).toBe("cancelled");
    }));

  it("refuses a job that was already queued when the cancellation arrives late", () =>
    withDb((backendDb) => {
      // The tap lands while the job sits in the queue but after the sweep that
      // cancelled it would have run: only the claim's own condition stops this.
      const publicationKey = seedPublication(backendDb, 2, 2);
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationKey,
        target: "threads_ru",
        payload: newDeliveryPayload({ text: "hi" }),
      });
      backendDb.db.insert(publicationCancellations).values({ publicationKey, actorId: 42, requestedAt: "2026-01-01T00:00:00.000Z" }).run();

      expect(claimDuePublishJobs(backendDb, 10)).toEqual([]);
      expect(backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get()?.status).toBe("cancelled");
    }));

  it("finishes a chain that has already published part of itself", () =>
    withDb((backendDb) => {
      const publicationKey = seedPublication(backendDb, 3, 3);
      enqueuePublishJobTx(backendDb.db, {
        publicationKey,
        target: "threads_ru",
        payload: resumedDeliveryPayload({ text: "hi" }, "_threadsPublishedIds", ["17841"]),
      });

      const report = cancelRemainingDelivery(backendDb, 3, 42);

      expect(report).toEqual({ stopped: [], finishing: ["threads_ru"] });
      expect(backendDb.db.select().from(publishJobs).all()[0]?.status).toBe("queued");
      // And the worker still takes it: a severed thread is worse than one more reply.
      expect(claimDuePublishJobs(backendDb, 10).map((job) => job.target)).toEqual(["threads_ru"]);
    }));

  it("names the targets a cancellation would stop before it stops them", () =>
    withDb((backendDb) => {
      const publicationKey = seedPublication(backendDb, 4, 4);
      enqueuePublishJobTx(backendDb.db, { publicationKey, target: "telegram", payload: newDeliveryPayload({ text: "hi" }) });
      enqueuePublishJobTx(backendDb.db, {
        publicationKey,
        target: "threads_en",
        payload: resumedDeliveryPayload({ text: "hi" }, "_threadsPublishedIds", ["1"]),
      });

      expect(pendingDeliveryTargets(backendDb, 4)).toEqual([
        { target: "telegram", started: false },
        { target: "threads_en", started: true },
      ]);
    }));
});
