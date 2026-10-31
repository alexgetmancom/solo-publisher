import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { imageSizeFromFile } from "image-size/fromFile";
import { RESPONSIVE_WIDTHS } from "../content/site-media-naming.js";

type ImageInfo = { width: number; height: number; modified: number; size: number };
type Variant = { path: string; width: number; height: number };
const images = new Map<string, Promise<ImageInfo | undefined>>();

/** Read the served file, not the dimensions of the upload it was made from.
 * Missing derivatives are not cached: the publication worker may still write them. */
export async function siteImage(root: string, publicPath: string) {
  const relative = publicPath.replace(/^\/+/, "").split(/[?#]/, 1)[0] ?? "";
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) return undefined;
  const query = new URL(publicPath, "https://site.invalid/").search;
  const source = await imageInfo(file, query);
  if (!source) return undefined;
  const version = query || `?v=${createHash("sha256").update(`${source.modified}:${source.size}`).digest("hex").slice(0, 12)}`;
  const basename = relative.replace(/[\\/]/g, "-").replace(/\.[a-z0-9]+$/i, "");
  const responsive: (Variant & { nominal: number })[] = [];
  await Promise.all(
    RESPONSIVE_WIDTHS.map(async (width) => {
      const url = `/generated/responsive/${basename}-${width}.webp`;
      const variantFile = path.join(root, url);
      const variant = await imageInfo(variantFile, version);
      if (!variant) return;
      if (variant.modified < source.modified) {
        images.delete(`${variantFile}${version}`);
        return;
      }
      responsive.push({ path: `${url}${version}`, width: variant.width, height: variant.height, nominal: width });
    }),
  );
  // Small sources can produce equal actual widths at several nominal sizes.
  // Keep the smallest name deterministically so async IO cannot churn the ETag.
  responsive.sort((a, b) => a.width - b.width || a.nominal - b.nominal);
  return {
    width: source.width,
    height: source.height,
    responsive: responsive
      .filter((variant, index) => index === 0 || variant.width !== responsive[index - 1]?.width)
      .map(({ nominal: _nominal, ...variant }) => variant),
  };
}

async function imageInfo(file: string, version: string): Promise<ImageInfo | undefined> {
  // Historical URLs have no content version. Check their timestamp so a later
  // replacement also changes the browser cache key of their derivatives.
  const unversioned = version ? undefined : await stat(file).catch(() => undefined);
  const key = `${file}${version || `?mtime=${unversioned?.mtimeMs}&size=${unversioned?.size}`}`;
  const cached = images.get(key);
  if (cached) return cached;
  const pending = Promise.all([imageSizeFromFile(file), stat(file)])
    .then(([size, info]) => {
      // EXIF orientation can exchange the displayed axes.
      const rotated = size.orientation !== undefined && size.orientation >= 5;
      return {
        width: rotated ? size.height : size.width,
        height: rotated ? size.width : size.height,
        modified: info.mtimeMs,
        size: info.size,
      };
    })
    .catch(() => {
      images.delete(key);
      return undefined;
    });
  images.set(key, pending);
  return pending;
}
