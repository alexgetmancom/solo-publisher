import { expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { RESPONSIVE_WIDTHS } from "../src/content/site-media-naming.js";
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
    const historical = (await siteImage(root, "media/photo.jpg"))?.responsive[0]?.path;
    expect(historical).toMatch(/\?v=[a-f0-9]{12}$/);
    await utimes(source, 400, 400);
    await utimes(variant, 500, 500);
    expect((await siteImage(root, "media/photo.jpg"))?.responsive[0]?.path).not.toBe(historical);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reuses complete image descriptions but rechecks replaced historical images", async () => {
  const root = await mkdtemp(join(tmpdir(), "site-images-complete-"));
  try {
    await mkdir(join(root, "media"));
    await mkdir(join(root, "generated/responsive"), { recursive: true });
    const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } })
      .webp()
      .toBuffer();
    const source = join(root, "media/photo.jpg");
    await writeFile(source, bytes);
    for (const width of RESPONSIVE_WIDTHS) await writeFile(join(root, `generated/responsive/media-photo-${width}.webp`), bytes);
    const first = await siteImage(root, "media/photo.jpg?v=abcdef012345");
    expect(await siteImage(root, "media/photo.jpg?v=abcdef012345")).toBe(first);
    // Small sources have one actual width, despite all publication sizes
    // being present. That complete set must still be reusable.
    expect(first?.responsive).toEqual([{ path: "/generated/responsive/media-photo-360.webp?v=abcdef012345", width: 100, height: 100 }]);
    const historical = await siteImage(root, "media/photo.jpg");
    expect(await siteImage(root, "media/photo.jpg")).toBe(historical);
    await utimes(source, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
    expect((await siteImage(root, "media/photo.jpg"))?.responsive).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
