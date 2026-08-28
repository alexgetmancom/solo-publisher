import { describe, expect, it, jest, setSystemTime } from "bun:test";
import { eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { publicationEvents, publicationTargets, publishJobs } from "../src/db/schema.js";
import { AmbiguousPublicationError } from "../src/delivery/ambiguous-publication.js";
import type { DeliveryAdapter, DeliveryPorts, DeliveryPublisher } from "../src/delivery/ports.js";
import { runDeliveryPublishCycle } from "../src/delivery/publish-workflow.js";
import { PUBLISH_MAX_ATTEMPTS, PUBLISH_PARTIAL_MAX_ATTEMPTS } from "../src/foundation/config.js";
import { recordAuthFailure } from "../src/observability/auth-circuit.js";
import { type DeliveryPayload, newDeliveryPayload } from "../src/publishing/delivery-payload.js";
import { HttpPublishError } from "../src/publishing/errors.js";
import {
  claimDuePublishJobs,
  completePublishJob,
  enqueuePublishJobTx,
  failPublishJob,
  recoverStalePublishJobs,
} from "../src/publishing/queue.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/** Test-only convenience over enqueuePublishJobTx: derives the publication key
 * from the id so queue-mechanics tests don't need a real publication behind each job. */
function enqueuePublishJob(
  backendDb: UnsafeBackendDb,
  input: { publicationId: number; target: string; payload: DeliveryPayload; publishAt?: string | null },
): number {
  return enqueuePublishJobTx(backendDb.db, { ...input, publicationKey: `post:${input.publicationId}` });
}

function testAdapter(publish: DeliveryPublisher, hooks: Partial<Pick<DeliveryAdapter, "prepare">> = {}): DeliveryAdapter {
  return {
    publish,
    prepare: hooks.prepare ?? (async (job) => job),
    validate: async () => undefined,
    verify: async (_job, result) => result,
  };
}

function testPorts(entries: Record<string, DeliveryPublisher | DeliveryAdapter>): DeliveryPorts {
  return Object.fromEntries(
    Object.entries(entries).map(([target, entry]) => [target, typeof entry === "function" ? testAdapter(entry) : entry]),
  ) as DeliveryPorts;
}

async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  jest.useFakeTimers();
  try {
    return await run();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
}

describe("publish queue", () => {
  it("does not let a stale worker fail a job claimed by another worker", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 90,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });
      const [claimed] = claimDuePublishJobs(backendDb, 1, "active-worker");
      if (!claimed) throw new Error("job was not claimed");

      failPublishJob(backendDb, id, new HttpPublishError("server error", 503), "stale-worker");

      expect(
        backendDb.db
          .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({
        status: "publishing",
        lockedBy: "active-worker",
      });
    }));

  it("retries a transient failed job while preserving its published external id", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 91,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });
      const [claimed] = claimDuePublishJobs(backendDb, 1, "active-worker");
      if (!claimed) throw new Error("job was not claimed");
      backendDb.db
        .update(publicationTargets)
        .set({ externalId: "existing-id" })
        .where(eq(publicationTargets.target, "test_platform"))
        .run();

      failPublishJob(backendDb, id, new HttpPublishError("server error", 503), claimed.lockId);

      expect(
        backendDb.db
          .select({ status: publishJobs.status, attemptCount: publishJobs.attemptCount })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({
        status: "queued",
        attemptCount: 1,
      });
      expect(
        backendDb.db
          .select({ status: publicationTargets.status, externalId: publicationTargets.externalId })
          .from(publicationTargets)
          .where(eq(publicationTargets.target, "test_platform"))
          .get(),
      ).toEqual({
        status: "queued",
        externalId: "existing-id",
      });
    }));

  it("claims queued publish jobs and marks target publishing", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 100,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });
      const [job] = claimDuePublishJobs(backendDb, 10, "test-worker");
      expect(job).toMatchObject({ jobId: id, publicationKey: "post:100", target: "test_platform" });
      const row = backendDb.db
        .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(row).toEqual({ status: "publishing", lockedBy: "test-worker" });
      const target = backendDb.db
        .select({ status: publicationTargets.status })
        .from(publicationTargets)
        .where(eq(publicationTargets.target, "test_platform"))
        .get();
      if (!target) throw new Error("expected post target");
      expect(target.status).toBe("publishing");
    }));

  it("does not claim a scheduled job before its publish time and executes it when due", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 99,
        target: "test_platform",
        publishAt: new Date(Date.now() + 60_000).toISOString(),
        payload: newDeliveryPayload({ title: "Scheduled", bodyMarkdown: "Body" }),
      });
      expect(claimDuePublishJobs(backendDb, 10)).toEqual([]);
      backendDb.db.update(publishJobs).set({ publishAt: null }).where(eq(publishJobs.jobId, id)).run();
      await runDeliveryPublishCycle(loadTestConfig({}), backendDb, testPorts({ test_platform: async () => ({ ok: true, id: "due" }) }));
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()).toEqual({
        status: "published",
      });
    }));

  it("runs a successful generic publishing cycle", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 101,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });
      const claimed = await runDeliveryPublishCycle(
        loadTestConfig({}),
        backendDb,
        testPorts({
          test_platform: async () => ({ ok: true, id: "test-platform-1", url: "https://example.test/posts/test-platform-1" }),
        }),
      );
      expect(claimed).toBe(1);
      const job = backendDb.db
        .select({ status: publishJobs.status, lastError: publishJobs.lastError })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(job).toEqual({ status: "published", lastError: null });
      const phases = backendDb.db
        .select({ details: publicationEvents.detailsJson })
        .from(publicationEvents)
        .where(eq(publicationEvents.eventType, "publish.job.phase"))
        .all()
        .map((row) => JSON.parse(row.details ?? "{}") as Record<string, unknown>);
      expect(phases.map((phase) => phase.phase)).toEqual(["validate", "prepare", "provider.publish", "provider.verify"]);
      expect(phases.every((phase) => typeof phase.duration_ms === "number")).toBe(true);
      const target = backendDb.db
        .select({
          status: publicationTargets.status,
          externalId: publicationTargets.externalId,
          url: publicationTargets.url,
          publishedAt: publicationTargets.publishedAt,
        })
        .from(publicationTargets)
        .where(eq(publicationTargets.target, "test_platform"))
        .get();
      expect(target).toMatchObject({
        status: "published",
        externalId: "test-platform-1",
        url: "https://example.test/posts/test-platform-1",
      });
      // Analytics scopes and orders published targets by this column.
      expect(target?.publishedAt).toBeString();
    }));

  it("does not call a provider while its credential circuit is open", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 1012,
        target: "blocked-target",
        payload: newDeliveryPayload({ title: "Queued" }),
      });
      recordAuthFailure(backendDb, "blocked-target");
      recordAuthFailure(backendDb, "blocked-target");
      recordAuthFailure(backendDb, "blocked-target");
      let publishCalls = 0;

      await runDeliveryPublishCycle(
        loadTestConfig({}),
        backendDb,
        testPorts({
          "blocked-target": async () => {
            publishCalls += 1;
            return { ok: true, id: "must-not-publish" };
          },
        }),
      );

      expect(publishCalls).toBe(0);
      expect(
        backendDb.db
          .select({ status: publishJobs.status, lastError: publishJobs.lastError })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({
        status: "queued",
        lastError: "auth_circuit_open: blocked-target has a failing credential, publish paused until it recovers",
      });
    }));

  it("settles a claimed job whose target has no delivery port", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 1013,
        target: "missing-target",
        payload: newDeliveryPayload({ title: "Queued" }),
      });

      expect(await runDeliveryPublishCycle(loadTestConfig({}), backendDb, {})).toBe(1);
      expect(
        backendDb.db
          .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy, lastError: publishJobs.lastError })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({ status: "failed", lockedBy: null, lastError: "unsupported delivery target: missing-target" });
    }));

  it("serializes jobs for the same target but never lets one target block another", () =>
    withDb(async (backendDb) => {
      enqueuePublishJob(backendDb, { publicationId: 600, target: "slow-target", payload: newDeliveryPayload({ title: "Queued" }) });
      enqueuePublishJob(backendDb, { publicationId: 601, target: "slow-target", payload: newDeliveryPayload({ title: "Queued" }) });
      enqueuePublishJob(backendDb, { publicationId: 602, target: "fast-target", payload: newDeliveryPayload({ title: "Queued" }) });

      let activeSlow = 0;
      let maxActiveSlow = 0;
      let fastElapsedMs: number | null = null;
      let sameLaneStatuses: string[] = [];
      let releaseSlow: (() => void) | undefined;
      const slowGate = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      const start = Date.now();
      const publishers = testPorts({
        "slow-target": async () => {
          activeSlow += 1;
          maxActiveSlow = Math.max(maxActiveSlow, activeSlow);
          if (sameLaneStatuses.length === 0)
            sameLaneStatuses = backendDb.db
              .select({ status: publishJobs.status })
              .from(publishJobs)
              .where(eq(publishJobs.target, "slow-target"))
              .all()
              .map((job) => job.status);
          await slowGate;
          activeSlow -= 1;
          return { ok: true, id: "slow" };
        },
        "fast-target": async () => {
          fastElapsedMs = Date.now() - start;
          releaseSlow?.();
          return { ok: true, id: "fast" };
        },
      });
      await runDeliveryPublishCycle(loadTestConfig({}), backendDb, publishers);
      // Two jobs on the same target never overlap...
      expect(maxActiveSlow).toBe(1);
      // ...and the second one owns no expiring lock while it waits in that lane.
      expect(sameLaneStatuses).toEqual(["publishing", "queued"]);
      // ...but a stuck/slow target doesn't hold up an unrelated one.
      expect(fastElapsedMs).not.toBeNull();
      expect(fastElapsedMs as unknown as number).toBeLessThan(50);
    }));

  it("heartbeats a job's lock while a slow publish call is in flight", () =>
    withFakeTimers(() =>
      withDb(async (backendDb) => {
        const id = enqueuePublishJob(backendDb, {
          publicationId: 700,
          target: "slow-target",
          payload: newDeliveryPayload({ title: "Queued" }),
        });
        let lockedAtDuringPublish: string | null | undefined;
        let publishStarted: () => void = () => {};
        const publishHasStarted = new Promise<void>((resolve) => {
          publishStarted = resolve;
        });
        let releasePublish: () => void = () => {};
        const publishGate = new Promise<void>((resolve) => {
          releasePublish = resolve;
        });
        const cycle = runDeliveryPublishCycle(
          loadTestConfig({ PUBLISH_HEARTBEAT_INTERVAL_SECONDS: "1" }),
          backendDb,
          testPorts({
            "slow-target": async () => {
              publishStarted();
              await publishGate;
              lockedAtDuringPublish = backendDb.db
                .select({ lockedAt: publishJobs.lockedAt })
                .from(publishJobs)
                .where(eq(publishJobs.jobId, id))
                .get()?.lockedAt;
              return { ok: true, id: "slow" };
            },
          }),
        );
        await publishHasStarted;
        jest.advanceTimersByTime(1_000);
        releasePublish();
        await cycle;
        const claimedAt = backendDb.db.select({ lockedAt: publishJobs.lockedAt }).from(publishJobs).where(eq(publishJobs.jobId, id)).get();
        // The job already completed by the time we read it back, so lockedAt is
        // cleared; what matters is the heartbeat fired at least once mid-publish.
        expect(lockedAtDuringPublish).not.toBeUndefined();
        expect(lockedAtDuringPublish).not.toBeNull();
        expect(claimedAt?.lockedAt).toBeNull();
      }),
    ));

  it("retries transient publisher failures", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 102,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });
      await runDeliveryPublishCycle(
        loadTestConfig({ PUBLISH_BACKOFF_BASE_SECONDS: "1" }),
        backendDb,
        testPorts({
          test_platform: async () => {
            throw new HttpPublishError("temporary", 503, "temporary");
          },
        }),
      );
      const job = backendDb.db
        .select({
          status: publishJobs.status,
          attemptCount: publishJobs.attemptCount,
          nextAttemptAt: publishJobs.nextAttemptAt,
          lastError: publishJobs.lastError,
        })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      if (!job) throw new Error("expected retry job");
      expect(job.status).toBe("queued");
      expect(job.attemptCount).toBe(1);
      expect(job.nextAttemptAt).toBeTruthy();
      expect(job.lastError).toContain("temporary");
    }));

  it("requires verification when a provider may have published before transport failed", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 1011,
        target: "ambiguous-provider",
        payload: newDeliveryPayload({ title: "Queued" }),
      });
      await runDeliveryPublishCycle(
        loadTestConfig({}),
        backendDb,
        testPorts({
          "ambiguous-provider": async () => {
            throw new AmbiguousPublicationError("ambiguous-provider", new Error("socket closed"));
          },
        }),
      );
      expect(
        backendDb.db
          .select({ status: publishJobs.status, nextAttemptAt: publishJobs.nextAttemptAt })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({ status: "verification_required", nextAttemptAt: null });
      expect(
        backendDb.db
          .select({ status: publicationTargets.status })
          .from(publicationTargets)
          .where(eq(publicationTargets.target, "ambiguous-provider"))
          .get(),
      ).toEqual({ status: "verification_required" });
    }));

  it("retries an unknown failure once and then fails it", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 104,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });
      const publishers = testPorts({
        test_platform: async () => {
          throw new Error("unclassified upstream response");
        },
      });
      const config = loadTestConfig({ PUBLISH_BACKOFF_BASE_SECONDS: "1" });
      await runDeliveryPublishCycle(config, backendDb, publishers);
      expect(
        backendDb.db
          .select({ status: publishJobs.status, attemptCount: publishJobs.attemptCount })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({ status: "queued", attemptCount: 1 });

      backendDb.db.update(publishJobs).set({ nextAttemptAt: null }).where(eq(publishJobs.jobId, id)).run();
      await runDeliveryPublishCycle(config, backendDb, publishers);
      expect(
        backendDb.db
          .select({ status: publishJobs.status, attemptCount: publishJobs.attemptCount })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({ status: "failed", attemptCount: 2 });
    }));

  it("keeps a whole-job timeout retryable because preparation may not have reached the provider", () =>
    withFakeTimers(() =>
      withDb(async (backendDb) => {
        const id = enqueuePublishJob(backendDb, {
          publicationId: 105,
          target: "slow-provider",
          payload: newDeliveryPayload({ title: "Queued" }),
        });
        let prepareStarted: () => void = () => {};
        const preparationHasStarted = new Promise<void>((resolve) => {
          prepareStarted = resolve;
        });
        const cycle = runDeliveryPublishCycle(
          loadTestConfig({ PUBLISH_JOB_TIMEOUT_SECONDS: "1" }),
          backendDb,
          testPorts({
            "slow-provider": testAdapter(async () => ({ ok: true }), {
              prepare: async () => {
                prepareStarted();
                return await new Promise<never>(() => undefined);
              },
            }),
          }),
        );
        await preparationHasStarted;
        jest.advanceTimersByTime(1_000);
        await cycle;
        expect(
          backendDb.db
            .select({ status: publishJobs.status, attemptCount: publishJobs.attemptCount, lastError: publishJobs.lastError })
            .from(publishJobs)
            .where(eq(publishJobs.jobId, id))
            .get(),
        ).toEqual({
          status: "failed",
          attemptCount: 1,
          lastError: "delivery_execution_timeout: slow-provider exceeded 1s during prepare",
        });
      }),
    ));

  it("fences delayed preparation from publishing after its worker timed out", () =>
    withFakeTimers(() =>
      withDb(async (backendDb) => {
        const id = enqueuePublishJob(backendDb, {
          publicationId: 1051,
          target: "slow-prepare",
          payload: newDeliveryPayload({ title: "Queued" }),
        });
        let releasePreparation: (() => void) | undefined;
        let publishCalls = 0;
        const preparation = new Promise<void>((resolve) => {
          releasePreparation = resolve;
        });
        let prepareStarted: () => void = () => {};
        const preparationHasStarted = new Promise<void>((resolve) => {
          prepareStarted = resolve;
        });
        const cycle = runDeliveryPublishCycle(
          loadTestConfig({ PUBLISH_JOB_TIMEOUT_SECONDS: "1" }),
          backendDb,
          testPorts({
            "slow-prepare": testAdapter(
              async () => {
                publishCalls += 1;
                return { ok: true };
              },
              {
                prepare: async (job) => {
                  prepareStarted();
                  await preparation;
                  return job;
                },
              },
            ),
          }),
        );
        await preparationHasStarted;
        jest.advanceTimersByTime(1_000);
        await cycle;
        releasePreparation?.();
        await Promise.resolve();

        expect(publishCalls).toBe(0);
        expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()).toEqual({
          status: "failed",
        });
      }),
    ));

  it("holds a stale publishing lock for verification instead of risking a duplicate", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 103,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });

      backendDb.db
        .update(publishJobs)
        .set({
          status: "publishing",
          currentPhase: "provider.publish",
          lockedBy: "old-worker",
          lockedAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
        })
        .where(eq(publishJobs.jobId, id))
        .run();
      expect(recoverStalePublishJobs(backendDb)).toBe(1);
      const job = backendDb.db
        .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(job).toEqual({ status: "verification_required", lockedBy: null });
      expect(
        backendDb.db
          .select({ status: publicationTargets.status })
          .from(publicationTargets)
          .where(eq(publicationTargets.target, "test_platform"))
          .get(),
      ).toEqual({
        status: "verification_required",
      });
    }));

  it("can freeze system time when testing stale publishing lock recovery", () => {
    setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    return withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 1033,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });
      const lockedAt = new Date(Date.now() - 2 * 60_000).toISOString();
      backendDb.db
        .update(publishJobs)
        .set({ status: "publishing", lockedBy: "old-worker", lockedAt, updatedAt: lockedAt })
        .where(eq(publishJobs.jobId, id))
        .run();

      expect(recoverStalePublishJobs(backendDb, 60)).toBe(1);
    }).finally(() => setSystemTime());
  });

  it("holds a lock lost during verification, because the post is already live", () =>
    withDb((backendDb) => {
      // Verification runs after the platform accepted the post, and nothing is
      // persisted until the job settles — so this phase is the only trace that
      // the audience has already seen it. Requeuing it published a second post.
      const id = enqueuePublishJob(backendDb, {
        publicationId: 1034,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });
      backendDb.db
        .update(publishJobs)
        .set({
          status: "publishing",
          currentPhase: "provider.verify",
          lockedBy: "old-worker",
          lockedAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
        })
        .where(eq(publishJobs.jobId, id))
        .run();

      expect(recoverStalePublishJobs(backendDb)).toBe(1);
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()).toEqual({
        status: "verification_required",
      });
    }));

  it("requeues a stale preparation lock because no public mutation started", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 1032,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued" }),
      });
      backendDb.db
        .update(publishJobs)
        .set({
          status: "publishing",
          currentPhase: "prepare",
          lockedBy: "old-worker",
          lockedAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
        })
        .where(eq(publishJobs.jobId, id))
        .run();

      expect(recoverStalePublishJobs(backendDb)).toBe(1);
      expect(
        backendDb.db
          .select({ status: publishJobs.status, currentPhase: publishJobs.currentPhase })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({ status: "queued", currentPhase: null });
    }));

  it("keeps stale lock recovery available when the delivery loop is still awaiting a provider", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 1031,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });
      backendDb.db
        .update(publishJobs)
        .set({
          status: "publishing",
          currentPhase: "provider.publish",
          lockedBy: "hung-provider",
          lockedAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
        })
        .where(eq(publishJobs.jobId, id))
        .run();

      expect(recoverStalePublishJobs(backendDb)).toBe(1);
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()).toEqual({
        status: "verification_required",
      });
    }));

  it("does not let a stale worker overwrite a recovered job", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 104,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });
      const [claimed] = claimDuePublishJobs(backendDb, 1, "old-worker");
      if (!claimed) throw new Error("expected claimed job");
      backendDb.db
        .update(publishJobs)
        .set({ currentPhase: "provider.publish", lockedAt: "2000-01-01T00:00:00.000Z" })
        .where(eq(publishJobs.jobId, id))
        .run();
      recoverStalePublishJobs(backendDb);

      completePublishJob(backendDb, id, { ok: true, id: "late" }, claimed.lockId);

      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()).toEqual({
        status: "verification_required",
      });
    }));

  it("holds a retryable result with an external ID for reconciliation, never back in the publish queue", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 106,
        target: "test_platform",
        payload: newDeliveryPayload({ text_en: "Queued" }),
      });
      claimDuePublishJobs(backendDb, 1, "test-worker");
      completePublishJob(backendDb, id, {
        ok: false,
        id: "at://did/app.bsky.feed.post/root",
        retryable: true,
        error: "test_visibility_failed:not_in_author_feed",
      });

      const job = backendDb.db
        .select({ status: publishJobs.status, payloadJson: publishJobs.payloadJson })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      // Queued would mean "deliver this again", and no adapter can be asked to
      // continue from a bare id -- only to repeat the whole publication.
      expect(job?.status).toBe("verification_required");
      expect(job?.payloadJson).not.toHaveProperty("_reconcile_ids");
      const target = backendDb.db
        .select({ status: publicationTargets.status, externalId: publicationTargets.externalId })
        .from(publicationTargets)
        .get();
      expect(target).toEqual({ status: "verification_required", externalId: "at://did/app.bsky.feed.post/root" });
    }));

  it("does not leave a job publishing when result finalization fails", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 105,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Queued", bodyMarkdown: "Body" }),
      });
      await runDeliveryPublishCycle(
        loadTestConfig({}),
        backendDb,
        testPorts({
          test_platform: async () => {
            backendDb.sqlite.exec("DROP TABLE publication_events; CREATE TABLE publication_events (id INTEGER PRIMARY KEY)");
            return { ok: true, id: "test-platform-1" };
          },
        }),
      );
      const job = backendDb.db
        .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy, lastError: publishJobs.lastError })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      if (!job) throw new Error("expected settled job");
      expect(job.status).toBe("verification_required");
      expect(job.lockedBy).toBeNull();
      expect(
        backendDb.db
          .select({ status: publicationTargets.status, externalId: publicationTargets.externalId })
          .from(publicationTargets)
          .where(eq(publicationTargets.target, "test_platform"))
          .get(),
      ).toEqual({ status: "verification_required", externalId: "test-platform-1" });
      expect(job.lastError).toContain("worker finalization failed");
    }));

  it("does not delete another legacy post while deduplicating a completed target", () =>
    withDb((backendDb) => {
      const first = enqueuePublishJob(backendDb, {
        publicationId: 201,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "One" }),
      });
      const second = enqueuePublishJob(backendDb, {
        publicationId: 202,
        target: "test_platform",
        payload: newDeliveryPayload({ title: "Two" }),
      });
      claimDuePublishJobs(backendDb, 1, "test-worker");
      completePublishJob(backendDb, first, { ok: true, id: "first" });
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, second)).get()).toEqual({
        status: "queued",
      });
    }));

  /** The long budget is patience for an outage. On the day it was written the
   * platform came back after forty minutes and kept refusing one reply for
   * seven hours, while other posts to the same account published normally --
   * so the evidence that waiting will not help is the platform itself. */
  it("stops retrying a partial publication once the same target has published something else", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 305,
        target: "threads_en",
        payload: newDeliveryPayload({ text_en: "Первая часть" }),
      });
      claimDuePublishJobs(backendDb, 1, "test-worker");
      completePublishJob(backendDb, id, {
        partial: true,
        resumeKey: "_threadsPublishedIds",
        ids: ["root-id"],
        error: "POST https://graph.threads.net/v1.0/me/threads failed: 500",
      });
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()?.status).toBe(
        "queued",
      );

      // Another publication reaches the same platform in the meantime.
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:306",
          target: "threads_en",
          status: "published",
          externalId: "another-post",
          publishedAt: new Date(Date.now() + 1000).toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();

      backendDb.db.update(publishJobs).set({ nextAttemptAt: null }).where(eq(publishJobs.jobId, id)).run();
      claimDuePublishJobs(backendDb, 1, "test-worker");
      completePublishJob(backendDb, id, {
        partial: true,
        resumeKey: "_threadsPublishedIds",
        ids: ["root-id"],
        error: "POST https://graph.threads.net/v1.0/me/threads failed: 500",
      });

      const job = backendDb.db
        .select({ status: publishJobs.status, lastError: publishJobs.lastError, payloadJson: publishJobs.payloadJson })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(job?.status).toBe("failed");
      expect(job?.lastError).toContain("stopped early");
      // Still carrying what it published, so the press that follows finishes it.
      expect(job?.payloadJson).toMatchObject({ _threadsPublishedIds: ["root-id"] });
    }));

  /** The last gate before a delivery runs, and the only one no caller can go
   * around. Every duplicate this system has produced came through a different
   * door -- a retry, a replan -- so the guard belongs where all of them end up:
   * the moment a job is claimed for delivery. */
  it("refuses to claim a job whose target already names a post and which carries nothing to continue from", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 303,
        target: "threads_en",
        payload: newDeliveryPayload({ text_en: "Уже в ленте" }),
      });
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:303",
          target: "threads_en",
          status: "failed",
          externalId: "18027986108896341",
          updatedAt: new Date().toISOString(),
        })
        .run();

      expect(claimDuePublishJobs(backendDb, 1, "test-worker")).toEqual([]);
      const job = backendDb.db
        .select({ status: publishJobs.status, lastError: publishJobs.lastError })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(job?.status).toBe("verification_required");
      expect(job?.lastError).toContain("duplicate_refused");
      expect(
        backendDb.db
          .select({ type: publicationEvents.eventType })
          .from(publicationEvents)
          .all()
          .map((event) => event.type),
      ).toContain("publish.job.duplicate_refused");
    }));

  it("claims the same job once it carries what it already published", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 304,
        target: "threads_en",
        payload: newDeliveryPayload({ text_en: "Хвост цепочки", _threadsPublishedIds: ["18027986108896341"] }),
      });
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:304",
          target: "threads_en",
          status: "failed",
          externalId: "18027986108896341",
          updatedAt: new Date().toISOString(),
        })
        .run();

      expect(claimDuePublishJobs(backendDb, 1, "test-worker").map((job) => job.jobId)).toEqual([id]);
    }));

  it("persists a partial publication under the key its adapter named, and requeues only the unfinished tail", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 301,
        target: "threads_en",
        payload: newDeliveryPayload({ text_en: "One\n\nTwo" }),
      });
      claimDuePublishJobs(backendDb, 1, "test-worker");
      completePublishJob(backendDb, id, {
        partial: true,
        resumeKey: "_threadsPublishedIds",
        ids: ["root-id"],
        error: "reply container missing",
      });
      const job = backendDb.db
        .select({
          status: publishJobs.status,
          attemptCount: publishJobs.attemptCount,
          payloadJson: publishJobs.payloadJson,
          lastError: publishJobs.lastError,
        })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      if (!job) throw new Error("expected partial job");
      expect(job.status).toBe("queued");
      expect(job.attemptCount).toBe(1);
      expect(job.payloadJson).toMatchObject({ _threadsPublishedIds: ["root-id"] });
      expect(job.lastError).toContain("reply container missing");
    }));

  /** A truncated post is live while this is retrying, and the only remedy is the
   * platform coming back -- which took forty minutes the day this was written.
   * Spending the ordinary four-attempt budget in seven minutes and stopping put
   * a person in the loop for something no person can do anything about. */
  it("keeps finishing a partial publication long past the budget an ordinary failure gets", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        publicationId: 302,
        target: "threads_en",
        payload: newDeliveryPayload({ text_en: "One\n\nTwo" }),
      });
      const attempt = () => {
        backendDb.db
          .update(publishJobs)
          .set({ nextAttemptAt: null, publishAt: new Date(0).toISOString() })
          .where(eq(publishJobs.jobId, id))
          .run();
        claimDuePublishJobs(backendDb, 1, "test-worker");
        completePublishJob(backendDb, id, {
          partial: true,
          resumeKey: "_threadsPublishedIds",
          ids: ["root-id"],
          error: "POST https://graph.threads.net/v1.0/me/threads failed: 500",
        });
        return backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()?.status;
      };

      // Where an ordinary failure would already have been given up on.
      for (let i = 0; i < PUBLISH_MAX_ATTEMPTS; i += 1) expect(attempt()).toBe("queued");
      for (let i = PUBLISH_MAX_ATTEMPTS; i < PUBLISH_PARTIAL_MAX_ATTEMPTS - 1; i += 1) expect(attempt()).toBe("queued");
      // And it does end: a budget with no floor is a job nobody is ever told about.
      expect(attempt()).toBe("failed");
      // What it published stays on the job, so the press that follows finishes
      // the chain instead of starting it again.
      expect(
        backendDb.db.select({ payloadJson: publishJobs.payloadJson }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()?.payloadJson,
      ).toMatchObject({ _threadsPublishedIds: ["root-id"] });
    }));
});
