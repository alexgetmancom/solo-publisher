import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { credentialChecks, drafts, postLocales, publicationEvents, publicationTargets, publishJobs } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { capabilityReport } from "../observability/capabilities.js";
import { recentPostMetrics } from "./read-model.js";

export function commandCenterPayload(config: BackendConfig, backendDb: BackendDb) {
  const queue = unsafeDb(backendDb)
    .db.select({ status: publishJobs.status, count: sql<number>`count(*)` })
    .from(publishJobs)
    .groupBy(publishJobs.status)
    .orderBy(asc(publishJobs.status))
    .all();
  const targets = unsafeDb(backendDb)
    .db.select({
      target: publicationTargets.target,
      status: publicationTargets.status,
      count: sql<number>`count(*)`,
    })
    .from(publicationTargets)
    .groupBy(publicationTargets.target, publicationTargets.status)
    .orderBy(asc(publicationTargets.target), asc(publicationTargets.status))
    .all();
  const events = unsafeDb(backendDb)
    .db.select({
      id: publicationEvents.id,
      publicationKey: publicationEvents.publicationKey,
      eventType: publicationEvents.eventType,
      severity: publicationEvents.severity,
      target: publicationEvents.target,
      message: publicationEvents.message,
      createdAt: publicationEvents.createdAt,
      ackedAt: publicationEvents.ackedAt,
    })
    .from(publicationEvents)
    .orderBy(desc(publicationEvents.createdAt), desc(publicationEvents.id))
    .limit(50)
    .all();
  const jobs = unsafeDb(backendDb)
    .db.select({
      jobId: publishJobs.jobId,
      publicationKey: publishJobs.publicationKey,
      target: publishJobs.target,
      status: publishJobs.status,
      attemptCount: publishJobs.attemptCount,
      publishAt: publishJobs.publishAt,
      nextAttemptAt: publishJobs.nextAttemptAt,
      lastError: publishJobs.lastError,
      updatedAt: publishJobs.updatedAt,
    })
    .from(publishJobs)
    .orderBy(desc(publishJobs.updatedAt), desc(publishJobs.jobId))
    .limit(100)
    .all();
  const ru = alias(postLocales, "command_center_ru");
  const draftRows = unsafeDb(backendDb)
    .db.select({
      id: drafts.id,
      status: drafts.status,
      textRu: ru.sourceText,
      scheduledAt: drafts.scheduledAt,
      scheduledEnAt: drafts.scheduledEnAt,
      channelMessageId: drafts.channelMessageId,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .leftJoin(ru, and(eq(ru.draftId, drafts.id), eq(ru.locale, "ru")))
    .orderBy(desc(drafts.updatedAt), desc(drafts.id))
    .limit(50)
    .all();
  const activeCapabilityTargets = new Set(capabilityReport(config, backendDb).map((capability) => capability.target));
  const credentials = unsafeDb(backendDb)
    .db.select({
      target: credentialChecks.target,
      status: credentialChecks.status,
      missingEnvJson: credentialChecks.missingEnvJson,
      lastError: credentialChecks.lastError,
      lastCheckedAt: credentialChecks.lastCheckedAt,
    })
    .from(credentialChecks)
    .orderBy(desc(credentialChecks.lastCheckedAt))
    .all()
    .filter((credential) => activeCapabilityTargets.has(credential.target))
    .slice(0, 100);
  const recentMetrics = recentPostMetrics(backendDb);
  const fingerprint = commandCenterFingerprint(backendDb);
  return {
    generatedAt: new Date().toISOString(),
    // The dashboard only needs current metric issues here. Full post history,
    // samples and provider raw payloads belong to explicit diagnostic operations,
    // not to this always-on operations payload.
    pipeline: { updated_at: fingerprint.pipelineUpdatedAt, metrics: { recent: recentMetrics } },
    queue,
    targets,
    jobs,
    drafts: draftRows,
    credentials,
    events: events.map((event) => ({
      id: event.id,
      publicationKey: event.publicationKey,
      eventType: event.eventType,
      severity: event.severity,
      target: event.target,
      message: event.message,
      createdAt: event.createdAt,
      ackedAt: event.ackedAt,
    })),
    videoRevision: { value: fingerprint.videoRevision },
  };
}

export type CommandCenterAttention = {
  hasActionableIssue: boolean;
  hasCredentialIssue: boolean;
  hasMetricIssue: boolean;
};

/** Small overview-only projection. Full queue and diagnostic rows stay behind their panels. */
export function commandCenterAttention(config: BackendConfig, backendDb: BackendDb): CommandCenterAttention {
  const sqlite = unsafeDb(backendDb).sqlite;
  // Not `publish_jobs.status = 'failed'`: that missed an unverified publication,
  // a terminal site failure, a Story card and every video.
  const actionableIssue = backendDb.actionableIssues.list().length > 0;
  const activeCapabilityTargets = new Set(capabilityReport(config, backendDb).map((capability) => capability.target));
  const targets = [...activeCapabilityTargets];
  const credentialIssue = targets.length
    ? Boolean(
        sqlite
          .prepare(
            `SELECT 1 FROM credential_checks
              WHERE target IN (${targets.map(() => "?").join(",")})
                AND status NOT IN ('ok', 'ready')
              LIMIT 1`,
          )
          .get(...targets),
      )
    : false;
  const metricIssue = Boolean(sqlite.prepare("SELECT 1 FROM post_metrics WHERE error IS NOT NULL AND error <> '' LIMIT 1").get());
  return { hasActionableIssue: actionableIssue, hasCredentialIssue: credentialIssue, hasMetricIssue: metricIssue };
}

type CommandCenterFingerprint = {
  pipelineUpdatedAt: string | null;
  latestJobUpdatedAt: string | null;
  latestEventAt: string | null;
  videoRevision: string | null;
  analyticsRevision: string | null;
  studioRevision: string;
};

export function commandCenterFingerprint(backendDb: BackendDb): CommandCenterFingerprint {
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT
         (SELECT MAX(value) FROM (
           SELECT MAX(updated_at) AS value FROM drafts WHERE post_id IS NOT NULL
           UNION ALL SELECT MAX(updated_at) FROM post_locales
           UNION ALL SELECT MAX(updated_at) FROM publication_targets
           UNION ALL SELECT MAX(sampled_at) FROM post_metrics
           UNION ALL SELECT MAX(sampled_at) FROM metric_samples
           UNION ALL SELECT MAX(updated_at) FROM publish_jobs
           UNION ALL SELECT MAX(updated_at) FROM site_jobs
           UNION ALL SELECT MAX(updated_at) FROM metric_schedule WHERE last_error IS NOT NULL AND last_error <> ''
         )) AS pipelineUpdatedAt,
         (SELECT MAX(updated_at) FROM publish_jobs) AS latestJobUpdatedAt,
         (SELECT MAX(created_at) FROM publication_events) AS latestEventAt,
         (SELECT MAX(value) FROM (
           SELECT MAX(updated_at) AS value FROM video_drafts
           UNION ALL SELECT MAX(sampled_at) FROM video_metric_snapshots
         )) AS videoRevision,
         (SELECT MAX(value) FROM (
           SELECT MAX(last_seen_at) AS value FROM x_activity_items
           UNION ALL SELECT MAX(sampled_at) FROM x_activity_metric_snapshots
           UNION ALL SELECT MAX(sampled_at) FROM creator_profile_snapshots
           UNION ALL SELECT MAX(updated_at) FROM creator_profiles
           UNION ALL SELECT MAX(last_checked_at) FROM credential_checks
         )) AS analyticsRevision,
         (SELECT COALESCE(MAX(updated_at), '') || ':' || COUNT(*) FROM channel_connections)
           || ':' || COALESCE((SELECT updated_at FROM studio_profile WHERE id = 1), '') AS studioRevision`,
    )
    .get() as CommandCenterFingerprint;
}
