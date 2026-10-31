import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { loadPublicSiteFeed } from "../public/site-read-model.js";

/** Canonical, visible pages of the publications completed in this site cycle. */
export function siteUrlsForIndexNow(config: BackendConfig, backendDb: BackendDb, publicationKeys: ReadonlySet<string>): string[] {
  if (publicationKeys.size === 0) return [];
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  return loadPublicSiteFeed(backendDb)
    .filter((post) => publicationKeys.has(post.id))
    .flatMap((post) => [
      post.has_en && post.slug_en ? `${base}/${post.post_id}/${post.slug_en}/` : null,
      post.has_ru && post.slug_ru ? `${base}/ru/${post.post_id}/${post.slug_ru}/` : null,
    ])
    .filter((url): url is string => Boolean(url));
}
