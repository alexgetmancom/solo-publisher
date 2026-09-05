import fs from "node:fs";
import { storyTargetsEnabled } from "../botTargets.js";
import { registeredPostTargetIds } from "../channels/registry.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { postLocales, studioMediaAssets } from "../db/schema.js";
import { ensureStoryDerivative, storyDerivativePresent } from "../delivery/story-derivatives.js";
import type { BackendConfig } from "../foundation/config.js";
import { jsonObject } from "../json.js";

type Source = { localPath: string; video: boolean; origin: "asset" | "draft" };

/**
 * Renders the Story shapes of every source this Studio could still be asked to
 * publish one from.
 *
 * Preparation happens at ingress, where nobody is waiting for it. This exists
 * for what predates that path or lost its files with a disk: without it,
 * publishing is the only thing that would notice, and it would notice by
 * spending 8-12 seconds on an encode with the post already on its way out.
 *
 * Both the assets the Studio holds and the media its drafts point at, because a
 * post imported before assets existed is still a post that can be republished.
 * The work is one encode at a time and `limit` is how it is run in batches; a
 * source whose file is gone is reported rather than rendered, because there is
 * nothing left to render it from.
 */
export async function backfillStoryMedia(
  backendDb: BackendDb,
  config: BackendConfig,
  apply: boolean,
  limit: number,
): Promise<Record<string, unknown>> {
  const connected = Object.fromEntries([...registeredPostTargetIds(backendDb)].map((target) => [target, true]));
  if (!storyTargetsEnabled(connected))
    return { ok: true, applied: false, story_targets_connected: false, missing: 0, note: "this Studio publishes no Stories" };
  const sources = collectSources(backendDb);
  const present: Source[] = [];
  const gone: Source[] = [];
  const missing: Source[] = [];
  for (const source of sources) {
    if (!fs.existsSync(source.localPath)) gone.push(source);
    else if (storyDerivativePresent(config, source.localPath, source.video)) present.push(source);
    else missing.push(source);
  }
  const base = {
    story_targets_connected: true,
    sources: sources.length,
    prepared: present.length,
    missing: missing.length,
    source_file_gone: gone.length,
    missing_videos: missing.filter((source) => source.video).length,
    plan: missing.slice(0, limit).map((source) => ({ local_path: source.localPath, video: source.video, origin: source.origin })),
  };
  if (!apply || missing.length === 0) return { ok: true, applied: false, ...base };
  const rendered: string[] = [];
  const failed: Array<{ local_path: string; error: string }> = [];
  for (const source of missing.slice(0, limit)) {
    try {
      await ensureStoryDerivative(config, source.localPath, source.video, { source: "backfill" });
      rendered.push(source.localPath);
    } catch (error) {
      failed.push({ local_path: source.localPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    ok: failed.length === 0,
    applied: true,
    ...base,
    rendered: rendered.length,
    failed,
    remaining: missing.length - rendered.length,
  };
}

/** Every local file a Story could be made of, each one once. Two origins name
 * the same file whenever a draft points at an asset, and the content-addressed
 * path is what says they are the same. */
function collectSources(backendDb: BackendDb): Source[] {
  const byPath = new Map<string, Source>();
  for (const asset of unsafeDb(backendDb)
    .db.select({ localPath: studioMediaAssets.localPath, kind: studioMediaAssets.kind })
    .from(studioMediaAssets)
    .all())
    if (asset.localPath) byPath.set(asset.localPath, { localPath: asset.localPath, video: asset.kind === "video", origin: "asset" });
  for (const locale of unsafeDb(backendDb).db.select({ mediaJson: postLocales.mediaJson }).from(postLocales).all())
    for (const item of mediaItems(locale.mediaJson)) {
      const localPath = typeof item.local_path === "string" ? item.local_path : typeof item.localPath === "string" ? item.localPath : null;
      if (!localPath || byPath.has(localPath)) continue;
      byPath.set(localPath, {
        localPath,
        video: String(item.type ?? "")
          .toLowerCase()
          .includes("video"),
        origin: "draft",
      });
    }
  return [...byPath.values()];
}

function mediaItems(value: unknown): Record<string, unknown>[] {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  return Array.isArray(parsed) ? parsed.map(jsonObject) : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}
