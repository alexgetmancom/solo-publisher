import { stat } from "node:fs/promises";
import path from "node:path";
import type { BackendDb } from "../db/client.js";
import { materializeResponsiveVariants, responsiveVariantPaths } from "../delivery/site-media.js";
import type { BackendConfig } from "../foundation/config.js";
import { loadPublicSiteFeed } from "../public/site-read-model.js";

/** Fill historical gaps using the publication worker's existing image recipe.
 * Only derivative files are written; publications and video masters stay intact. */
export async function backfillSiteResponsive(backendDb: BackendDb, config: BackendConfig, apply: boolean) {
  const sources = new Set<string>();
  for (const item of loadPublicSiteFeed(backendDb)) {
    for (const media of [...item.media, ...item.media_en]) {
      const url = media.type === "video" ? media.poster : media.path;
      if (!url) continue;
      const file = path.resolve(config.SITE_PUBLIC_DIR, url.replace(/^\/+/, "").split(/[?#]/, 1)[0] ?? "");
      if (file.startsWith(`${path.resolve(config.SITE_PUBLIC_DIR)}${path.sep}`) && /\.(png|jpe?g)$/i.test(file)) sources.add(file);
    }
  }
  const missing: string[] = [];
  for (const source of sources) {
    const info = await stat(source).catch(() => undefined);
    if (!info) continue;
    for (const variant of responsiveVariantPaths(config, source)) {
      const derivative = await stat(variant.file).catch(() => undefined);
      if (!derivative || derivative.mtimeMs < info.mtimeMs) {
        missing.push(source);
        break;
      }
    }
  }
  let rendered = 0;
  const failed: { path: string; error: string }[] = [];
  if (apply) {
    // One image at a time keeps archive work out of visitors' request path and
    // bounds CPU use on the same small container that serves the site API.
    for (const source of missing) {
      try {
        await materializeResponsiveVariants(config, source);
        rendered += 1;
      } catch (error) {
        failed.push({ path: path.relative(config.SITE_PUBLIC_DIR, source), error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return {
    ok: failed.length === 0,
    apply,
    sources: sources.size,
    missing: missing.length,
    rendered,
    remaining: missing.length - rendered,
    failed,
  };
}
