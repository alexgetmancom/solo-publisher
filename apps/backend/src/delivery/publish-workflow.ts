import { and, eq } from "drizzle-orm";
import pLimit from "p-limit";
import { targetRouting } from "../channels/registry.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { publishJobs } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { PUBLISH_HEARTBEAT_INTERVAL_SECONDS } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { withJobHeartbeat } from "../foundation/runtime/job-heartbeat.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { isTargetAuthBlocked } from "../observability/auth-circuit.js";
import { trackUsageAsync } from "../observability/usage.js";
import { mayHaveReachedAudience } from "../publishing/job-policy.js";
import {
  type ClaimedPublishJob,
  claimPublishJob,
  completePublishJob,
  duePublishJobs,
  failPublishJob,
  forcePublishJobVerification,
  PUBLISH_CLAIM_LIMIT,
  recoverStalePublishJobs,
  requirePublishVerification,
} from "../publishing/queue.js";
import { AmbiguousPublicationError, isAmbiguousPublicationError } from "./ambiguous-publication.js";
import { createPlatformPorts } from "./ports/social.js";
import type { DeliveryPorts, DeliveryPublisher } from "./ports.js";

/** Executes Publishing jobs through Delivery adapters without knowing any UI. */
export async function runDeliveryPublishCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  publishers: DeliveryPorts = createPlatformPorts(config, fetch, targetRouting(backendDb)),
): Promise<number> {
  recoverStalePublishJobs(backendDb);
  const candidates = duePublishJobs(backendDb, PUBLISH_CLAIM_LIMIT);
  const claimedByIndex: Array<ClaimedPublishJob | null> = Array.from({ length: candidates.length }, () => null);
  // One lane per target instead of one shared pool: a single global pLimit let a
  // slow/hung target occupy every concurrency slot,
  // so unrelated targets (Telegram, Threads, ...) sat waiting behind it even
  // though they had nothing to do with the stuck call. Each target still runs
  // its own jobs one at a time (platforms are sensitive to bursts anyway), but
  // different targets never block each other.
  const targetLimits = new Map<string, ReturnType<typeof pLimit>>();
  const limitForTarget = (target: string) => {
    let limit = targetLimits.get(target);
    if (!limit) {
      limit = pLimit(1);
      targetLimits.set(target, limit);
    }
    return limit;
  };
  const results = await Promise.allSettled(
    candidates.map((candidate, index) =>
      limitForTarget(candidate.target)(async () => {
        const job = claimPublishJob(backendDb, candidate.jobId);
        if (!job) return;
        claimedByIndex[index] = job;
        const port = publishers[job.target];
        if (!port) {
          try {
            failPublishJob(backendDb, job.jobId, new Error(`unsupported delivery target: ${job.target}`), job.lockId);
          } catch (error) {
            settleUnexpectedFinalization(backendDb, job, error);
          }
          return;
        }
        const adapter = port;
        let result: Awaited<ReturnType<DeliveryPublisher>>;
        try {
          result = await trackUsageAsync(backendDb, "publishing.social.job", async () => {
            const startedAt = Date.now();
            const phases: Record<string, number> = {};
            let success = false;
            let failure: unknown;
            try {
              // A target with several consecutive 401/403s has a dead credential.
              // Skip the provider call entirely instead of repeating the same
              // rejected request, which is exactly the kind of traffic that gets
              // flagged as abuse.
              if (isTargetAuthBlocked(backendDb, job.target)) {
                throw new Error(`auth_circuit_open: ${job.target} has a failing credential, publish paused until it recovers`);
              }
              const delivery = await withJobHeartbeat(
                PUBLISH_HEARTBEAT_INTERVAL_SECONDS,
                () =>
                  unsafeDb(backendDb)
                    .db.update(publishJobs)
                    .set({ lockedAt: new Date().toISOString() })
                    .where(
                      and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "publishing"), eq(publishJobs.lockedBy, job.lockId)),
                    )
                    .run(),
                () =>
                  withinPublishTimeout(config, backendDb, job, async () => {
                    await timedDeliveryPhase(backendDb, job, "validate", phases, () => adapter.validate(job));
                    const prepared = await timedDeliveryPhase(backendDb, job, "prepare", phases, () => adapter.prepare(job));
                    const published = await timedDeliveryPhase(backendDb, job, "provider.publish", phases, () => adapter.publish(prepared));
                    return timedDeliveryPhase(backendDb, job, "provider.verify", phases, () => adapter.verify(job, published), published);
                  }),
              );
              success = true;
              return delivery;
            } catch (error) {
              failure = error;
              throw error;
            } finally {
              log(success ? "info" : "warn", "operation timing", {
                operation: "publishing.social.job",
                jobId: job.jobId,
                target: job.target,
                attempt: job.attemptCount,
                success,
                totalMs: Date.now() - startedAt,
                phases,
                ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
              });
            }
          });
        } catch (error) {
          if (isAmbiguousPublicationError(error)) requirePublishVerification(backendDb, job.jobId, error, job.lockId);
          else failPublishJob(backendDb, job.jobId, error, job.lockId);
          return;
        }
        try {
          completePublishJob(backendDb, job.jobId, result, job.lockId);
        } catch (error) {
          settleUnexpectedFinalization(backendDb, job, error, result);
        }
      }),
    ),
  );
  for (const [index, result] of results.entries()) {
    if (result.status !== "rejected") continue;
    const job = claimedByIndex[index];
    if (!job) continue;
    const error = `worker finalization failed: ${String(result.reason instanceof Error ? result.reason.message : result.reason)}`;
    log("error", "publish job finalization failed", { jobId: job.jobId, target: job.target, error });
    try {
      forcePublishJobVerification(backendDb, job.jobId, error, job.lockId);
    } catch (finalizationError) {
      log("error", "publish job emergency settlement failed", { jobId: job.jobId, target: job.target, error: String(finalizationError) });
    }
  }
  const jobs = claimedByIndex.filter((job): job is ClaimedPublishJob => job != null);
  // The job already carries the publication's ref. Rebuilding one as `post:{id}`
  // would journal an article's settlement against a post that does not exist.
  for (const publicationKey of new Set(jobs.map((job) => job.publicationKey).filter(Boolean))) {
    try {
      backendDb.events.record({
        ref: publicationKey,
        type: "delivery.publication.settled",
        severity: "info",
        message: `Delivery cycle settled ${publicationKey}`,
        details: { publication_key: publicationKey },
        cooldownSeconds: 10,
      });
    } catch (eventError) {
      // A domain-event write failure here must not stop the loop from settling
      // the rest of this cycle; see the finalization-failure event above, which
      // is defensive for the same reason.
      log("warn", "delivery settlement event journal failed", { publicationKey, error: String(eventError) });
    }
  }
  recordWorkerState(backendDb, "queue", { claimed: jobs.length });
  return jobs.length;
}

function settleUnexpectedFinalization(
  backendDb: BackendDb,
  job: { jobId: number; target: string; lockId: string },
  error: unknown,
  result: Awaited<ReturnType<DeliveryPublisher>> | null = null,
): void {
  const message = `worker finalization failed: ${String(error instanceof Error ? error.message : error)}`;
  log("error", "publish job finalization failed", { jobId: job.jobId, target: job.target, error: message });
  try {
    forcePublishJobVerification(backendDb, job.jobId, message, job.lockId, result);
  } catch (finalizationError) {
    log("error", "publish job emergency settlement failed", {
      jobId: job.jobId,
      target: job.target,
      error: String(finalizationError),
    });
  }
}

type DeliveryPhase = "validate" | "prepare" | "provider.publish" | "provider.verify";

async function timedDeliveryPhase<T>(
  backendDb: BackendDb,
  job: { jobId: number; publicationKey: string; target: string; attemptCount: number; lockId: string },
  phase: DeliveryPhase,
  timings: Record<string, number>,
  work: () => Promise<T>,
  providerResult?: unknown,
): Promise<T> {
  const startedAt = Date.now();
  const timingKey =
    phase === "provider.publish"
      ? "publishMs"
      : phase === "provider.verify"
        ? "verifyMs"
        : phase === "validate"
          ? "validateMs"
          : "prepareMs";
  const owned = unsafeDb(backendDb)
    .db.select({ jobId: publishJobs.jobId })
    .from(publishJobs)
    .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "publishing"), eq(publishJobs.lockedBy, job.lockId)))
    .get();
  if (!owned) throw new Error(`delivery_job_no_longer_owned:${job.jobId}`);
  unsafeDb(backendDb)
    .db.update(publishJobs)
    // Fenced by the same lease the check above reads. Without it an expired
    // worker wrote its phase onto the job its successor now holds, and recovery
    // read that phase as "the new worker already called the provider".
    .set({ currentPhase: phase, updatedAt: new Date().toISOString() })
    .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "publishing"), eq(publishJobs.lockedBy, job.lockId)))
    .run();
  try {
    const result = await work();
    const durationMs = Date.now() - startedAt;
    timings[timingKey] = durationMs;
    try {
      backendDb.events.record({
        ref: job.publicationKey,
        target: job.target,
        type: "publish.job.phase",
        severity: "info",
        message: `${job.target} ${phase} completed`,
        details: {
          job_id: job.jobId,
          attempt: job.attemptCount,
          phase,
          status: "completed",
          duration_ms: durationMs,
          provider_request_id: providerRequestId(result) ?? providerRequestId(providerResult),
        },
      });
    } catch (eventError) {
      log("warn", "publish phase event journal failed", { jobId: job.jobId, target: job.target, phase, error: String(eventError) });
    }
    return result;
  } catch (error) {
    timings[timingKey] = Date.now() - startedAt;
    try {
      backendDb.events.record({
        ref: job.publicationKey,
        target: job.target,
        type: "publish.job.phase",
        severity: "error",
        message: `${job.target} ${phase} failed`,
        details: {
          job_id: job.jobId,
          attempt: job.attemptCount,
          phase,
          status: "failed",
          duration_ms: Date.now() - startedAt,
          provider_request_id: providerRequestId(providerResult),
          error: String(error instanceof Error ? error.message : error),
        },
      });
    } catch (eventError) {
      log("warn", "publish phase event journal failed", { jobId: job.jobId, target: job.target, phase, error: String(eventError) });
    }
    throw error;
  }
}

function providerRequestId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const key of ["providerRequestId", "requestId", "request_id", "xRequestId"]) {
    const candidate = row[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  const raw = row.raw;
  return raw && typeof raw === "object" ? providerRequestId(raw) : null;
}

/**
 * A stuck provider promise must release the queue loop. The delayed provider
 * call releases the worker. Ambiguity is assigned only by the provider adapter
 * around its public mutation; preparation and verification timeouts remain
 * ordinary retryable failures.
 */
async function withinPublishTimeout<T>(
  config: BackendConfig,
  backendDb: BackendDb,
  job: { jobId: number; target: string },
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const phase = unsafeDb(backendDb)
            .db.select({ currentPhase: publishJobs.currentPhase })
            .from(publishJobs)
            .where(eq(publishJobs.jobId, job.jobId))
            .get()?.currentPhase;
          const timeout = new Error(
            `delivery_execution_timeout: ${job.target} exceeded ${config.PUBLISH_JOB_TIMEOUT_SECONDS}s during ${phase ?? "unknown"}`,
          );
          reject(mayHaveReachedAudience(phase) ? new AmbiguousPublicationError(job.target, timeout) : timeout);
        }, config.PUBLISH_JOB_TIMEOUT_SECONDS * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
