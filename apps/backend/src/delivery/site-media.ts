import fs from "node:fs";
import path from "node:path";
import {
  RESPONSIVE_WIDTHS,
  SITE_MEDIA_DIR_SEGMENTS,
  SITE_MEDIA_URL_PREFIX,
  siteMediaFilename,
  siteMediaPosterFilename,
} from "../content/site-media-naming.js";
import type { BackendConfig } from "../foundation/config.js";
import { materializeTelegramFile } from "../foundation/external/telegram-files.js";
import { fileExtension, imageExtension } from "../foundation/media-types.js";
import { runFfmpeg } from "../foundation/runtime/ffmpeg.js";
import type { PublicationLocaleSource } from "../publishing/publication-source.js";
import { copyFileAtomically, deduplicateSiteMediaFile, sha256File, temporaryPath } from "./site-media-storage.js";

type SiteMedia = Record<string, unknown> & {
  type?: string;
  file_id?: string;
  fileId?: string;
  path?: string;
  local_path?: string;
  localPath?: string;
};

/** Rebuilding a page must start with uploads, never its old viewer derivatives.
 * Thread attachments share the gallery; reviewed descriptions stay with them. */
export function siteMediaSource(source: PublicationLocaleSource): Record<string, unknown>[] {
  const originals = [...source.media, ...source.thread.flatMap((part) => part.media)];
  if (!originals.length) return source.siteMedia;
  return originals.map((item, index) => {
    const alt = source.siteMedia[index]?.alt;
    return { ...item, ...(typeof alt === "string" ? { alt } : {}) };
  });
}

/** These argument builders also run in the shipped-image smoke test. */
export function sitePosterFfmpegArgs(source: string, output: string): string[] {
  return ["-y", "-ss", "0.5", "-i", source, "-frames:v", "1", "-q:v", "2", output];
}

export function responsiveWebpFfmpegArgs(source: string, output: string, width: number): string[] {
  return ["-y", "-i", source, "-vf", `scale='min(${width},iw)':-2`, "-c:v", "libwebp", "-quality", "80", output];
}
/** Delivery projection: copy publication media into the public site. */
export async function materializeSiteMedia(
  config: BackendConfig,
  postId: number,
  locale: "ru" | "en",
  raw: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>[]> {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const directory = path.join(config.SITE_PUBLIC_DIR, ...SITE_MEDIA_DIR_SEGMENTS);
  const mediaRoot = path.join(config.SITE_PUBLIC_DIR, "media");
  await fs.promises.mkdir(directory, { recursive: true });
  const result: Record<string, unknown>[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index] as SiteMedia;
    const kind = String(item.type ?? "image").toLowerCase() === "video" ? "video" : "image";
    const extension = mediaExtension(item, kind);
    const filename = siteMediaFilename(postId, locale, index, extension);
    const target = path.join(directory, filename);
    await copyOrDownload(config, item, target, fetchImpl);
    await fs.promises.chmod(target, 0o664);
    await deduplicateSiteMediaFile(mediaRoot, target);
    const output: Record<string, unknown> = {
      ...item,
      type: kind,
      // Public media is intentionally long-lived in browser/CDN caches. A content
      // version keeps a replacement from reusing the previous image URL.
      // Articles keep the uploaded image or video in its original proportions.
      path: await versionedPublicPath(`${SITE_MEDIA_URL_PREFIX}/${filename}`, target),
    };
    if (kind === "video") {
      const posterName = siteMediaPosterFilename(postId, locale, index);
      const poster = path.join(directory, posterName);
      const temporary = temporaryPath(poster);
      try {
        await runFfmpeg(sitePosterFfmpegArgs(target, temporary));
        await fs.promises.rename(temporary, poster);
      } finally {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
      }
      await fs.promises.chmod(poster, 0o664);
      await deduplicateSiteMediaFile(mediaRoot, poster);
      await materializeResponsiveVariants(config, poster);
      output.poster = await versionedPublicPath(`${SITE_MEDIA_URL_PREFIX}/${posterName}`, poster);
    } else {
      await materializeResponsiveVariants(config, target);
    }
    result.push(output);
  }
  return result;
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
  const source = stringValue(item.local_path) || stringValue(item.localPath) || stringValue(item.path);
  if (kind === "video") {
    const extension = fileExtension(source);
    return [".mp4", ".mov", ".webm"].includes(extension) ? extension.slice(1) : "mp4";
  }
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

/** Responsive derivatives are current when they are no older than their source. */
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
