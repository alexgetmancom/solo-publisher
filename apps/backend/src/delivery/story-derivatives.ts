import fs from "node:fs";
import path from "node:path";
import type { StudioMediaAssetRecord } from "../application/ports.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import type { PublishMediaItem } from "./social/payload.js";
import { renderStoryVariants, storyDirectory } from "./story-media.js";

/**
 * The Story shapes of an imported file, made once and named by its content.
 *
 * A Story variant is a pure function of the source, and making it cost 8.5-12
 * seconds inside the operator's "Publish" tap. It is made at media ingress,
 * before a draft can point at the asset.
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
  if (!fs.existsSync(paths.standard) || (paths.telegram && !fs.existsSync(paths.telegram))) return null;
  return {
    ...item,
    story_local_path: paths.standard,
    storyLocalPath: paths.standard,
    ...(paths.telegram ? { telegramStoryLocalPath: paths.telegram } : {}),
    story_width: 1080,
    story_height: 1920,
  };
}

/** Completes the representation an imported asset needs before it can enter a
 * post draft. Publishing reads the result and never renders a missing one. */
export async function prepareStoryDerivative(config: BackendConfig, asset: StudioMediaAssetRecord): Promise<boolean> {
  return renderAssetDerivative(config, asset);
}

async function renderAssetDerivative(config: BackendConfig, asset: StudioMediaAssetRecord): Promise<boolean> {
  const video = asset.kind === "video";
  const paths = storyVariantPaths(config, asset.localPath, video);
  if (fs.existsSync(paths.standard) && (!paths.telegram || fs.existsSync(paths.telegram))) return false;
  if (!fs.existsSync(asset.localPath)) throw new Error(`story_source_missing: asset ${asset.id}`);
  await fs.promises.mkdir(storyDirectory(config), { recursive: true });
  const startedAt = Date.now();
  try {
    await renderStoryVariants(asset.localPath, paths.standard, paths.telegram, video, config);
    log("info", "operation timing", {
      operation: "media.story.prepare",
      assetId: asset.id,
      kind: asset.kind,
      success: true,
      totalMs: Date.now() - startedAt,
    });
    return true;
  } catch (error) {
    await Promise.all(
      [paths.standard, paths.telegram]
        .filter((value): value is string => Boolean(value))
        .map((value) => fs.promises.rm(value, { force: true })),
    );
    log("warn", "operation timing", {
      operation: "media.story.prepare",
      assetId: asset.id,
      kind: asset.kind,
      success: false,
      totalMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
