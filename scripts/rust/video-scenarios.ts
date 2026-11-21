import fs from "node:fs";
import path from "node:path";
import { unsafeDb } from "../../apps/backend/src/db/client.js";
import { postDraftReferencesAsset, pruneExpiredVideos } from "../../apps/backend/src/delivery/video-retention.js";
import { recoverVideoLocks, runVideoCycle } from "../../apps/backend/src/delivery/video-worker.js";
import { recordAuthFailure } from "../../apps/backend/src/observability/auth-circuit.js";
import { type Call, runScenarios } from "./delivery-scenario-support.js";

/**
 * The TypeScript side of crates/delivery/tests/video_scenarios.rs: the video
 * worker cycle, stale lock recovery and the retention sweep, through the real
 * modules over the recording fetch of delivery-scenario-support.ts (the video
 * publishers call the global `fetch`, which the support replaces).
 *
 *   bun scripts/rust/video-scenarios.ts crates/delivery/tests/video_scenarios.json
 */

const call: Call = async ({ backendDb, config, data }, name, args) => {
  switch (name) {
    case "cycle":
      return runVideoCycle(config, backendDb);
    case "recover":
      return recoverVideoLocks(backendDb, config);
    case "prune":
      pruneExpiredVideos(config, backendDb);
      return null;
    case "references":
      return postDraftReferencesAsset(backendDb, args[0] as number);
    case "authFailure":
      recordAuthFailure(backendDb, args[0] as string);
      return null;
    case "asset": {
      // The asset row names its file by absolute path, which only the run knows.
      const [id, file, kind, sha256] = args as [number, string, string, string];
      unsafeDb(backendDb).sqlite.run(
        "INSERT INTO studio_media_assets (id, actor_id, kind, mime_type, filename, local_path, byte_size, sha256, source, created_at) VALUES (?, 42, ?, ?, ?, ?, 32, ?, 'upload', '2026-03-01T09:00:00.000Z')",
        [id, kind, kind === "video" ? "video/mp4" : "image/jpeg", path.basename(file), path.join(data, file), sha256],
      );
      return null;
    }
    case "exists":
      return (args as string[]).map((file) => fs.existsSync(path.join(data, file)));
    default:
      throw new Error(`unknown call ${name}`);
  }
};

await runScenarios("video", call);
