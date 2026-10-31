import { stat } from "node:fs/promises";
import path from "node:path";
import { imageSizeFromFile } from "image-size/fromFile";
import { RESPONSIVE_WIDTHS } from "../content/site-media-naming.js";

type ImageInfo = { width: number; height: number; modified: number };
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
  const basename = relative.replace(/[\\/]/g, "-").replace(/\.[a-z0-9]+$/i, "");
  const responsive: Variant[] = [];
  await Promise.all(
    RESPONSIVE_WIDTHS.map(async (width) => {
      const url = `/generated/responsive/${basename}-${width}.webp`;
      const variantFile = path.join(root, url);
      const variant = await imageInfo(variantFile, query);
      if (!variant) return;
      if (variant.modified < source.modified) {
        images.delete(`${variantFile}${query}`);
        return;
      }
      responsive.push({ path: `${url}${query}`, width: variant.width, height: variant.height });
    }),
  );
  responsive.sort((a, b) => a.width - b.width);
  return {
    width: source.width,
    height: source.height,
    responsive: responsive.filter((variant, index) => index === 0 || variant.width !== responsive[index - 1]?.width),
  };
}

function imageInfo(file: string, version: string): Promise<ImageInfo | undefined> {
  const key = `${file}${version}`;
  const cached = images.get(key);
  if (cached) return cached;
  const pending = Promise.all([imageSizeFromFile(file), stat(file)])
    .then(([size, info]) => {
      // EXIF orientation can exchange the displayed axes.
      const rotated = size.orientation !== undefined && size.orientation >= 5;
      return { width: rotated ? size.height : size.width, height: rotated ? size.width : size.height, modified: info.mtimeMs };
    })
    .catch(() => {
      images.delete(key);
      return undefined;
    });
  images.set(key, pending);
  return pending;
}
