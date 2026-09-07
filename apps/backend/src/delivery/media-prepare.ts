import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../foundation/config.js";
import { materializeTelegramFile } from "../foundation/external/telegram-files.js";
import { probeMediaMetadata, runFfmpeg } from "../foundation/runtime/ffmpeg.js";
import { videoBounds } from "../publishing/platform-profiles.js";
import { copyFileAtomically } from "./site-media-storage.js";
import { mediaExtension, type PublishMediaItem } from "./social/payload.js";
import { storyDirectory } from "./story-media.js";

const MEDIA_CACHE_TTL_SECONDS = 86_400;

/** Enough of a JPEG to hold every segment header before the first scan. */
const JPEG_SEGMENT_TABLE_BYTES = 65_536;

export async function prepareMediaItems(
  config: BackendConfig,
  sourceItems: PublishMediaItem[],
  fetchImpl: typeof fetch = fetch,
  target?: string,
): Promise<PublishMediaItem[]> {
  const prepared: PublishMediaItem[] = [];
  await fs.promises.mkdir(config.MEDIA_CACHE_DIR, { recursive: true });
  await fs.promises.mkdir(config.REMOTE_MEDIA_PATH, { recursive: true });

  for (let index = 0; index < sourceItems.length; index += 1) {
    const item = sourceItems[index];
    if (!item) continue;
    const cacheKey = await mediaCacheKey(item, index);
    const localPath = await ensureLocalMedia(config, item, cacheKey, fetchImpl);
    const uploadPath =
      item.type === "VIDEO"
        ? await normalizeVideoForPublicUpload(config, localPath, cacheKey, target)
        : await baselineJpegForPublicUpload(config, localPath, cacheKey);
    // The public filename must vary with the *normalized* file, not the source:
    // two targets with different videoBounds produce different local files but
    // would otherwise stage under one name, and copyIfMissing would silently
    // serve the first target's resolution to the second.
    const remoteFilename = `cache-${remoteVariantKey(cacheKey, localPath, uploadPath)}${path.extname(uploadPath) || mediaExtension(item)}`;
    const stagedPath = path.join(config.REMOTE_MEDIA_PATH, remoteFilename);
    await copyIfMissing(uploadPath, stagedPath);

    const preparedItem: PublishMediaItem = {
      ...item,
      localPath: uploadPath,
      vpsUrl: `${config.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, "")}/${remoteFilename}`,
    };
    // The worker produces two Story derivatives from a single VAAPI pass.
    // Telegram receives its small-file variant; Instagram keeps the quality
    // master. The selected file remains storyLocalPath for each publisher.
    const storyPath = isTelegramStoryTarget(target) ? item.telegramStoryLocalPath || item.storyLocalPath : item.storyLocalPath;
    if (storyPath) {
      const storyCacheKey = await mediaCacheKey({ ...item, localPath: storyPath }, index);
      const storyRemoteFilename = `cache-${storyCacheKey}-story${path.extname(storyPath) || mediaExtension(item)}`;
      const storyStagedPath = path.join(config.REMOTE_MEDIA_PATH, storyRemoteFilename);
      await copyIfMissing(storyPath, storyStagedPath);
      preparedItem.storyLocalPath = storyPath;
      preparedItem.storyVpsUrl = `${config.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, "")}/${storyRemoteFilename}`;
    }
    prepared.push(preparedItem);
  }

  return prepared;
}

/** Source media stages under its own cache key; a normalized derivative gets the
 * variant marker its local filename already carries (e.g. `1080x1920`), so each
 * bounds variant owns a distinct public URL. */
function remoteVariantKey(cacheKey: string, localPath: string, uploadPath: string): string {
  if (uploadPath === localPath) return cacheKey;
  const variant = path
    .basename(uploadPath, path.extname(uploadPath))
    .replace(`${cacheKey}.`, "")
    .replace(/[^a-z0-9.]+/gi, "-");
  return variant ? `${cacheKey}-${variant}` : cacheKey;
}

function isTelegramStoryTarget(target: string | undefined): boolean {
  return target === "telegram_stories";
}

export async function pruneMediaCache(config: BackendConfig, now = Date.now()): Promise<number> {
  const cutoff = now - MEDIA_CACHE_TTL_SECONDS * 1000;
  // `.incoming` holds pre-hash upload temporaries; they are removed on the happy
  // path but leak when the process dies mid-import, so age them out here too.
  // Story derivatives are durable and named by their source's content hash, so
  // that directory is not a cache -- except for the dot-prefixed partials an
  // encode killed mid-flight leaves behind, which nothing will ever rename in.
  const roots = [config.MEDIA_CACHE_DIR, config.REMOTE_MEDIA_PATH, path.join(config.STUDIO_MEDIA_DIR, ".incoming"), storyDirectory(config)];
  let removed = 0;
  for (const root of roots) {
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        if (root === config.REMOTE_MEDIA_PATH && !entry.name.startsWith("cache-")) return;
        if (root === storyDirectory(config) && !entry.name.startsWith(".")) return;
        const target = path.join(root, entry.name);
        const stat = await fs.promises.stat(target).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) {
          await fs.promises.rm(target, { force: true });
          removed += 1;
        }
      }),
    );
  }
  return removed;
}

async function ensureLocalMedia(config: BackendConfig, item: PublishMediaItem, cacheKey: string, fetchImpl: typeof fetch): Promise<string> {
  const extension = mediaExtension(item);
  const target = path.join(config.MEDIA_CACHE_DIR, `${cacheKey}${extension}`);
  if (await Bun.file(target).exists()) return target;
  if (item.localPath) {
    await copyIfMissing(item.localPath, target);
    return target;
  }
  if (!item.fileId) throw new Error("media item has neither localPath nor fileId");
  await materializeTelegramFile(config, { fileId: item.fileId, ...(item.token ? { token: item.token } : {}) }, { target, fetchImpl });
  return target;
}

/** Meta's media fetcher cannot read a progressive JPEG. It answers a perfectly
 * reachable URL with subcode 2207052 -- "could not fetch the media file" --
 * which reads as a network or permission fault and is neither, so the failure
 * costs a Threads publication and an investigation both. Images are otherwise
 * staged byte for byte, so whatever encoding the source arrived in is what the
 * platform is asked to fetch. */
async function baselineJpegForPublicUpload(config: BackendConfig, inputPath: string, cacheKey: string): Promise<string> {
  if (!(await isProgressiveJpeg(inputPath))) return inputPath;
  const outputPath = path.join(config.MEDIA_CACHE_DIR, `${cacheKey}.baseline.jpg`);
  if (await Bun.file(outputPath).exists()) return outputPath;
  await runFfmpeg(["-y", "-i", inputPath, "-q:v", "2", outputPath]);
  return outputPath;
}

/** Progressive encoding is declared by an SOF2 marker in the segment table,
 * which precedes the first scan -- so the answer is in the first few kilobytes
 * and the pixels never have to be decoded. */
export async function isProgressiveJpeg(filePath: string): Promise<boolean> {
  const head = new Uint8Array(await Bun.file(filePath).slice(0, JPEG_SEGMENT_TABLE_BYTES).arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8) return false;
  let index = 2;
  while (index + 3 < head.length) {
    if (head[index] !== 0xff) return false;
    const marker = head[index + 1] ?? 0;
    // Padding before a marker, and the standalone markers that carry no length.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      index += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xc2) return true;
    // The scan is the last thing before entropy-coded data, which is not a
    // segment table and must not be walked as one.
    if (marker === 0xda) return false;
    const length = ((head[index + 2] ?? 0) << 8) | (head[index + 3] ?? 0);
    if (length < 2) return false;
    index += 2 + length;
  }
  return false;
}

async function normalizeVideoForPublicUpload(config: BackendConfig, inputPath: string, cacheKey: string, target?: string): Promise<string> {
  const { width, height } = await probeMediaMetadata(inputPath);
  const bounds = target ? videoBounds(target, width, height) : null;
  if (!bounds) return inputPath;
  const { maxWidth, maxHeight } = bounds;
  // Different targets can have different bounds for the same source video, so the
  // bounds must be part of the cache key: otherwise a file normalized for one
  // target's smaller limit would be silently reused (under-scaled) by another.
  const outputPath = path.join(config.MEDIA_CACHE_DIR, `${cacheKey}.${maxWidth}x${maxHeight}.normalized.mp4`);
  if (await Bun.file(outputPath).exists()) return outputPath;
  const args =
    width <= maxWidth && height <= maxHeight
      ? ["-y", "-i", inputPath, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", outputPath]
      : [
          "-y",
          "-i",
          inputPath,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-vf",
          `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-movflags",
          "+faststart",
          outputPath,
        ];
  await runFfmpeg(args);
  return outputPath;
}

async function mediaCacheKey(item: PublishMediaItem, index: number): Promise<string> {
  const localStat = item.localPath ? await fs.promises.stat(item.localPath).catch(() => null) : null;
  const identity = JSON.stringify({
    index,
    type: item.type,
    fileId: item.fileId ?? null,
    localPath: item.localPath ?? null,
    size: localStat?.size ?? null,
    modified: localStat?.mtimeMs ?? null,
  });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

async function copyIfMissing(source: string, target: string): Promise<void> {
  if (await Bun.file(target).exists()) return;
  await copyFileAtomically(source, target);
  await fs.promises.chmod(target, 0o644);
}
