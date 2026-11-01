import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";

type IndexNowState = {
  last_attempt_at?: string;
  last_success_at?: string;
  last_status?: number;
  url_count?: number;
  pending_urls?: Record<string, string>;
  retry_at?: string;
};

const inFlight = new Map<string, Promise<void>>();
const RETRY_DELAY_MS = 60_000;

/** Queue a public content change without waiting for the search provider. */
export function enqueueIndexNow(config: BackendConfig, urls: string[]): void {
  if (!config.INDEXNOW_ENABLED || !urls.length) return;
  const stateFile = path.join(config.DATA_DIR, "indexnow.json");
  const previous = readState(stateFile);
  const pending = { ...previous.pending_urls };
  for (const url of new Set(urls)) pending[url] = crypto.randomUUID();
  writeState(stateFile, { ...previous, pending_urls: pending });
}

/** Persist completed content changes before attempting the external notification.
 * Idle site cycles also call this with no URLs to drain failed or large batches. */
export async function pingIndexNow(config: BackendConfig, urls: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!config.INDEXNOW_ENABLED) return;
  const stateFile = path.join(config.DATA_DIR, "indexnow.json");
  const unique = [...new Set(urls)].sort();
  if (unique.length) {
    enqueueIndexNow(config, unique);
  } else if (!Object.keys(readState(stateFile).pending_urls ?? {}).length || inFlight.has(stateFile)) {
    return;
  }
  // Enqueuing above is synchronous. Serializing sends cannot lose a content
  // change made while an earlier request for the same URL is in flight.
  const prior = inFlight.get(stateFile);
  const attempt = prior
    ? prior.catch(() => {}).then(() => sendPending(config, stateFile, unique.length === 0, fetchImpl))
    : sendPending(config, stateFile, unique.length === 0, fetchImpl);
  inFlight.set(stateFile, attempt);
  try {
    await attempt;
  } finally {
    if (inFlight.get(stateFile) === attempt) inFlight.delete(stateFile);
  }
}

async function sendPending(config: BackendConfig, stateFile: string, idle: boolean, fetchImpl: typeof fetch): Promise<void> {
  const state = readState(stateFile);
  if (idle && state.retry_at && Date.parse(state.retry_at) > Date.now()) return;
  const batch = Object.entries(state.pending_urls ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 10_000);
  if (!batch.length) return;
  const key = readOrCreateKey(path.join(config.DATA_DIR, "indexnow.key"));
  state.last_attempt_at = new Date().toISOString();
  state.url_count = batch.length;
  delete state.last_status;
  writeState(stateFile, state);
  try {
    const response = await fetchImpl("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: new URL(config.PUBLIC_BASE_URL).host,
        key,
        keyLocation: `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}.txt`,
        urlList: batch.map(([url]) => url),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const latest = readState(stateFile);
    latest.last_status = response.status;
    if (response.status === 200 || response.status === 202) {
      for (const [url, revision] of batch) {
        if (latest.pending_urls?.[url] === revision) delete latest.pending_urls[url];
      }
      latest.last_success_at = new Date().toISOString();
      delete latest.retry_at;
    }
    writeState(stateFile, latest);
    if (response.status !== 200 && response.status !== 202) throw new Error(`IndexNow request rejected: ${response.status}`);
  } catch (error) {
    const latest = readState(stateFile);
    writeState(stateFile, { ...latest, retry_at: new Date(Date.now() + RETRY_DELAY_MS).toISOString() });
    log("warn", "IndexNow request failed", { error: String(error) });
    throw error;
  }
}

/** The key IndexNow fetches back from `/<key>.txt` to prove the pings are ours.
 * Served by this Studio (interfaces/http/public-site.ts) rather than written
 * into the site, which is a separate service with no disk of ours. */
export function indexNowKey(config: BackendConfig): string | null {
  try {
    const value = fs.readFileSync(path.join(config.DATA_DIR, "indexnow.key"), "utf8").trim();
    return /^[a-f0-9-]{8,128}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

function readOrCreateKey(filePath: string): string {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    if (/^[a-f0-9-]{8,128}$/i.test(value)) return value;
  } catch {}
  const value = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${value}\n`, { encoding: "utf8", mode: 0o664 });
  return value;
}

function readState(filePath: string): IndexNowState {
  try {
    const state: IndexNowState = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid IndexNow state");
    if (
      state.pending_urls !== undefined &&
      (!state.pending_urls ||
        typeof state.pending_urls !== "object" ||
        Array.isArray(state.pending_urls) ||
        Object.values(state.pending_urls).some((revision) => typeof revision !== "string"))
    ) {
      throw new Error("Invalid IndexNow pending_urls");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function writeState(filePath: string, state: IndexNowState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o664 });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
