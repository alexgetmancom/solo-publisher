import { expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { siteImage } from "../src/public/site-images.js";

it("finds a derivative written after the first read and rejects an older generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "site-images-"));
  try {
    await mkdir(join(root, "media"));
    await mkdir(join(root, "generated/responsive"), { recursive: true });
    const source = join(root, "media/photo.jpg");
    const variant = join(root, "generated/responsive/media-photo-360.webp");
    const bytes = await sharp({ create: { width: 360, height: 640, channels: 3, background: "white" } })
      .webp()
      .toBuffer();
    await writeFile(source, bytes);
    await utimes(source, 200, 200);
    expect((await siteImage(root, "media/photo.jpg?v=current"))?.responsive).toEqual([]);

    await writeFile(variant, bytes);
    await utimes(variant, 100, 100);
    expect((await siteImage(root, "media/photo.jpg?v=current"))?.responsive).toEqual([]);

    await utimes(variant, 300, 300);
    expect((await siteImage(root, "media/photo.jpg?v=current"))?.responsive).toEqual([
      { path: "/generated/responsive/media-photo-360.webp?v=current", width: 360, height: 640 },
    ]);
    expect(await siteImage(root, "../outside.jpg")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
