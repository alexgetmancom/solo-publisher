import fs from "node:fs";
import path from "node:path";
import {
  RESPONSIVE_WIDTHS,
  SITE_MEDIA_DIR_SEGMENTS,
  SITE_MEDIA_URL_PREFIX,
  siteMediaFilename,
  siteMediaPosterFilename,
  siteMediaVerticalFilename,
} from "../content/site-media-naming.js";
import type { BackendConfig } from "../foundation/config.js";
import { materializeTelegramFile } from "../foundation/external/telegram-files.js";
import { imageExtension } from "../foundation/media-types.js";
import { runFfmpeg } from "../foundation/runtime/ffmpeg.js";
import { processVerticalMediaRemotely } from "./remote-media-processor.js";
import {
  copyFileAtomically,
  deduplicateSiteMediaFile,
  removeDeduplicatedSiteMediaFile,
  sha256File,
  temporaryPath,
} from "./site-media-storage.js";

type SiteMedia = Record<string, unknown> & {
  type?: string;
  file_id?: string;
  fileId?: string;
  path?: string;
  local_path?: string;
  localPath?: string;
};

/**
 * The three ffmpeg recipes this module runs *inside the backend container*,
 * as pure argument builders.
 *
 * They are exported so scripts/image-smoke.ts can execute the real arguments
 * against the ffmpeg the image actually ships. That coverage exists nowhere
 * else: tests/stories.test.ts mocks the whole ffmpeg module and only inspects
 * argument lists, and the binary comes from a pinned external image
 * (mwader/static-ffmpeg), so a bump could drop an encoder — libwebp below is
 * the fragile one — without a single test noticing.
 *
 * Note that only the vertical composite honours MEDIA_PROCESSOR_PROVIDER; the
 * poster frame and the responsive variants run locally on every publication
 * with media, whatever VM-106 is doing.
 */
export function sitePosterFfmpegArgs(vertical: string, output: string): string[] {
  return ["-y", "-ss", "0.5", "-i", vertical, "-frames:v", "1", "-q:v", "2", output];
}

export function siteVerticalFfmpegArgs(source: string, output: string, kind: "image" | "video"): string[] {
  return [
    "-y",
    "-i",
    source,
    "-vf",
    "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
    ...(kind === "video"
      ? ["-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-c:a", "copy"]
      : ["-frames:v", "1", "-q:v", "2"]),
    output,
  ];
}

export function responsiveWebpFfmpegArgs(source: string, output: string, width: number): string[] {
  return ["-y", "-i", source, "-vf", `scale='min(${width},iw)':-2`, "-c:v", "libwebp", "-quality", "80", output];
}
type SiteMediaMaterializeOptions = {
  maxUploadKbps?: number;
  /** Archive image backfills retain the source album indices while skipping videos. */
  imageOnly?: boolean;
};

/** Delivery projection: copy publication media into the public site. */
export async function materializeSiteMedia(
  config: BackendConfig,
  postId: number,
  locale: "ru" | "en",
  raw: unknown,
  fetchImpl: typeof fetch = fetch,
  options: SiteMediaMaterializeOptions = {},
): Promise<Record<string, unknown>[]> {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const directory = path.join(config.SITE_PUBLIC_DIR, ...SITE_MEDIA_DIR_SEGMENTS);
  const mediaRoot = path.join(config.SITE_PUBLIC_DIR, "media");
  await fs.promises.mkdir(directory, { recursive: true });
  const result: Record<string, unknown>[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index] as SiteMedia;
    const kind = String(item.type ?? "image").toLowerCase() === "video" ? "video" : "image";
    if (options.imageOnly && kind === "video") continue;
    const extension = mediaExtension(item, kind);
    const filename = siteMediaFilename(postId, locale, index, extension);
    const target = path.join(directory, filename);
    await copyOrDownload(config, item, target, fetchImpl);
    await fs.promises.chmod(target, 0o664);
    await deduplicateSiteMediaFile(mediaRoot, target);
    const verticalName = siteMediaVerticalFilename(postId, locale, index, kind);
    const vertical = path.join(directory, verticalName);
    if (item.role === "text_story_card") await copyFileAtomically(target, vertical);
    else await materializeVerticalViewerMedia(config, target, vertical, kind, options, fetchImpl);
    await deduplicateSiteMediaFile(mediaRoot, vertical);
    const output: Record<string, unknown> = {
      ...item,
      type: kind,
      // Public media is intentionally long-lived in browser/CDN caches. A content
      // version keeps a replacement from reusing the previous image URL.
      // The web Story player always receives the pre-composited 9:16 file.
      path: await versionedPublicPath(`${SITE_MEDIA_URL_PREFIX}/${verticalName}`, vertical),
    };
    if (kind === "video") {
      const posterName = siteMediaPosterFilename(postId, locale, index);
      const poster = path.join(directory, posterName);
      const temporary = temporaryPath(poster);
      try {
        await runFfmpeg(sitePosterFfmpegArgs(vertical, temporary));
        await fs.promises.rename(temporary, poster);
      } finally {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
      }
      await fs.promises.chmod(poster, 0o664);
      await deduplicateSiteMediaFile(mediaRoot, poster);
      await materializeResponsiveVariants(config, poster);
      output.poster = await versionedPublicPath(`${SITE_MEDIA_URL_PREFIX}/${posterName}`, poster);
      // The source file has no public consumer after its vertical master and
      // poster exist. Keep the original only in the bounded media cache, not
      // indefinitely in site storage beside the browser-facing projection.
      await removeDeduplicatedSiteMediaFile(mediaRoot, target);
    } else {
      await materializeResponsiveVariants(config, vertical);
    }
    result.push(output);
  }
  return result;
}

async function materializeVerticalViewerMedia(
  config: BackendConfig,
  source: string,
  output: string,
  kind: "image" | "video",
  options: SiteMediaMaterializeOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (await isCurrentDerivative(source, output)) return;
  if (config.MEDIA_PROCESSOR_PROVIDER !== "remote_http") {
    // Explicit local mode remains usable for self-hosters without VM-106. The
    // production route below owns the blurred composite; this CPU recipe keeps
    // the same 9:16 no-crop contract.
    const temporary = temporaryPath(output);
    try {
      await runFfmpeg(siteVerticalFfmpegArgs(source, temporary, kind));
      await fs.promises.rename(temporary, output);
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
    return;
  }
  await processVerticalMediaRemotely({
    config,
    source,
    kind,
    variants: [{ name: "standard", output }],
    timeoutMs: config.MEDIA_PROCESSOR_TIMEOUT_SECONDS * 1000,
    fetchImpl,
    ...(options.maxUploadKbps ? { uploadBody: throttledFileStream(source, options.maxUploadKbps) } : {}),
  });
}

/** Bulk archive work crosses the VPS ↔ home-VM link. Throttle only that
 * opt-in path so routine post delivery remains fast while a maintenance run
 * cannot starve the home VPN/uplink. */
function throttledFileStream(file: string, maxUploadKbps: number): ReadableStream<Uint8Array> {
  const bytesPerSecond = Math.max(1, Math.floor(maxUploadKbps * 1024));
  const reader = Bun.file(file).stream().getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil((value.byteLength / bytesPerSecond) * 1000)));
    },
    cancel: () => reader.cancel(),
  });
}

async function versionedPublicPath(publicPath: string, filePath: string): Promise<string> {
  return `${publicPath}?v=${(await sha256File(filePath)).slice(0, 12)}`;
}

/** Create the variants before a post is exposed in the public feed. The web
 * route must only serve these files: spawning ffmpeg while handling visitors
 * previously let a cache-miss burst exhaust the small production container. */
export function responsiveVariantPaths(config: BackendConfig, source: string) {
  if (!/\.(png|jpe?g)$/i.test(source)) return [];
  const relative = path.relative(config.SITE_PUBLIC_DIR, source).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("site media source escapes public directory");
  const basename = relative.replace(/[\\/]/g, "-").replace(/\.[a-z0-9]+$/i, "");
  const outputDir = path.join(config.SITE_PUBLIC_DIR, "generated", "responsive");
  return RESPONSIVE_WIDTHS.map((width) => ({ width, file: path.join(outputDir, `${basename}-${width}.webp`) }));
}

export async function materializeResponsiveVariants(config: BackendConfig, source: string): Promise<void> {
  const variants = responsiveVariantPaths(config, source);
  if (!variants.length) return;
  const outputDir = path.join(config.SITE_PUBLIC_DIR, "generated", "responsive");
  await fs.promises.mkdir(outputDir, { recursive: true });

  for (const { width, file: output } of variants) {
    // A WebP derivative is intentionally a different size from its JPG/PNG
    // source. Comparing sizes here made every site build regenerate every
    // responsive image in the archive and blocked newly published posts behind
    // that needless work. For a derivative, source mtime is the freshness key.
    if (await isCurrentDerivative(source, output)) continue;
    const temporary = `${output}.tmp-${process.pid}-${Date.now()}.webp`;
    try {
      await runFfmpeg(responsiveWebpFfmpegArgs(source, temporary, width));
      await fs.promises.chmod(temporary, 0o664);
      await fs.promises.rename(temporary, output);
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

function mediaExtension(item: SiteMedia, kind: "image" | "video"): string {
  if (kind === "video") return "mp4";
  const source = stringValue(item.local_path) || stringValue(item.localPath) || stringValue(item.path);
  return (imageExtension(source) ?? ".jpg").slice(1);
}

async function copyOrDownload(config: BackendConfig, item: SiteMedia, target: string, fetchImpl: typeof fetch): Promise<void> {
  const local = stringValue(item.local_path) || stringValue(item.localPath);
  if (local && fs.existsSync(local)) {
    if (await isCurrentCopy(local, target)) return;
    await copyFileAtomically(local, target);
    return;
  }
  const existingPath = stringValue(item.path);
  if (existingPath) {
    const absolute = path.isAbsolute(existingPath) ? existingPath : path.join(config.SITE_PUBLIC_DIR, existingPath.replace(/^\/+/, ""));
    if (fs.existsSync(absolute)) {
      if (await isCurrentCopy(absolute, target)) return;
      await copyFileAtomically(absolute, target);
      return;
    }
  }
  const fileId = stringValue(item.file_id) || stringValue(item.fileId);
  if (!fileId) throw new Error("site media has no file_id or local path");
  await materializeTelegramFile(config, { fileId }, { target, fetchImpl });
}

async function isCurrentCopy(source: string, target: string): Promise<boolean> {
  if (path.resolve(source) === path.resolve(target)) return true;
  try {
    const [sourceStat, targetStat] = await Promise.all([fs.promises.stat(source), fs.promises.stat(target)]);
    return sourceStat.size === targetStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

/** A derivative (responsive variant, vertical composite) is current when it is
 * no older than its source; both callers only compare mtimes, never size. */
async function isCurrentDerivative(source: string, target: string): Promise<boolean> {
  try {
    const [sourceStat, targetStat] = await Promise.all([fs.promises.stat(source), fs.promises.stat(target)]);
    return targetStat.mtimeMs >= sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
