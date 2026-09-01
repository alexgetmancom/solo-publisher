import fs from "node:fs";
import path from "node:path";
import { storyTargetsEnabled } from "../botTargets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { studioMediaAssets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import type { PublishMediaItem } from "./social/payload.js";
import { renderStoryVariants, storyDirectory } from "./story-media.js";

/**
 * The Story shapes of an imported file, made once and named by its content.
 *
 * A Story variant is a pure function of the source, and making it cost 8.5-12
 * seconds inside the operator's "Publish" tap. It is made instead by a worker,
 * against a file nobody is waiting on, so the tap finds it already there.
 *
 * There is no table. An imported asset is already stored under its own content
 * hash, so the variant's path is a function of the source's path, and the file
 * being there is the record that it was made. A row saying where the file is
 * would be a second answer to a question the filename already answers, and the
 * one that could disagree.
 */
export function storyVariantPaths(config: BackendConfig, sourcePath: string, video: boolean): { standard: string; telegram?: string } {
  // The import stores every asset as `<first 24 of sha256><ext>`, so the stem is
  // the content address and the variants hang off it.
  const stem = path.basename(sourcePath).replace(/\.[^.]+$/, "");
  const directory = storyDirectory(config);
  return {
    standard: path.join(directory, `${stem}-story-standard.${video ? "mp4" : "jpg"}`),
    ...(video ? { telegram: path.join(directory, `${stem}-story-telegram.mp4`) } : {}),
  };
}

/** The prepared variant for one media item, or nothing if it was never made. */
export function preparedStoryMedia(config: BackendConfig, item: PublishMediaItem): PublishMediaItem | null {
  const source = typeof item.localPath === "string" ? item.localPath : null;
  if (!source) return null;
  const video = String(item.type ?? "")
    .toLowerCase()
    .includes("video");
  const paths = storyVariantPaths(config, source, video);
  if (!fs.existsSync(paths.standard)) return null;
  return {
    ...item,
    story_local_path: paths.standard,
    storyLocalPath: paths.standard,
    ...(paths.telegram && fs.existsSync(paths.telegram) ? { telegramStoryLocalPath: paths.telegram } : {}),
    story_width: 1080,
    story_height: 1920,
  };
}

/**
 * Prepares what has not been prepared yet.
 *
 * This is also the backfill: an asset imported before any of this existed is
 * simply an asset whose variant is not on disk, which is exactly what this
 * claims. No separate migration step, and no state that is half moved.
 */
export async function runStoryDerivativeCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  limit = 2,
): Promise<{ attempted: number; prepared: number }> {
  // A Studio that publishes no Stories has nothing to prepare them for, and
  // this used to encode a vertical variant of every video it had ever imported
  // anyway. Read per cycle rather than at startup, like the site worker: an
  // operator who ticks a Story platform expects the next tick to act on it.
  if (!storyTargetsEnabled(backendDb.studioSettings.profile().defaultTargetsJson)) return { attempted: 0, prepared: 0 };
  const assets = unsafeDb(backendDb).db.select().from(studioMediaAssets).orderBy(studioMediaAssets.id).all();
  let attempted = 0;
  let prepared = 0;
  for (const asset of assets) {
    if (attempted >= limit) break;
    const video = asset.kind === "video";
    const paths = storyVariantPaths(config, asset.localPath, video);
    if (fs.existsSync(paths.standard)) continue;
    if (!fs.existsSync(asset.localPath)) {
      // Nothing to make it from; the source was pruned after its retention.
      continue;
    }
    attempted += 1;
    await fs.promises.mkdir(storyDirectory(config), { recursive: true });
    const startedAt = Date.now();
    try {
      await renderStoryVariants(asset.localPath, paths.standard, paths.telegram, video, config);
      prepared += 1;
      log("info", "operation timing", {
        operation: "media.story.prepare",
        assetId: asset.id,
        kind: asset.kind,
        success: true,
        totalMs: Date.now() - startedAt,
      });
    } catch (error) {
      // Leaving no file behind is what makes the next cycle try again, and what
      // keeps publishing's own render as the path that still works today.
      await fs.promises.rm(paths.standard, { force: true });
      log("warn", "operation timing", {
        operation: "media.story.prepare",
        assetId: asset.id,
        kind: asset.kind,
        success: false,
        totalMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { attempted, prepared };
}
