import { type BackendDb, unsafeDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { capabilityReport } from "../observability/capabilities.js";

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

function _commandCenterFingerprint(backendDb: BackendDb): CommandCenterFingerprint {
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
