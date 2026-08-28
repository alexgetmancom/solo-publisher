import { and, desc, eq, gte, lt } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { publishJobs, siteJobs } from "../db/schema.js";
import { PUBLISH_LOCK_TIMEOUT_SECONDS } from "../foundation/config.js";
import { ALERT_COOLDOWN_SECONDS } from "./alerts.js";

/** Records Delivery failures as durable domain events; no alert transport is used here. */
export function recordPublicationFailures(backendDb: BackendDb): void {
  const staleBefore = new Date(Date.now() - PUBLISH_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const stale = unsafeDb(backendDb)
    .db.select()
    .from(publishJobs)
    .where(and(eq(publishJobs.status, "publishing"), lt(publishJobs.lockedAt, staleBefore)))
    .all();
  // Bounded by the same window as the alert cooldown for the reason spelled out
  // below: a failed site job is terminal, so without a cutoff every old failure
  // stays in this result set and produces a fresh alert once per cooldown window
  // forever. Only failures that moved recently are worth reporting.
  const siteFailureWindowStart = new Date(Date.now() - ALERT_COOLDOWN_SECONDS * 1000).toISOString();
  const failedSite = unsafeDb(backendDb)
    .db.select()
    .from(siteJobs)
    .where(and(eq(siteJobs.status, "failed"), gte(siteJobs.updatedAt, siteFailureWindowStart)))
    .orderBy(desc(siteJobs.updatedAt))
    .limit(100)
    .all();
  for (const job of stale)
    backendDb.events.record({
      ref: job.publicationKey,
      type: "queue.stale",
      severity: "error",
      target: job.target,
      message: `Publish job ${job.jobId} exceeded lock timeout`,
      details: { jobId: job.jobId, lockedAt: job.lockedAt },
      cooldownSeconds: ALERT_COOLDOWN_SECONDS,
    });
  // A social job records its own `publish.job.failed` event in the transaction
  // that moves it to the terminal state. Do not rediscover terminal jobs here:
  // that would turn one failed publication into a new Telegram alert every
  // cooldown window forever.
  for (const job of failedSite)
    backendDb.events.record({
      ref: job.publicationKey,
      type: "site.build.failed",
      severity: "error",
      target: "site",
      message: job.lastError ?? `Site job ${job.jobId} failed`,
      details: { jobId: job.jobId, reason: job.reason },
      cooldownSeconds: ALERT_COOLDOWN_SECONDS,
    });
}
