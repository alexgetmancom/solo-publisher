import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { type JsonValue, workerState } from "../../db/schema.js";

/** How often a running loop says it is still alive. */
const WORKER_HEARTBEAT_INTERVAL_SECONDS = 60;

/** Runtime heartbeat persistence shared by background cycles. */
export function recordWorkerState(backendDb: BackendDb, name: string, state: Record<string, JsonValue>, error: string | null = null): void {
  const now = new Date().toISOString();
  const payload = {
    ...state,
    ok: error == null,
    last_run_at: now,
    last_error: error,
    scheduler_error: null,
    last_heartbeat_at: now,
  };
  unsafeDb(backendDb)
    .db.insert(workerState)
    .values({ name, stateJson: payload, updatedAt: now })
    .onConflictDoUpdate({ target: workerState.name, set: { stateJson: payload, updatedAt: now } })
    .run();
}

/** Updates lifecycle metadata without overwriting a cycle's counters or verdict. */
function recordWorkerHeartbeat(
  backendDb: BackendDb,
  name: string,
  state: Record<string, JsonValue> = {},
  schedulerError: string | null = null,
): void {
  const now = new Date().toISOString();
  const current =
    unsafeDb(backendDb).db.select({ stateJson: workerState.stateJson }).from(workerState).where(eq(workerState.name, name)).get()
      ?.stateJson ?? {};
  const payload = { ...current, ...state, scheduler_error: schedulerError, last_heartbeat_at: now };
  unsafeDb(backendDb)
    .db.insert(workerState)
    .values({ name, stateJson: payload, updatedAt: now })
    .onConflictDoUpdate({ target: workerState.name, set: { stateJson: payload, updatedAt: now } })
    .run();
}

/** Names expected once the corresponding runtime has started its workers. The
 * site loops are on this list whether or not the Studio serves a site: they are
 * started either way and idle on the flag inside the tick, so leaving them off
 * hid two running, healthy workers from `status` and from the health report. */
export const CORE_WORKER_NAMES = [
  "story-derivatives",
  "story-cards",
  "queue",
  "publish-watchdog",
  "publication-reconciliation",
  "notifications",
  "video",
  "metrics",
  "creator-analytics",
  "metric-retention",
  "site",
  "site-watchdog",
  "media-cache",
  "operational-retention",
  "observability",
  "platform-tokens",
  "credentials",
  "x-token",
] as const;

/** The interface loops. They deliver the daily digest, the database backup and
 * every alert, and until they reported a heartbeat `status` called a Studio
 * healthy while its whole Telegram side was dead. */
export const TELEGRAM_WORKER_NAMES = [
  "telegram-albums",
  "telegram-events",
  "telegram-alerts",
  "telegram-weekly-summary",
  "telegram-daily-backup",
  "telegram-editorial-inbox",
  "telegram-news-digest",
  "telegram-analytics-dashboard",
] as const;

/** Telegram loops are expected only where a controller bot is configured; a
 * Studio driven entirely through MCP never starts them. */
export function expectedWorkerNames(telegramEnabled: boolean): string[] {
  return [...CORE_WORKER_NAMES, ...(telegramEnabled ? TELEGRAM_WORKER_NAMES : [])];
}

export function workerLiveness(
  state: Record<string, unknown>,
  updatedAt: string,
): { ageSeconds: number; stale: boolean; lastHeartbeatAt: string } {
  const lastHeartbeatAt = typeof state.last_heartbeat_at === "string" ? state.last_heartbeat_at : updatedAt;
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(lastHeartbeatAt)) / 1000));
  const intervalMs = typeof state.heartbeat_interval_ms === "number" ? state.heartbeat_interval_ms : null;
  const staleAfterSeconds = intervalMs == null ? null : Math.max(120, Math.ceil((intervalMs / 1000) * 3));
  return { ageSeconds, stale: staleAfterSeconds != null && ageSeconds > staleAfterSeconds, lastHeartbeatAt };
}

/** One loop factory for every runtime, because a loop that records no heartbeat
 * is a loop `status` cannot see — which is how the whole Telegram side ran
 * unwatched. `startLoop` is passed in: this module is below the scheduler. */
export function heartbeatLoop<Loop>(
  backendDb: BackendDb,
  startLoop: (
    name: string,
    intervalMs: number,
    task: () => void | Promise<void>,
    hooks: {
      onStart: () => void;
      onHeartbeat: () => void;
      heartbeatIntervalMs: number;
      onFinish: (error: unknown) => void;
    },
  ) => Loop,
  onHeartbeat?: () => void,
) {
  return (name: string, intervalMs: number, task: () => void | Promise<void>): Loop => {
    const heartbeatIntervalMs = WORKER_HEARTBEAT_INTERVAL_SECONDS * 1000;
    let publishStartupHeartbeat = true;
    return startLoop(name, intervalMs, task, {
      onStart: () => {
        if (!publishStartupHeartbeat) return;
        publishStartupHeartbeat = false;
        recordWorkerHeartbeat(backendDb, name, { phase: "running", heartbeat_interval_ms: heartbeatIntervalMs });
      },
      onHeartbeat: () => {
        onHeartbeat?.();
        recordWorkerHeartbeat(backendDb, name, { heartbeat_interval_ms: heartbeatIntervalMs });
      },
      heartbeatIntervalMs,
      onFinish: (error) => {
        if (!error) return;
        publishStartupHeartbeat = true;
        recordWorkerHeartbeat(
          backendDb,
          name,
          { phase: "failed", heartbeat_interval_ms: heartbeatIntervalMs },
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  };
}
