import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { siteUrlsForIndexNow } from "../../apps/backend/src/delivery/site-content-index.js";
import { indexNowKey } from "../../apps/backend/src/delivery/site-index-now.js";
import { materializeSitePosts, recoverStaleSiteJobs, runSiteJobCycle } from "../../apps/backend/src/delivery/site-jobs.js";
import { materializeSiteMedia } from "../../apps/backend/src/delivery/site-media.js";
import { type Call, runScenarios } from "./delivery-scenario-support.js";

/**
 * The TypeScript side of crates/delivery/tests/site_scenarios.rs: the site
 * build queue, site media materialization and IndexNow, each through the real
 * module over the recording fetch of delivery-scenario-support.ts.
 *
 * IndexNow sends are fire-and-forget on both sides; `settleIndexNow` is the
 * step that lets the one in flight finish before anything is observed.
 *
 *   bun scripts/rust/site-scenarios.ts crates/delivery/tests/site_scenarios.json
 */

/** Every file under the directory: its path, size, digest and link count. */
function listFiles(root: string): { path: string; size: number; sha256: string; links: number }[] {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const stat = fs.statSync(file);
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    files.push({ path: path.relative(root, file), size: stat.size, sha256, links: stat.nlink });
  }
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** The IndexNow state file, with each pending URL's random revision dropped. */
function indexNowState(data: string): unknown {
  const file = path.join(data, "indexnow.json");
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const pending = state.pending_urls as Record<string, string> | undefined;
  return { keys: Object.keys(state), ...state, ...(pending ? { pending_urls: Object.keys(pending) } : {}) };
}

const call: Call = async ({ backendDb, config, fetchImpl, data }, name, args) => {
  switch (name) {
    case "cycle":
      return runSiteJobCycle(config, backendDb);
    case "recoverStale":
      return recoverStaleSiteJobs(backendDb, ...(args.length ? [args[0] as number] : []));
    case "materialize": {
      const keys = args.length ? new Set(args[0] as string[]) : undefined;
      return [...(await materializeSitePosts(config, backendDb, fetchImpl, keys))];
    }
    case "materializeMedia":
      return materializeSiteMedia(config, args[0] as number, args[1] as "ru" | "en", args[2], fetchImpl);
    case "materializeMediaFailure":
      // ffmpeg's own diagnostics name heap addresses and thread order; the
      // exit code is what both sides share.
      try {
        await materializeSiteMedia(config, args[0] as number, args[1] as "ru" | "en", args[2], fetchImpl);
        return null;
      } catch (error) {
        return String(error instanceof Error ? error.message : error).match(/^[^:]*: ffmpeg exit \d+/)?.[0] ?? String(error);
      }
    case "siteUrls":
      return siteUrlsForIndexNow(config, backendDb, new Set(args[0] as string[]));
    case "settleIndexNow":
      // The send and its settlement are a few promise turns on an in-memory fetch.
      for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(1);
      return null;
    case "indexNowState":
      return indexNowState(data);
    case "indexNowKey":
      return indexNowKey(config);
    case "files":
      return listFiles(path.join(data, args[0] as string));
    default:
      throw new Error(`unknown call ${name}`);
  }
};

await runScenarios("site", call);
