import fs from "node:fs";
import { type BackendDb, unsafeDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { gitRevision } from "../foundation/runtime/git.js";
import { expectedWorkerNames, workerLiveness } from "../foundation/runtime/worker-state.js";

type StatusCountRow = {
  status: string;
  count: number;
};

type WorkerStateRow = {
  name: string;
  state_json: string;
  updated_at: string;
};

function statusCounts(backendDb: BackendDb, table: string): Record<string, number> {
  const rows = unsafeDb(backendDb)
    .sqlite.query(`SELECT status, count(*) AS count FROM ${table} GROUP BY status ORDER BY status`)
    .all() as StatusCountRow[];
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function workers(backendDb: BackendDb, expectedNames: ReadonlySet<string>) {
  return (unsafeDb(backendDb).sqlite.query("SELECT name,state_json,updated_at FROM worker_state ORDER BY name").all() as WorkerStateRow[])
    .filter((row) => expectedNames.has(row.name))
    .map((row) => {
      const state = JSON.parse(row.state_json) as Record<string, import("../db/schema.js").JsonValue>;
      return {
        name: row.name,
        ok: state.ok !== false,
        lastRunAt: typeof state.last_run_at === "string" ? state.last_run_at : row.updated_at,
        lastError:
          typeof state.scheduler_error === "string"
            ? state.scheduler_error
            : typeof state.last_error === "string"
              ? state.last_error
              : null,
        ...workerLiveness(state, row.updated_at),
      };
    });
}

function countRows(backendDb: BackendDb, table: string): number {
  const row = unsafeDb(backendDb).sqlite.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

/** Compact health-oriented status shared by text-first and video-first Studios. */
export function compactOperationsStatus(config: BackendConfig, backendDb: BackendDb) {
  const expectedWorkers = expectedWorkerNames(Boolean(config.controllerBotToken));
  const workerRows = workers(backendDb, new Set(expectedWorkers));
  const observedWorkers = new Set(workerRows.map((worker) => worker.name));
  const missingWorkers = expectedWorkers.filter((name) => !observedWorkers.has(name));
  const postTargetCounts = statusCounts(backendDb, "publication_targets");
  const publishJobCounts = statusCounts(backendDb, "publish_jobs");
  const siteJobCounts = statusCounts(backendDb, "site_jobs");
  const videoDraftCounts = statusCounts(backendDb, "video_drafts");
  const videoTargetCounts = statusCounts(backendDb, "video_targets");
  const videoJobCounts = statusCounts(backendDb, "video_jobs");
  const metricSchedule = unsafeDb(backendDb)
    .sqlite.query(
      `SELECT count(*) AS total,
        sum(CASE WHEN frozen_at IS NOT NULL THEN 1 ELSE 0 END) AS frozen,
        sum(CASE WHEN frozen_at IS NULL AND (next_check_at IS NULL OR next_check_at <= ?) THEN 1 ELSE 0 END) AS due,
        sum(CASE WHEN frozen_at IS NULL AND last_error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
        max(last_checked_at) AS lastCheckedAt
      FROM metric_schedule`,
    )
    .get(new Date().toISOString()) as {
    total: number;
    frozen: number | null;
    due: number | null;
    errors: number | null;
    lastCheckedAt: string | null;
  };
  const actionableIssues = backendDb.actionableIssues.list();
  const unhealthy = missingWorkers.length > 0 || workerRows.some((worker) => !worker.ok || worker.stale) || actionableIssues.length > 0;

  return {
    ok: !unhealthy,
    generatedAt: new Date().toISOString(),
    gitRevision: gitRevision(),
    siteEnabled: config.studio.siteEnabled,
    database: {
      path: config.PIPELINE_DB,
      exists: fs.existsSync(config.PIPELINE_DB),
    },
    workers: workerRows,
    missingWorkers,
    // The same rows the Studio screen and the Command Center's red dot read.
    attention: {
      total: actionableIssues.length,
      byKind: actionableIssues.reduce<Record<string, number>>((counts, issue) => {
        counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
        return counts;
      }, {}),
    },
    posts: {
      total: Number(unsafeDb(backendDb).sqlite.query("SELECT count(*) AS count FROM drafts WHERE post_id IS NOT NULL").get()?.count ?? 0),
      targets: { total: total(postTargetCounts), byStatus: postTargetCounts },
      jobs: { total: total(publishJobCounts), byStatus: publishJobCounts },
    },
    videos: {
      drafts: { total: total(videoDraftCounts), byStatus: videoDraftCounts },
      targets: {
        total: total(videoTargetCounts),
        byStatus: videoTargetCounts,
        actionableFailures: actionableIssues.filter((issue) => issue.kind === "video").length,
      },
      jobs: { total: total(videoJobCounts), byStatus: videoJobCounts },
    },
    site: {
      jobs: { total: total(siteJobCounts), byStatus: siteJobCounts },
    },
    metrics: {
      samples: countRows(backendDb, "metric_samples"),
      schedule: {
        total: Number(metricSchedule.total),
        frozen: Number(metricSchedule.frozen ?? 0),
        due: Number(metricSchedule.due ?? 0),
        errors: Number(metricSchedule.errors ?? 0),
        lastCheckedAt: metricSchedule.lastCheckedAt,
      },
    },
  };
}
