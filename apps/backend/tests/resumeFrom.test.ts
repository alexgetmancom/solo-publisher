import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { publicationTargets, publishJobs } from "../src/db/schema.js";
import { type OperationContext, runOperation } from "../src/operations/registry.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig, SITE_STUDIO_PROFILE } from "./helpers/studio-config.js";

let backendDb: UnsafeBackendDb | null = null;
afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

const config = loadTestConfig(
  {
    CONTROLLER_ADMIN_IDS: "42",
    THREADS_RU_ACCESS_TOKEN: "t".repeat(20),
    THREADS_RU_USER_ID: "1",
  },
  SITE_STUDIO_PROFILE,
);

function context(db: UnsafeBackendDb): OperationContext {
  return { dbPath: ":memory:", config: () => config, db: () => db, fetchImpl: fetch, actorType: "test" };
}

/** A chain whose first message is live and whose remainder never went out, left
 * naming a post that is no longer the one to continue -- what a duplicate
 * removed by hand leaves behind. */
async function unfinishedChain(db: UnsafeBackendDb, publishedId: string): Promise<string> {
  await runOperation("channel-connect", context(db), { target: "threads_ru", provider: "native" });
  const published = (await runOperation("publish", context(db), {
    locale: "ru",
    targets: "threads_ru",
    text: "Первая часть цепочки, у которой не доехал хвост",
  })) as { ref: string };
  db.db
    .update(publishJobs)
    .set({ status: "failed", payloadJson: { text: "Первая часть", _threadsPublishedIds: [publishedId] }, lastError: "500" })
    .where(eq(publishJobs.target, "threads_ru"))
    .run();
  db.db
    .update(publicationTargets)
    .set({ status: "failed", externalId: publishedId })
    .where(eq(publicationTargets.target, "threads_ru"))
    .run();
  return published.ref;
}

describe("resume-from", () => {
  it("points an unfinished chain at the post that survived and queues the remainder", async () => {
    backendDb = openBackendDb(":memory:");
    const ref = await unfinishedChain(backendDb, "18552473311078221");

    const plan = await runOperation("resume-from", context(backendDb), {
      ref,
      target: "threads_ru",
      external_id: "18027986108896341",
    });
    expect(plan).toMatchObject({ applied: false, resume_key: "_threadsPublishedIds", was: ["18552473311078221"] });
    // Nothing moved without apply: this queues a delivery that writes onto a
    // live post.
    expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).get()).toEqual({ status: "failed" });

    expect(
      await runOperation("resume-from", context(backendDb), { ref, target: "threads_ru", external_id: "18027986108896341", apply: true }),
    ).toMatchObject({ applied: true });

    const job = backendDb.db.select({ status: publishJobs.status, payloadJson: publishJobs.payloadJson }).from(publishJobs).get();
    expect(job?.status).toBe("queued");
    // The text it still has to write is untouched; only the post it attaches to
    // changed.
    expect(job?.payloadJson).toMatchObject({ text: "Первая часть", _threadsPublishedIds: ["18027986108896341"] });
    expect(backendDb.db.select({ externalId: publicationTargets.externalId }).from(publicationTargets).get()).toEqual({
      externalId: "18027986108896341",
    });
  });

  it("refuses a target that has nothing half-published to continue", async () => {
    backendDb = openBackendDb(":memory:");
    await runOperation("channel-connect", context(backendDb), { target: "threads_ru", provider: "native" });
    const published = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Обычный пост в один вызов",
    })) as { ref: string };
    backendDb.db.update(publishJobs).set({ status: "failed", lastError: "500" }).where(eq(publishJobs.target, "threads_ru")).run();

    await expect(
      runOperation("resume-from", context(backendDb), { ref: published.ref, target: "threads_ru", external_id: "18049", apply: true }),
    ).rejects.toThrow(/nothing it has already published/);
  });
});
