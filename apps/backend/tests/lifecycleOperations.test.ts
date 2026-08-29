import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { drafts, publicationEvents, publishJobs } from "../src/db/schema.js";
import { type OperationContext, runOperation } from "../src/operations/registry.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig, MSK_STUDIO_PROFILE } from "./helpers/studio-config.js";

let backendDb: UnsafeBackendDb | null = null;
afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

// The subject is a wall clock an operator typed, so the Studio has a zone that
// is not UTC: the same string on two machines used to mean two moments.
const config = loadTestConfig(
  { CONTROLLER_ADMIN_IDS: "42", THREADS_RU_ACCESS_TOKEN: "t".repeat(20), THREADS_RU_USER_ID: "1" },
  MSK_STUDIO_PROFILE,
);

/** Whether the schedule the journalled command claimed to make is really there. */
function scheduleWrote(db: UnsafeBackendDb): boolean {
  return db.db.select({ jobId: publishJobs.jobId }).from(publishJobs).all().length > 0;
}

/** Every command the operations journal has recorded in this database. */
function commandJournal(db: UnsafeBackendDb) {
  return db.db.select().from(publicationEvents).where(eq(publicationEvents.eventType, "operations.command")).all();
}

function context(db: UnsafeBackendDb): OperationContext {
  return { dbPath: ":memory:", config: () => config, db: () => db, fetchImpl: fetch, actorType: "test" };
}

async function draftReadyToPublish(db: UnsafeBackendDb, draftId: number): Promise<void> {
  await runOperation("channel-connect", context(db), { target: "threads_ru", provider: "native" });
  seedTextPost(db, { draftId, postId: null, actorId: 42, status: "draft", targets: { threads_ru: true }, ru: "Готовый черновик" });
}

describe("draft lifecycle operations", () => {
  /** The mutation journal is what says a command ran at all, and it is written
   * from the same `mutates` every surface repeats back to its caller. The flag
   * itself is held honest by the read-only sweep next door; this is the wiring
   * from the flag to the journal. */
  it("journals a mutating command and stays out of the way of a read-only one", async () => {
    backendDb = openBackendDb(":memory:");
    await draftReadyToPublish(backendDb, 31);
    const before = commandJournal(backendDb).length;

    // A read-only command writes nothing and is journalled by neither route.
    await runOperation("guide", context(backendDb), {});
    expect(commandJournal(backendDb)).toHaveLength(before);

    await runOperation("draft-schedule", context(backendDb), { draft: 31, at: "05.09.2026 08:00", apply: true });
    const journalled = commandJournal(backendDb).at(-1);

    expect(journalled?.message).toBe("Operations draft-schedule executed");
    expect(scheduleWrote(backendDb)).toBe(true);
  });

  it("schedules a draft for a wall clock read in the Studio's time zone, then calls it off", async () => {
    backendDb = openBackendDb(":memory:");
    await draftReadyToPublish(backendDb, 21);

    const plan = await runOperation("draft-schedule", context(backendDb), { draft: 21, at: "05.09.2026 08:00" });
    expect(plan).toMatchObject({ applied: false, at: "2026-09-05T05:00:00.000Z" });
    expect(backendDb.db.select({ status: drafts.status }).from(drafts).get()).toEqual({ status: "draft" });

    expect(await runOperation("draft-schedule", context(backendDb), { draft: 21, at: "05.09.2026 08:00", apply: true })).toMatchObject({
      applied: true,
      ru_at: "2026-09-05T05:00:00.000Z",
    });
    expect(backendDb.db.select({ status: publishJobs.status, publishAt: publishJobs.publishAt }).from(publishJobs).get()).toEqual({
      status: "queued",
      publishAt: "2026-09-05T05:00:00.000Z",
    });

    expect(await runOperation("draft-cancel", context(backendDb), { draft: 21, apply: true })).toMatchObject({ applied: true });
    expect(backendDb.db.select({ status: drafts.status }).from(drafts).get()).toEqual({ status: "cancelled" });
    // Nothing is left waiting to be delivered: cancelling takes the queue with it.
    expect(backendDb.db.select({ jobId: publishJobs.jobId }).from(publishJobs).all()).toEqual([]);
  });

  it("publishes a draft that already exists, which the text publish command cannot do", async () => {
    backendDb = openBackendDb(":memory:");
    await draftReadyToPublish(backendDb, 22);

    expect(await runOperation("draft-publish", context(backendDb), { draft: 22 })).toMatchObject({ applied: false, draft_id: 22 });
    expect(backendDb.db.select({ jobId: publishJobs.jobId }).from(publishJobs).all()).toEqual([]);

    const published = (await runOperation("draft-publish", context(backendDb), { draft: 22, apply: true })) as { post_id: number };
    expect(published.post_id).toBeGreaterThan(0);
    expect(backendDb.db.select({ target: publishJobs.target, status: publishJobs.status }).from(publishJobs).all()).toEqual([
      { target: "threads_ru", status: "queued" },
    ]);
  });

  it("refuses a draft that is not there rather than answering about another one", async () => {
    backendDb = openBackendDb(":memory:");
    await expect(runOperation("draft-cancel", context(backendDb), { draft: 999, apply: true })).rejects.toThrow(/draft not found: 999/);
    await expect(runOperation("video-cancel", context(backendDb), { draft: 999, apply: true })).rejects.toThrow(/video draft not found/);
  });
});
