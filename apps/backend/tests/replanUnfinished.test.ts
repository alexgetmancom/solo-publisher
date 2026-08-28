import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { publicationTargets, publishJobs } from "../src/db/schema.js";
import { type OperationContext, runOperation } from "../src/operations/registry.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", THREADS_RU_ACCESS_TOKEN: "t".repeat(20), THREADS_RU_USER_ID: "1" });

/** Editing a post replans its delivery: every unstarted job is dropped and
 * planned again from the draft. A publication that got part of the way out sits
 * in exactly the states that replan replaces, and the job it replaces is the
 * only place the ids already published are kept -- so the edit used to hand the
 * worker a fresh job that published the live part a second time. */
describe("replanning a publication that is half delivered", () => {
  it("leaves the unfinished target on the job that knows what it already published", () =>
    withDb(async (backendDb) => {
      const context: OperationContext = {
        dbPath: ":memory:",
        config: () => config,
        db: () => backendDb,
        fetchImpl: fetch,
        actorType: "test",
      };
      await runOperation("channel-connect", context, { target: "threads_ru", provider: "native" });
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 12,
        postId: 1200,
        actorId: 42,
        status: "scheduled",
        targets: { threads_ru: true },
        ru: "Часть один",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        publishMode: "scheduled",
        now,
      });
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:1200",
          target: "threads_ru",
          status: "queued",
          payloadJson: { text: "Часть один", _threadsPublishedIds: ["18027986108896341"] },
          attemptCount: 2,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:1200", target: "threads_ru", status: "queued", externalId: "18027986108896341", updatedAt: now })
        .run();
      const jobId = backendDb.db.select({ jobId: publishJobs.jobId }).from(publishJobs).get()?.jobId;

      createStudioServices(backendDb, config).posts.approveThreadsChain(42, 12);

      const jobs = backendDb.db
        .select({ jobId: publishJobs.jobId, status: publishJobs.status, payloadJson: publishJobs.payloadJson })
        .from(publishJobs)
        .where(eq(publishJobs.publicationKey, "post:1200"))
        .all();
      // One job, the same one, still carrying the message that is live.
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.jobId).toBe(jobId as number);
      expect(jobs[0]?.payloadJson).toMatchObject({ _threadsPublishedIds: ["18027986108896341"] });
    }));
});
