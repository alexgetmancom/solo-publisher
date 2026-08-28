import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { publicationEvents, publishJobs } from "../src/db/schema.js";
import { type OperationContext, runOperation } from "../src/operations/registry.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig, SITE_STUDIO_PROFILE } from "./helpers/studio-config.js";

let backendDb: UnsafeBackendDb | null = null;
afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

const config = loadTestConfig(
  { CONTROLLER_ADMIN_IDS: "42", THREADS_RU_ACCESS_TOKEN: "t".repeat(20), THREADS_RU_USER_ID: "1" },
  SITE_STUDIO_PROFILE,
);

function context(db: UnsafeBackendDb): OperationContext {
  return { dbPath: ":memory:", config: () => config, db: () => db, fetchImpl: fetch, actorType: "test" };
}

describe("skip", () => {
  it("finishes a publication without the target that did not land", async () => {
    backendDb = openBackendDb(":memory:");
    await runOperation("channel-connect", context(backendDb), { target: "threads_ru", provider: "native" });
    const { ref } = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Пост, который никуда не доехал",
    })) as { ref: string };
    backendDb.db.update(publishJobs).set({ status: "failed", lastError: "500" }).where(eq(publishJobs.target, "threads_ru")).run();

    // Reports its scope and changes nothing until told to act, like every
    // command that settles a publication.
    expect(await runOperation("skip", context(backendDb), { ref, target: "threads_ru" })).toMatchObject({
      applied: false,
      targets: ["threads_ru"],
    });
    expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).get()).toEqual({ status: "failed" });

    expect(await runOperation("skip", context(backendDb), { ref, target: "threads_ru", apply: true })).toMatchObject({
      applied: true,
      abandoned: 1,
    });
    expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).get()).toEqual({ status: "cancelled" });
    expect(
      backendDb.db
        .select({ type: publicationEvents.eventType })
        .from(publicationEvents)
        .all()
        .map((event) => event.type),
    ).toContain("publish.target.abandoned");
  });

  it("refuses a target that is still being delivered", async () => {
    backendDb = openBackendDb(":memory:");
    await runOperation("channel-connect", context(backendDb), { target: "threads_ru", provider: "native" });
    const { ref } = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Пост в полёте",
    })) as { ref: string };

    expect(await runOperation("skip", context(backendDb), { ref, target: "threads_ru", apply: true })).toMatchObject({
      abandoned: 0,
      results: [{ target: "threads_ru", outcome: "not_abandonable", status: "queued" }],
    });
  });
});
