import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { workerState } from "../db/schema.js";
import type { EnvConfig } from "../foundation/config.js";

/** How stale the newest export may be before `doctor` calls the deployment
 * unhealthy. The database also leaves daily over Telegram; media has no second
 * route off this host, and a week is short enough that a puller that stopped is
 * still noticed while the volume it protects is intact. */
const EXPORT_MAX_AGE_DAYS = 7;

export type ExportKind = "media" | "db";

/** Where the database export's bytes go. Bun's stdout writer satisfies it; a
 * test passes a collector. */
export type ByteSink = { write(chunk: Uint8Array): unknown; flush(): unknown; end(): unknown };

/** Written and flushed in slices rather than as one buffer. */
const FLUSH_BYTES = 4 * 1024 * 1024;

/** Nothing is written to this host. Each export is a stream a backup host pulls
 * over SSH and stores where this deployment cannot reach it: a Studio that held
 * its own backups would lose them with itself, and a Studio that could write to
 * the backup store would let whoever takes it destroy them. */
export type ExportStatus = {
  kind: ExportKind;
  at: string | null;
  bytes: number | null;
  ageDays: number | null;
  ok: boolean;
};

const stateKey = (kind: ExportKind) => `export:${kind}`;

/** The media trees a database export does not carry. They exist only on the
 * data volume, so losing it loses all of them at once. */
/** A second, blocking handle on whatever stdout points at.
 *
 * Bun puts its own stdout into non-blocking mode, and a child that inherits it
 * gets the same file description: tar then meets EAGAIN on the first full pipe
 * buffer and dies with "Wrote only 6144 of 10240 bytes" — which a puller reads
 * as a short archive. Opening `/dev/fd/1` creates a *new* description with
 * default blocking semantics onto the same pipe, so a reader that falls behind
 * simply makes tar wait. */
function blockingStdout(): number {
  // Write-only and nothing else. Node's "a"/"w" flags carry O_CREAT, which the
  // kernel refuses on the magic symlink `/dev/fd/1` becomes when stdout is a
  // pipe — the exact case this exists for.
  return fs.openSync("/dev/fd/1", fs.constants.O_WRONLY);
}

function mediaSources(config: EnvConfig): string[] {
  return [config.STUDIO_MEDIA_DIR, config.MEDIA_CACHE_DIR, config.STORY_CARD_DIR, config.SITE_PUBLIC_DIR];
}

export function recordExport(backendDb: BackendDb, kind: ExportKind, bytes: number | null, now = new Date()): void {
  const at = now.toISOString();
  unsafeDb(backendDb)
    .db.insert(workerState)
    .values({ name: stateKey(kind), stateJson: { at, bytes }, updatedAt: at })
    .onConflictDoUpdate({ target: workerState.name, set: { stateJson: { at, bytes }, updatedAt: at } })
    .run();
}

export function exportStatus(backendDb: BackendDb, kind: ExportKind, now = new Date()): ExportStatus {
  const row = unsafeDb(backendDb)
    .db.select()
    .from(workerState)
    .where(eq(workerState.name, stateKey(kind)))
    .get();
  const state = row?.stateJson;
  const at = state && typeof state === "object" && !Array.isArray(state) && typeof state.at === "string" ? state.at : null;
  const bytes = state && typeof state === "object" && !Array.isArray(state) && typeof state.bytes === "number" ? state.bytes : null;
  const ageDays = at ? Math.round(((now.getTime() - Date.parse(at)) / (24 * 60 * 60 * 1000)) * 100) / 100 : null;
  return { kind, at, bytes, ageDays, ok: ageDays !== null && ageDays <= EXPORT_MAX_AGE_DAYS };
}

/** Writes a gzipped tar of every media tree that exists to `destination` — the
 * process's own stdout in production — then records the export. Sources travel
 * relative to DATA_DIR so the archive restores onto a fresh volume unchanged,
 * whatever the host path was when it was taken.
 *
 * tar writes to the destination directly rather than through this process. A
 * gigabyte of media pulled over a 2 MB/s link cannot be held in memory while the
 * reader catches up: passing the bytes through Bun's stdout writer buffered them
 * instead of applying backpressure, and the OOM killer ended the export 47 MB in
 * — which the puller stored as if it were the whole archive. Letting the kernel
 * own the pipe makes a slow reader slow tar down, which is the only correct
 * behaviour and needs no code. */
export async function streamMediaArchive(
  config: EnvConfig,
  backendDb: BackendDb,
  destination: "inherit" | number,
): Promise<number | null> {
  const present = mediaSources(config).filter((source) => fs.existsSync(source));
  if (!present.length) throw new Error("no media directories exist to export");
  const relative = present.map((source) => path.relative(config.DATA_DIR, source));
  if (relative.some((entry) => entry.startsWith("..") || path.isAbsolute(entry)))
    throw new Error("every media directory must live under DATA_DIR for the archive to restore onto a fresh volume");
  const out = destination === "inherit" ? blockingStdout() : destination;
  const [exitCode, stderr] = await (async () => {
    try {
      const child = Bun.spawn(["tar", "-czf", "-", "-C", config.DATA_DIR, ...relative], { stdout: out, stderr: "pipe" });
      return await Promise.all([child.exited, new Response(child.stderr).text()]);
    } finally {
      if (out !== destination) fs.closeSync(out);
    }
  })();
  // Recorded only on a clean exit: a truncated archive that counted as a backup
  // is worse than none, because `doctor` would then stay green over it.
  if (exitCode !== 0) throw new Error(`tar failed (${exitCode}): ${stderr.trim()}`);
  recordExport(backendDb, "media", null);
  return null;
}

/** Writes a consistent copy of the database to `sink`, then records the export.
 * `serialize` takes the snapshot under SQLite's own lock, so a write landing
 * mid-export cannot tear it. */
export async function streamDatabase(backendDb: BackendDb, sink: ByteSink): Promise<number> {
  const snapshot = unsafeDb(backendDb).sqlite.serialize();
  for (let offset = 0; offset < snapshot.byteLength; offset += FLUSH_BYTES) {
    await sink.write(snapshot.subarray(offset, offset + FLUSH_BYTES));
    await sink.flush();
  }
  await sink.end();
  recordExport(backendDb, "db", snapshot.byteLength);
  return snapshot.byteLength;
}
