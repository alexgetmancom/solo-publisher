import { asc, eq } from "drizzle-orm";
import { parsePublicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import {
  publicationEvents,
  publicationTargets,
  publishJobs,
  videoDrafts,
  videoJobs,
  videoMetricSchedule,
  videoTargets,
} from "../db/schema.js";
import { jsonObject } from "../json.js";

export function publicationTimeline(backendDb: BackendDb, ref: string): Record<string, unknown> {
  const parsed = parsePublicationRef(ref);
  // Video publications carry their own ref, and it is the ref their events are
  // journalled under — an alert about a video is unreadable if the command it
  // names rejects the ref the alert printed.
  if (parsed?.kind === "video") return videoTimeline(backendDb, ref, parsed.id);
  if (parsed?.kind !== "post") throw new Error("--ref must look like post:106 or video:12");
  return postTimeline(backendDb, ref);
}

function postTimeline(backendDb: BackendDb, ref: string): Record<string, unknown> {
  const events = timelineEvents(backendDb, ref);
  const jobs = unsafeDb(backendDb)
    .db.select({
      jobId: publishJobs.jobId,
      target: publishJobs.target,
      status: publishJobs.status,
      attemptCount: publishJobs.attemptCount,
      publishAt: publishJobs.publishAt,
      createdAt: publishJobs.createdAt,
      lockedAt: publishJobs.lockedAt,
      updatedAt: publishJobs.updatedAt,
      lastError: publishJobs.lastError,
    })
    .from(publishJobs)
    .where(eq(publishJobs.publicationKey, ref))
    .orderBy(asc(publishJobs.createdAt), asc(publishJobs.jobId))
    .all()
    .map((job) => ({ ...job, durationMs: elapsed(job.lockedAt ?? job.createdAt, job.updatedAt) }));
  const targets = unsafeDb(backendDb)
    .db.select({
      target: publicationTargets.target,
      status: publicationTargets.status,
      url: publicationTargets.url,
      error: publicationTargets.error,
      publishedAt: publicationTargets.publishedAt,
      updatedAt: publicationTargets.updatedAt,
    })
    .from(publicationTargets)
    .where(eq(publicationTargets.publicationKey, ref))
    .orderBy(publicationTargets.target)
    .all();
  return { ref, jobs, targets, events };
}

function videoTimeline(backendDb: BackendDb, ref: string, videoDraftId: number): Record<string, unknown> {
  const draft = unsafeDb(backendDb).db.select().from(videoDrafts).where(eq(videoDrafts.id, videoDraftId)).get();
  const targets = unsafeDb(backendDb)
    .db.select({
      id: videoTargets.id,
      target: videoTargets.target,
      status: videoTargets.status,
      // What the platform actually judged. Reading it used to mean going
      // through MCP, which is a long way round when the question is "which tag
      // did YouTube refuse".
      metadata: videoTargets.metadataJson,
      deliveryProvider: videoTargets.deliveryProvider,
      providerPostId: videoTargets.providerPostId,
      confirmationSource: videoTargets.confirmationSource,
      externalId: videoTargets.externalId,
      url: videoTargets.externalUrl,
      error: videoTargets.lastError,
      publishedAt: videoTargets.publishedAt,
      verifiedAt: videoTargets.verifiedAt,
      updatedAt: videoTargets.updatedAt,
      // Frozen metric collection is the usual reason a healthy-looking video
      // produces a warning, so the timeline answers it without a second query.
      metricsFrozenAt: videoMetricSchedule.frozenAt,
      metricsCheckpointIndex: videoMetricSchedule.checkpointIndex,
      metricsLastCheckedAt: videoMetricSchedule.lastCheckedAt,
      metricsLastError: videoMetricSchedule.lastError,
    })
    .from(videoTargets)
    .leftJoin(videoMetricSchedule, eq(videoMetricSchedule.videoTargetId, videoTargets.id))
    .where(eq(videoTargets.videoDraftId, videoDraftId))
    .orderBy(videoTargets.target)
    .all();
  const jobs = unsafeDb(backendDb)
    .db.select({
      jobId: videoJobs.id,
      videoTargetId: videoJobs.videoTargetId,
      kind: videoJobs.kind,
      status: videoJobs.status,
      attemptCount: videoJobs.attemptCount,
      runAt: videoJobs.runAt,
      createdAt: videoJobs.createdAt,
      lockedAt: videoJobs.lockedAt,
      updatedAt: videoJobs.updatedAt,
      lastError: videoJobs.lastError,
    })
    .from(videoJobs)
    .where(eq(videoJobs.videoDraftId, videoDraftId))
    .orderBy(asc(videoJobs.createdAt), asc(videoJobs.id))
    .all()
    .map((job) => ({ ...job, durationMs: elapsed(job.lockedAt ?? job.createdAt, job.updatedAt) }));
  return {
    ref,
    draft: draft
      ? { locale: draft.locale, label: draft.label, status: draft.status, scheduledAt: draft.scheduledAt, createdAt: draft.createdAt }
      : null,
    jobs,
    targets,
    events: timelineEvents(backendDb, ref),
  };
}

function timelineEvents(backendDb: BackendDb, ref: string) {
  return unsafeDb(backendDb)
    .db.select()
    .from(publicationEvents)
    .where(eq(publicationEvents.publicationKey, ref))
    .orderBy(asc(publicationEvents.createdAt), asc(publicationEvents.id))
    .all()
    .map((event) => ({
      at: event.createdAt,
      severity: event.severity,
      type: event.eventType,
      target: event.target,
      message: event.message,
      details: jsonObject(event.detailsJson),
    }));
}

function elapsed(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
