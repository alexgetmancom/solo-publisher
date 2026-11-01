/** Shared naming convention for publication media materialized onto the public site.
 * `materializeSiteMedia` (delivery/site-media.ts) writes files using these names; the
 * public site read model (public/site-read-model.ts) synthesizes the same names as a
 * fallback for legacy rows whose stored media JSON predates having its own `path`.
 * Keep both callers in sync with this file rather than duplicating the convention. */

/** Filesystem/URL directory segment holding materialized post media, relative to the site public root. */
export const SITE_MEDIA_DIR_SEGMENTS = ["media", "posts"] as const;
export const SITE_MEDIA_URL_PREFIX = SITE_MEDIA_DIR_SEGMENTS.join("/");
// The article column is 680 CSS pixels; common phone DPRs need the steps
// around 720 and 800, while 1280 also covers larger article images.
export const RESPONSIVE_WIDTHS = [360, 480, 640, 720, 800, 960, 1280] as const;

function siteMediaBaseName(postId: number, locale: "ru" | "en", index: number): string {
  return `${postId}-${locale}-${index}`;
}

export function siteMediaFilename(postId: number, locale: "ru" | "en", index: number, extension: string): string {
  return `${siteMediaBaseName(postId, locale, index)}.${extension}`;
}

export function siteMediaPosterFilename(postId: number, locale: "ru" | "en", index: number): string {
  return `${siteMediaBaseName(postId, locale, index)}-original-poster.jpg`;
}
