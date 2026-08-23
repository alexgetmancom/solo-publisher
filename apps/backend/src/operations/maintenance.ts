import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import { freezeDisabledMetricSchedules } from "../analytics/collection/metric-schedule.js";
import { X_ANALYTICS_SOURCE } from "../analytics/x-activity-linking.js";
import { parsePublicationRef, publicationRef } from "../application/publication-ref.js";
import { registeredPostTargetIds } from "../channels/registry.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import {
  drafts,
  maintenanceLocks,
  metricSchedule,
  publicationEvents,
  publicationTargets,
  videoDrafts,
  videoTargets,
} from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { publicationPlanFromDb } from "../publishing/source-store.js";
import { effectivePublicationStatus } from "../publishing/state.js";

/** Explicitly invoked operational maintenance routines. */
export async function backupDatabase(backendDb: BackendDb, sourcePath: string, destinationDirectory?: string): Promise<string> {
  if (sourcePath === ":memory:") throw new Error("cannot back up an in-memory database");
  const directory = destinationDirectory ?? path.join(path.dirname(sourcePath), "backups");
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const destination = path.join(directory, `${path.basename(sourcePath, path.extname(sourcePath))}-${stamp}.db`);
  await unsafeDb(backendDb).sqlite.backup(destination);
  return destination;
}

export function restoreDatabase(source: string, destination: string, force: boolean): void {
  if (!force) throw new Error("restore requires --force");
  if (!fs.existsSync(source)) throw new Error(`backup does not exist: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${destination}${suffix}`, { force: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
}

type OperationalRetentionResult = {
  publicationEvents: number;
  opsActions: number;
  sitePageviews: number;
  runtimeUsage: number;
  total: number;
};

const RETENTION_BATCH_SIZE = 2_000;
/** How far back `audit` counts journal events. */
const AUDIT_EVENT_WINDOW_DAYS = 30;
const POST_EVENTS_RETENTION_DAYS = 365;
const OPS_ACTIONS_RETENTION_DAYS = 365;
const SITE_PAGEVIEWS_RETENTION_DAYS = 730;
const RUNTIME_USAGE_RETENTION_DAYS = 365;

/** Deletes derived operational history while preserving unresolved alerts. */
export function pruneOperationalHistory(backendDb: BackendDb, now = new Date()): OperationalRetentionResult {
  const cutoff = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const cutoffDay = (days: number) => cutoff(days).slice(0, 10);
  const deleteBatched = (statement: string, ...params: string[]): number => {
    let deleted = 0;
    while (true) {
      const changes = unsafeDb(backendDb)
        .sqlite.prepare(`${statement} LIMIT ${RETENTION_BATCH_SIZE}`)
        .run(...params).changes;
      deleted += changes;
      if (changes < RETENTION_BATCH_SIZE) return deleted;
    }
  };

  const postEventsDeleted = deleteBatched(
    `DELETE FROM publication_events
     WHERE created_at < ?
       AND event_type != 'analytics.milestone.reached'
       AND NOT (severity IN ('warn', 'error') AND acked_at IS NULL)`,
    cutoff(POST_EVENTS_RETENTION_DAYS),
  );
  const opsActionsDeleted = deleteBatched("DELETE FROM ops_actions WHERE created_at < ?", cutoff(OPS_ACTIONS_RETENTION_DAYS));
  const sitePageviewsDeleted = deleteBatched("DELETE FROM site_pageviews WHERE day < ?", cutoffDay(SITE_PAGEVIEWS_RETENTION_DAYS));
  const runtimeUsageDeleted = deleteBatched("DELETE FROM runtime_usage WHERE bucket_day < ?", cutoffDay(RUNTIME_USAGE_RETENTION_DAYS));
  return {
    publicationEvents: postEventsDeleted,
    opsActions: opsActionsDeleted,
    sitePageviews: sitePageviewsDeleted,
    runtimeUsage: runtimeUsageDeleted,
    total: postEventsDeleted + opsActionsDeleted + sitePageviewsDeleted + runtimeUsageDeleted,
  };
}

export function buildMetricsBackfillPlan(
  backendDb: BackendDb,
  options: { targets: string[]; refs?: string[]; dateFrom?: string; dateTo?: string },
): Record<string, unknown>[] {
  if (options.targets.length === 0) return [];
  const conditions = [
    eq(drafts.status, "published"),
    eq(publicationTargets.status, "published"),
    inArray(publicationTargets.target, options.targets),
  ];
  const key = sql<string>`'post:' || ${drafts.postId}`;
  const date = sql<string>`coalesce(${publicationTargets.publishedAt}, ${drafts.updatedAt})`;
  if (options.refs?.length) conditions.push(inArray(key, options.refs));
  if (options.dateFrom) conditions.push(gte(date, options.dateFrom));
  if (options.dateTo) conditions.push(lte(date, options.dateTo));
  return unsafeDb(backendDb)
    .db.select({
      publicationKey: key,
      postId: drafts.postId,
      messageId: drafts.channelMessageId,
      dateUtc: date,
      target: publicationTargets.target,
    })
    .from(drafts)
    .innerJoin(publicationTargets, eq(publicationTargets.publicationKey, key))
    .where(and(...conditions))
    .orderBy(desc(date), publicationTargets.target)
    .all();
}

export function applyMetricsBackfill(
  backendDb: BackendDb,
  config: BackendConfig,
  rows: Record<string, unknown>[],
  resetCounts = false,
): number {
  const now = new Date().toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const row of rows) {
      const publicationKey = typeof row.publicationKey === "string" ? row.publicationKey : "";
      const target = typeof row.target === "string" ? row.target : "";
      if (!publicationKey || !target) continue;
      tx.insert(metricSchedule)
        .values({ publicationKey, target, nextCheckAt: null, checkCount: 0, frozenAt: null, lastError: null, updatedAt: now })
        .onConflictDoUpdate({
          target: [metricSchedule.publicationKey, metricSchedule.target],
          set: { nextCheckAt: null, ...(resetCounts ? { checkCount: 0 } : {}), frozenAt: null, lastError: null, updatedAt: now },
        })
        .run();
    }
  });
  // A backfill must not resurrect targets this Studio has deliberately kept
  // paid-metrics disabled for; follow the same config-driven list the regular
  // metrics cycle uses instead of a hardcoded platform pair.
  freezeDisabledMetricSchedules(backendDb, [...(config.ENABLE_X_METRICS ? [] : ["x"])]);
  return rows.length;
}

export function auditOperations(backendDb: BackendDb, now = new Date()): Record<string, unknown> {
  // The journal keeps a year, and counting all of it made this report read as
  // an archaeology dig: 831 delivery failures, the newest of them five weeks
  // old, next to a pipeline with nothing wrong. The window is what an audit is
  // asking about; the history is still there, and `timeline` reads it per
  // publication.
  const eventsSince = new Date(now.getTime() - AUDIT_EVENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return {
    eventsSince,
    postEventsByType: unsafeDb(backendDb)
      .db.select({
        severity: publicationEvents.severity,
        eventType: publicationEvents.eventType,
        count: sql<number>`count(*)`,
        latest: sql<string | null>`max(${publicationEvents.createdAt})`,
      })
      .from(publicationEvents)
      .where(gte(publicationEvents.createdAt, eventsSince))
      .groupBy(publicationEvents.severity, publicationEvents.eventType)
      .orderBy(publicationEvents.severity, publicationEvents.eventType)
      .all(),
    recentPostEvents: unsafeDb(backendDb)
      .db.select({
        severity: publicationEvents.severity,
        eventType: publicationEvents.eventType,
        target: publicationEvents.target,
        message: publicationEvents.message,
        createdAt: publicationEvents.createdAt,
      })
      .from(publicationEvents)
      .orderBy(desc(publicationEvents.createdAt))
      .limit(20)
      .all(),
    deliveryIssues: unsafeDb(backendDb)
      .sqlite.query(
        `SELECT 'publish_job' AS source,status,target,count(*) AS count,max(updated_at) AS latest
         FROM publish_jobs
         WHERE status IN ('failed','verification_required')
         GROUP BY status,target
         UNION ALL
         SELECT 'post_target' AS source,status,target,count(*) AS count,max(updated_at) AS latest
         FROM publication_targets
         WHERE status IN ('failed','verification_required')
         GROUP BY status,target
         ORDER BY status,source,target`,
      )
      .all(),
    publicationConsistency: publicationConsistencyReport(backendDb),
    metricScheduleErrors: unsafeDb(backendDb)
      .db.select({
        target: metricSchedule.target,
        count: sql<number>`count(*)`,
        latest: sql<string | null>`max(${metricSchedule.updatedAt})`,
      })
      .from(metricSchedule)
      .where(and(isNull(metricSchedule.frozenAt), isNotNull(metricSchedule.lastError), sql`${metricSchedule.lastError} != ''`))
      .groupBy(metricSchedule.target)
      .orderBy(metricSchedule.target)
      .all(),
    // Only actionable delivery failures belong here. Cancelled targets and
    // unfinished/deleted drafts are lifecycle history, not production noise.
    recentVideoFailures: unsafeDb(backendDb)
      .db.select({
        videoDraftId: videoTargets.videoDraftId,
        label: videoDrafts.label,
        target: videoTargets.target,
        status: videoTargets.status,
        lastError: videoTargets.lastError,
        scheduledAt: videoTargets.scheduledAt,
        updatedAt: videoTargets.updatedAt,
      })
      .from(videoTargets)
      .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
      .where(and(eq(videoTargets.status, "failed"), notInArray(videoDrafts.status, ["draft", "editing", "cancelled"])))
      .orderBy(desc(videoTargets.updatedAt))
      .limit(20)
      .all(),
    recentVideoVerificationRequired: unsafeDb(backendDb)
      .db.select({
        videoDraftId: videoTargets.videoDraftId,
        label: videoDrafts.label,
        target: videoTargets.target,
        lastError: videoTargets.lastError,
        providerPostId: videoTargets.providerPostId,
        externalId: videoTargets.externalId,
        scheduledAt: videoTargets.scheduledAt,
        updatedAt: videoTargets.updatedAt,
      })
      .from(videoTargets)
      .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
      .where(and(eq(videoTargets.status, "verification_required"), notInArray(videoDrafts.status, ["draft", "editing", "cancelled"])))
      .orderBy(desc(videoTargets.updatedAt))
      .limit(20)
      .all(),
  };
}

type LatestPublishJob = {
  publication_key: string;
  target: string;
  status: string;
  last_error: string | null;
};

type PublicationConsistencyOptions = { ref?: string };
type PublicationConsistencyScope = { kind: "post"; id: number; publicationKey: string } | { kind: "video"; id: number };
type TargetStateMismatch = LatestPublishJob & { target_status: string; job_status: string };
type PublicationStateMismatch = { post_id: number; status: string; expected: "published" | "failed" | "scheduled" | "cancelled" };
type VideoTargetJobMismatch = {
  video_draft_id: number;
  video_target_id: number;
  target: string;
  target_status: string;
  publish_job_id: number;
  job_status: string;
  last_error: string | null;
  provider_post_id: string | null;
  external_id: string | null;
};
type PublicationConsistencyReport = {
  foreignKeyViolations: Record<string, unknown>[];
  staleTargets: Array<{ publication_key: string; target: string; status: string; error: string | null; updated_at: string }>;
  targetMismatches: TargetStateMismatch[];
  publicationMismatches: PublicationStateMismatch[];
  videoDraftMismatches: Array<{ id: number; status: string; target_statuses: string }>;
  videoTargetJobMismatches: VideoTargetJobMismatch[];
};

function publicationConsistencyScope(ref: string | undefined): PublicationConsistencyScope | null {
  if (!ref) return null;
  const parsed = parsePublicationRef(ref);
  if (!parsed || !["post", "video"].includes(parsed.kind) || parsed.id <= 0) throw new Error("--ref must look like post:1 or video:1");
  return parsed.kind === "post"
    ? { kind: "post", id: parsed.id, publicationKey: publicationRef("post", parsed.id) }
    : { kind: "video", id: parsed.id };
}

export function publicationConsistencyReport(
  backendDb: BackendDb,
  options: PublicationConsistencyOptions = {},
): PublicationConsistencyReport {
  const scope = publicationConsistencyScope(options.ref);
  const foreignKeyViolations = unsafeDb(backendDb).sqlite.query("PRAGMA foreign_key_check").all() as Record<string, unknown>[];
  const staleTargets = (
    unsafeDb(backendDb)
      .sqlite.query(
        `SELECT t.publication_key,t.target,t.status,t.error,t.updated_at
       FROM publication_targets t
       WHERE t.status IN ('queued','publishing')
         AND NOT EXISTS (
           SELECT 1 FROM publish_jobs j
           WHERE j.publication_key=t.publication_key AND j.target=t.target AND j.status IN ('queued','publishing')
       )
       ORDER BY t.updated_at`,
      )
      .all() as PublicationConsistencyReport["staleTargets"]
  ).filter((row) => !scope || (scope.kind === "post" && row.publication_key === scope.publicationKey));
  const targetMismatches = targetStateMismatches(backendDb).filter(
    (row) => !scope || (scope.kind === "post" && row.publication_key === scope.publicationKey),
  );
  const publicationMismatches = publicationStateMismatches(backendDb).filter(
    (row) => !scope || (scope.kind === "post" && row.post_id === scope.id),
  );
  const videoDraftMismatches = (
    unsafeDb(backendDb)
      .sqlite.query(
        `SELECT d.id,d.status,group_concat(t.status) AS target_statuses
       FROM video_drafts d JOIN video_targets t ON t.video_draft_id=d.id
       GROUP BY d.id
       HAVING (d.status='published' AND sum(t.status!='published')>0)
          OR (d.status='partial' AND sum(t.status IN ('failed','cancelled'))=0)
          OR (d.status='scheduled' AND sum(t.status NOT IN ('published','failed','cancelled','verification_required'))=0)
       ORDER BY d.id`,
      )
      .all() as PublicationConsistencyReport["videoDraftMismatches"]
  ).filter((row) => !scope || (scope.kind === "video" && row.id === scope.id));
  const videoTargetJobMismatches = (
    unsafeDb(backendDb)
      .sqlite.query(
        `SELECT t.video_draft_id,t.id AS video_target_id,t.target,t.status AS target_status,
              j.id AS publish_job_id,j.status AS job_status,j.last_error,
              t.provider_post_id,t.external_id
       FROM video_targets t
       JOIN video_jobs j ON j.video_target_id=t.id AND j.kind='publish'
       WHERE (t.status='published' AND j.status NOT IN ('completed','cancelled'))
          OR (t.status='failed' AND j.status='completed')
          -- A target awaiting verification is only ever answered through its
          -- job: the reconciliation sweep joins the two and asks the provider
          -- under the job's fence. A target left waiting without a job in the
          -- same state is invisible to it and waits forever, which is the one
          -- way a publication can go quiet with nobody watching.
          OR (t.status='verification_required' AND j.status<>'verification_required')
       ORDER BY t.video_draft_id,t.id`,
      )
      .all() as VideoTargetJobMismatch[]
  ).filter((row) => !scope || (scope.kind === "video" && row.video_draft_id === scope.id));
  return {
    foreignKeyViolations,
    staleTargets,
    targetMismatches,
    publicationMismatches,
    videoDraftMismatches,
    videoTargetJobMismatches,
  };
}

export function repairPublicationConsistency(backendDb: BackendDb, options: PublicationConsistencyOptions = {}): Record<string, number> {
  const scope = publicationConsistencyScope(options.ref);
  const before = publicationConsistencyReport(backendDb, options);
  const now = new Date().toISOString();
  let deletedOrphans = 0;
  let repairedTargets = 0;
  let repairedPublications = 0;
  let repairedVideoJobs = 0;
  let skippedVideoJobs = 0;
  unsafeDb(backendDb).db.transaction(() => {
    if (!scope) {
      for (const statement of [
        "DELETE FROM social_comments WHERE video_target_id NOT IN (SELECT id FROM video_targets) OR video_target_id IN (SELECT id FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts))",
        "DELETE FROM video_metric_snapshots WHERE video_target_id NOT IN (SELECT id FROM video_targets) OR video_target_id IN (SELECT id FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts))",
        "DELETE FROM video_metric_schedule WHERE video_target_id NOT IN (SELECT id FROM video_targets) OR video_target_id IN (SELECT id FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts))",
        "DELETE FROM video_jobs WHERE video_draft_id NOT IN (SELECT id FROM video_drafts) OR (video_target_id IS NOT NULL AND video_target_id NOT IN (SELECT id FROM video_targets))",
        "DELETE FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts)",
        "DELETE FROM metric_schedule WHERE publication_key LIKE 'post:%' AND publication_key NOT IN (SELECT 'post:' || post_id FROM drafts WHERE post_id IS NOT NULL)",
        "DELETE FROM publication_targets WHERE publication_key LIKE 'post:%' AND publication_key NOT IN (SELECT 'post:' || post_id FROM drafts WHERE post_id IS NOT NULL)",
        "DELETE FROM post_locales WHERE draft_id NOT IN (SELECT id FROM drafts)",
      ])
        deletedOrphans += unsafeDb(backendDb).sqlite.run(statement).changes;
    }

    for (const mismatch of before.targetMismatches) {
      const normalized = normalizeArchivedJobStatus(mismatch.job_status);
      const error = normalized === "failed" ? mismatch.last_error : null;
      const changed = unsafeDb(backendDb)
        .sqlite.query(
          `UPDATE publication_targets
           SET status=?, error=?, skipped=?, updated_at=?
           WHERE publication_key=? AND target=? AND status=?`,
        )
        .run(
          normalized,
          error,
          normalized === "skipped" || normalized === "cancelled" ? 1 : 0,
          now,
          mismatch.publication_key,
          mismatch.target,
          mismatch.target_status,
        ).changes;
      repairedTargets += changed;
    }

    for (const mismatch of before.publicationMismatches) {
      const changed = unsafeDb(backendDb)
        .sqlite.query("UPDATE drafts SET status=?, updated_at=? WHERE post_id=? AND status=?")
        .run(mismatch.expected, now, mismatch.post_id, mismatch.status).changes;
      if (!changed) continue;
      repairedPublications += changed;
    }

    if (scope?.kind === "video") {
      for (const mismatch of before.videoTargetJobMismatches) {
        if (mismatch.target_status !== "published" || (!mismatch.provider_post_id && !mismatch.external_id)) {
          skippedVideoJobs += 1;
          continue;
        }
        const changed = unsafeDb(backendDb)
          .sqlite.query(
            "UPDATE video_jobs SET status='completed', last_error=NULL, locked_at=NULL, locked_by=NULL, updated_at=? WHERE id=? AND status=?",
          )
          .run(now, mismatch.publish_job_id, mismatch.job_status).changes;
        if (!changed) continue;
        unsafeDb(backendDb)
          .sqlite.query("UPDATE video_targets SET last_error=NULL, updated_at=? WHERE id=? AND status='published'")
          .run(now, mismatch.video_target_id);
        repairedVideoJobs += changed;
      }
    }
  });
  return {
    foreignKeyViolations: before.foreignKeyViolations.length,
    deletedOrphans,
    repairedTargets,
    repairedPublications,
    repairedVideoJobs,
    skippedVideoJobs,
  };
}

function targetStateMismatches(backendDb: BackendDb): TargetStateMismatch[] {
  const rows = unsafeDb(backendDb)
    .sqlite.query(
      `WITH latest AS (
         SELECT p.publication_key,p.target,p.status,p.last_error
         FROM publish_jobs p
         JOIN (
           SELECT publication_key,target,max(job_id) AS job_id
           FROM publish_jobs WHERE publication_key IS NOT NULL GROUP BY publication_key,target
         ) x ON x.job_id=p.job_id
       )
       SELECT t.publication_key,t.target,t.status AS target_status,l.status AS job_status,l.last_error
       FROM publication_targets t JOIN latest l ON l.publication_key=t.publication_key AND l.target=t.target
       WHERE t.target NOT IN ('site_ru','site_en')
         -- A target attached from an analytics export was never delivered by
         -- this queue: the post exists on the platform, and whatever its old
         -- job settled as says nothing about it. Comparing the two reported two
         -- live X posts as inconsistent for a month, and repairing them would
         -- have marked the live posts cancelled.
         AND coalesce(json_extract(t.raw_json,'$.source'),'') <> '${X_ANALYTICS_SOURCE}'
       ORDER BY t.publication_key,t.target`,
    )
    .all() as TargetStateMismatch[];
  return rows.filter((row) => row.target_status !== normalizeArchivedJobStatus(row.job_status));
}

function publicationStateMismatches(backendDb: BackendDb): PublicationStateMismatch[] {
  const rows = unsafeDb(backendDb)
    .sqlite.query(
      `SELECT d.post_id,d.status,
              group_concat(x.status) AS statuses
       FROM drafts d
       LEFT JOIN (
         SELECT publication_key,status FROM publish_jobs
         UNION ALL
         SELECT publication_key,status FROM site_jobs
       ) x ON x.publication_key='post:'||d.post_id
       WHERE d.post_id IS NOT NULL
       GROUP BY d.post_id
       ORDER BY d.post_id`,
    )
    .all() as Array<{
    post_id: number;
    status: string;
    statuses: string | null;
  }>;
  const registeredTargets = registeredPostTargetIds(backendDb);
  return rows.flatMap((row) => {
    if (row.status === "cancelled") return [];
    const expected = effectivePublicationStatus(
      (row.statuses ?? "").split(",").filter(Boolean).map(normalizeArchivedJobStatus),
      publicationPlanFromDb(unsafeDb(backendDb).db, row.post_id, registeredTargets),
      registeredTargets,
    );
    return expected && expected !== row.status ? [{ post_id: row.post_id, status: row.status, expected }] : [];
  });
}

function normalizeArchivedJobStatus(status: string): string {
  return status === "failed_archived" ? "cancelled" : status;
}

export function withMaintenanceLock<T>(backendDb: BackendDb, operation: () => T): T {
  const name = "metrics_maintenance";
  const owner = `${os.hostname()}:${process.pid}`;
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 60_000).toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
    tx.delete(maintenanceLocks)
      .where(and(eq(maintenanceLocks.name, name), lt(maintenanceLocks.expiresAt, now.toISOString())))
      .run();
    tx.insert(maintenanceLocks).values({ name, owner, expiresAt: expires, createdAt: now.toISOString() }).onConflictDoNothing().run();
    const row = tx.select({ owner: maintenanceLocks.owner }).from(maintenanceLocks).where(eq(maintenanceLocks.name, name)).get();
    if (!row) throw new Error("maintenance lock could not be acquired");
    if (row.owner !== owner) throw new Error(`maintenance lock is held by ${row.owner}`);
  });
  try {
    return operation();
  } finally {
    unsafeDb(backendDb)
      .db.delete(maintenanceLocks)
      .where(and(eq(maintenanceLocks.name, name), eq(maintenanceLocks.owner, owner)))
      .run();
  }
}
