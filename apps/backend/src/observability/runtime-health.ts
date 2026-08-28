import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { type JsonValue, workerState } from "../db/schema.js";
import { gitRevision } from "../foundation/runtime/git.js";
import { ALERT_COOLDOWN_SECONDS } from "./alerts.js";

const RUNTIME_STATE_KEY = "runtime";
const RESTART_WINDOW_SECONDS = 30 * 60;
const RESTART_ALERT_THRESHOLD = 3;
const MEMORY_ALERT_PERCENT = 85;

/** Identifies this process. A different value in the persisted state means the
 * process was replaced — deploy, manual restart, healthcheck kill or OOM. */
const BOOT_ID = crypto.randomUUID();

type RuntimeState = {
  bootId: string | null;
  bootedAt: string | null;
  /** The build the previous process ran. A restart that changes it is a
   * deployment, which is what the host does on purpose. */
  revision: string | null;
  restartsAt: string[];
};

function readRuntimeState(backendDb: BackendDb): RuntimeState {
  const empty: RuntimeState = { bootId: null, bootedAt: null, revision: null, restartsAt: [] };
  const row = unsafeDb(backendDb).db.select().from(workerState).where(eq(workerState.name, RUNTIME_STATE_KEY)).get();
  const state = row?.stateJson;
  if (!state || typeof state !== "object" || Array.isArray(state)) return empty;
  return {
    bootId: typeof state.bootId === "string" ? state.bootId : null,
    bootedAt: typeof state.bootedAt === "string" ? state.bootedAt : null,
    revision: typeof state.revision === "string" ? state.revision : null,
    restartsAt: Array.isArray(state.restartsAt) ? state.restartsAt.filter((at): at is string => typeof at === "string") : [],
  };
}

function writeRuntimeState(
  backendDb: BackendDb,
  state: { bootId: string; bootedAt: string; revision: string | null; restartsAt: string[] },
): void {
  const now = new Date().toISOString();
  const payload = {
    bootId: state.bootId,
    bootedAt: state.bootedAt,
    revision: state.revision,
    restartsAt: state.restartsAt,
  } satisfies Record<string, JsonValue>;
  unsafeDb(backendDb)
    .db.insert(workerState)
    .values({ name: RUNTIME_STATE_KEY, stateJson: payload, updatedAt: now })
    .onConflictDoUpdate({ target: workerState.name, set: { stateJson: payload, updatedAt: now } })
    .run();
}

/**
 * Turns process replacement into a durable event.
 *
 * A single restart is normal — every deploy is one — so it is recorded at
 * `info` and never reaches the alert transport, which only picks up warn/error.
 * What is worth waking up for is restarts *clustering* on one build: a crash
 * loop, an OOM kill that keeps recurring, or a healthcheck that cannot stay
 * green. That is the only case escalated to `error`.
 */
export function recordProcessRestart(backendDb: BackendDb, revision = gitRevision()): boolean {
  const previous = readRuntimeState(backendDb);
  const bootedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  if (previous.bootId === BOOT_ID) return false;

  // No previous boot id at all means a fresh database (a first deploy, or a
  // test), not a restart. Adopt the identity silently.
  if (!previous.bootId) {
    writeRuntimeState(backendDb, { bootId: BOOT_ID, bootedAt, revision, restartsAt: [] });
    return false;
  }

  // A restart that brings a different build is a deployment, and a burst of
  // deployments is an afternoon of work, not a crash loop. Only restarts of
  // the same build accumulate towards the alert: it fired 26 times here
  // without the backend ever having crashed once.
  const deployed = revision !== null && previous.revision !== null && revision !== previous.revision;
  const windowStart = Date.now() - RESTART_WINDOW_SECONDS * 1000;
  const restartsAt = deployed ? [bootedAt] : [...previous.restartsAt, bootedAt].filter((at) => Date.parse(at) >= windowStart).slice(-20);
  const looping = restartsAt.length >= RESTART_ALERT_THRESHOLD;
  writeRuntimeState(backendDb, { bootId: BOOT_ID, bootedAt, revision, restartsAt });

  const previousUptimeSeconds = previous.bootedAt ? Math.round((Date.parse(bootedAt) - Date.parse(previous.bootedAt)) / 1000) : null;
  backendDb.events.record({
    type: looping ? "runtime.restart.looping" : "runtime.restarted",
    severity: looping ? "error" : "info",
    target: "runtime",
    message: looping
      ? `Backend restarted ${restartsAt.length} times in the last ${Math.round(RESTART_WINDOW_SECONDS / 60)} minutes`
      : `Backend restarted (previous process ran ${previousUptimeSeconds ?? "?"}s)`,
    details: { bootedAt, previousBootedAt: previous.bootedAt, previousUptimeSeconds, restartsInWindow: restartsAt.length, revision },
    // Only the escalated event needs suppression; a plain restart is not
    // delivered anywhere, and cooling it would hide a real restart history.
    ...(looping ? { cooldownSeconds: ALERT_COOLDOWN_SECONDS } : {}),
  });
  return true;
}

/** Container memory ceiling in bytes, or null when not running under a cgroup
 * limit (a bare `bun run`, or a container started without `mem_limit`).
 *
 * Deliberately not exported: the seam for tests is recordMemoryPressure's
 * `limitBytes` parameter, which defaults to this. */
function cgroupMemoryLimitBytes(): number | null {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    if (raw === "max") return null;
    const bytes = Number(raw);
    // cgroup v1 reports "no limit" as a near-int64 sentinel rather than a word.
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes >= Number.MAX_SAFE_INTEGER) continue;
    return bytes;
  }
  return null;
}

/**
 * Warns while the process is still alive. An OOM kill leaves no in-process
 * trace to report afterwards — by the time anything could alert, the process is
 * gone — so the usable signal is rss crossing a fraction of the cgroup ceiling.
 */
export function recordMemoryPressure(backendDb: BackendDb, limitBytes: number | null = cgroupMemoryLimitBytes()): boolean {
  if (!limitBytes) return false;
  const rss = process.memoryUsage().rss;
  const usedPercent = Math.round((rss / limitBytes) * 100);
  if (usedPercent < MEMORY_ALERT_PERCENT) return false;
  const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return backendDb.events.record({
    type: "runtime.memory.pressure",
    severity: "warn",
    target: "runtime",
    message: `Backend rss ${toMb(rss)}MB is ${usedPercent}% of the ${toMb(limitBytes)}MB container limit`,
    details: { rssMb: toMb(rss), limitMb: toMb(limitBytes), usedPercent },
    cooldownSeconds: ALERT_COOLDOWN_SECONDS,
  });
}
