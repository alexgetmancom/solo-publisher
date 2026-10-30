import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";

type IndexNowState = { last_digest?: string; last_attempt_at?: string; last_success_at?: string; last_status?: number; url_count?: number };

/** Delivery side effect: notify search engines after site materialization. */
export async function pingIndexNow(config: BackendConfig, urls: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!config.INDEXNOW_ENABLED) return;
  const unique = [...new Set(urls)].sort().slice(0, 10_000);
  if (unique.length === 0) return;
  const keyFile = path.join(config.DATA_DIR, "indexnow.key");
  const stateFile = path.join(config.DATA_DIR, "indexnow.json");
  const key = readOrCreateKey(keyFile);
  const digest = crypto.createHash("sha256").update(unique.join("\n")).digest("hex");
  const previous = readState(stateFile);
  if (previous.last_digest === digest) return;
  const state: IndexNowState = { ...previous, last_attempt_at: new Date().toISOString(), url_count: unique.length };
  writeState(stateFile, state);
  try {
    const response = await fetchImpl("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: new URL(config.PUBLIC_BASE_URL).host,
        key,
        keyLocation: `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}.txt`,
        urlList: unique,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    state.last_status = response.status;
    if (response.ok || response.status === 202) {
      state.last_digest = digest;
      state.last_success_at = new Date().toISOString();
    }
    writeState(stateFile, state);
    if (!response.ok && response.status !== 202) {
      const error = new Error(`IndexNow request rejected: ${response.status}`);
      log("warn", error.message, { status: response.status, urls: unique.length });
      throw error;
    }
  } catch (error) {
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
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as IndexNowState;
  } catch {
    return {};
  }
}

function writeState(filePath: string, state: IndexNowState): void {
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o664 });
}
