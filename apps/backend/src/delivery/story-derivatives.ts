import fs from "node:fs";
import path from "node:path";
import { createSerialQueue } from "../../../../shared/serial-queue.js";
import type { StudioMediaAssetRecord } from "../application/ports.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import type { PublishMediaItem } from "./social/payload.js";
import { renderStoryVariants, storyDirectory } from "./story-media.js";

const enqueueRender = createSerialQueue();
const renders = new Map<string, Promise<boolean>>();

/**
 * The Story shapes of an imported file, made once and named by its content.
 *
 * A Story variant is a pure function of the source, and making it cost 8.5-12
 * seconds inside the operator's "Publish" tap. It is made at media ingress,
 * before a draft can point at the asset, and rendered on demand at publish time
 * for an asset that never went through it.
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
  const paths = storyVariantPaths(config, source, storyItemIsVideo(item));
  if (!variantsPresent(paths)) return null;
  return {
    ...item,
    story_local_path: paths.standard,
    storyLocalPath: paths.standard,
    ...(paths.telegram ? { telegramStoryLocalPath: paths.telegram } : {}),
    story_width: 1080,
    story_height: 1920,
  };
}

/**
 * The Story shapes for one source file, made if they are not already there.
 *
 * Ingress calls this so the operator's "Publish" tap finds the files ready;
 * publishing calls the same function so a file that was never prepared -- an
 * asset older than this path, or one whose derivative was lost with the disk --
 * still publishes. One recipe, one content-addressed destination, so the two
 * callers cannot disagree about where the variant lives or how it was made.
 *
 * Renders run one at a time: the transform is the heaviest thing this process
 * does and the media host accepts a single ffmpeg job. In-flight renders are
 * shared by path, so three Story targets of one post wait on one encode.
 */
export async function ensureStoryDerivative(
  config: BackendConfig,
  source: string,
  video: boolean,
  label: Record<string, unknown> = {},
  force = false,
): Promise<boolean> {
  const paths = storyVariantPaths(config, source, video);
  if (!force && variantsPresent(paths)) return false;
  const inFlight = renders.get(paths.standard);
  // Sharing an in-flight render is what makes three Story targets wait on one
  // encode -- but a forced render cannot be answered by one already running,
  // which may be the very render the operator is repairing. It queues behind it
  // instead, and a failure there is not this call's failure to report.
  if (inFlight && !force) return inFlight;
  const render = (inFlight ?? Promise.resolve(false))
    .catch(() => false)
    .then(() => enqueueRender(() => renderVariants(config, source, paths, video, label, force)))
    .finally(() => {
      if (renders.get(paths.standard) === render) renders.delete(paths.standard);
    });
  renders.set(paths.standard, render);
  return render;
}

/** Completes the representation an imported asset needs before it can enter a
 * post draft. Publishing recovers what this could not finish. */
export async function prepareStoryDerivative(config: BackendConfig, asset: StudioMediaAssetRecord): Promise<boolean> {
  return ensureStoryDerivative(config, asset.localPath, asset.kind === "video", { assetId: asset.id, kind: asset.kind });
}

/** The Story variant of one publish item, rendering it first if it is missing. */
export async function ensurePreparedStoryMedia(config: BackendConfig, item: PublishMediaItem): Promise<PublishMediaItem | null> {
  const source = typeof item.localPath === "string" ? item.localPath : null;
  if (!source) return null;
  await ensureStoryDerivative(config, source, storyItemIsVideo(item), { source: "publish" });
  return preparedStoryMedia(config, item);
}

/** Whether the Story shapes of this source are already on disk. The operator's
 * backfill asks it of every asset the Studio holds, so it stays beside the
 * function that names those files rather than restating the naming rule. */
export function storyDerivativePresent(config: BackendConfig, source: string, video: boolean): boolean {
  return variantsPresent(storyVariantPaths(config, source, video));
}

function variantsPresent(paths: { standard: string; telegram?: string }): boolean {
  return fs.existsSync(paths.standard) && (!paths.telegram || fs.existsSync(paths.telegram));
}

async function renderVariants(
  config: BackendConfig,
  source: string,
  paths: { standard: string; telegram?: string },
  video: boolean,
  label: Record<string, unknown>,
  force: boolean,
): Promise<boolean> {
  // Re-checked inside the lane: a render this call queued behind may have been
  // for the same file, and the wait is where it finished.
  if (!force && variantsPresent(paths)) return false;
  if (!fs.existsSync(source)) throw new Error(`story_source_missing: ${source}`);
  await fs.promises.mkdir(storyDirectory(config), { recursive: true });
  const startedAt = Date.now();
  try {
    await renderStoryVariants(source, paths.standard, paths.telegram, video, config);
    log("info", "operation timing", { operation: "media.story.prepare", ...label, success: true, totalMs: Date.now() - startedAt });
    return true;
  } catch (error) {
    // A half-written pair is worse than none: it reads as prepared and ships a
    // Telegram Story rendered for Instagram.
    await removeVariants(paths);
    log("warn", "operation timing", {
      operation: "media.story.prepare",
      ...label,
      success: false,
      totalMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function removeVariants(paths: { standard: string; telegram?: string }): Promise<void> {
  await Promise.all(
    [paths.standard, paths.telegram]
      .filter((value): value is string => Boolean(value))
      .map((value) => fs.promises.rm(value, { force: true })),
  );
}

function storyItemIsVideo(item: PublishMediaItem): boolean {
  return String(item.type ?? "")
    .toLowerCase()
    .includes("video");
}
