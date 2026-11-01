import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESPONSIVE_WIDTHS } from "../src/content/site-media-naming.js";
import { postLocales } from "../src/db/schema.js";
import { materializeSiteMedia } from "../src/delivery/site-media.js";
import { backfillSiteMedia } from "../src/operations/site-media-backfill.js";
import { deduplicateSiteMedia } from "../src/operations/site-media-deduplicate.js";
import { backfillSiteResponsive } from "../src/operations/site-responsive-backfill.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

let ffmpegCalls = 0;
const realFfmpeg = await import("../src/foundation/runtime/ffmpeg.js");
mock.module("../src/foundation/runtime/ffmpeg.js", () => ({
  ...realFfmpeg,
  runFfmpeg: async (args: string[]) => {
    ffmpegCalls += 1;
    const outputs = args.filter((arg) => /\.(mp4|jpg|webp)$/.test(arg) && arg !== args[args.indexOf("-i") + 1]);
    if (!outputs.length) throw new Error("missing responsive output path");
    for (const output of outputs) fs.writeFileSync(output, "encoded media");
  },
}));

let directory: string | null = null;

afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = null;
  ffmpegCalls = 0;
});

describe("site media materialization", () => {
  it("restores recent mixed galleries from uploads and retains reviewed descriptions", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "site-originals-backfill-"));
    const config = loadTestConfig({ DATA_DIR: directory });
    const db = openBackendDb(":memory:");
    try {
      const photo = path.join(directory, "photo.png");
      const video = path.join(directory, "video.mp4");
      fs.writeFileSync(photo, "square-upload");
      fs.writeFileSync(video, "landscape-upload");
      const media = [
        { type: "image", local_path: photo },
        { type: "video", local_path: video },
      ];
      const stored = [
        { type: "image", path: "media/posts/2-ru-0-vertical.jpg?v=old", alt: "Reviewed description" },
        { type: "video", path: "media/posts/2-ru-1-vertical.mp4?v=old", poster: "media/posts/2-ru-1-poster.jpg" },
      ];
      seedTextPost(db, { postId: 1, ru: "Older", siteRu: true, mediaRu: media, siteMediaRu: stored });
      seedTextPost(db, {
        postId: 2,
        ru: "Recent",
        en: "Translation",
        siteRu: true,
        siteEn: true,
        mediaRu: media,
        siteMediaRu: stored,
        siteMediaEn: stored,
      });
      expect(await backfillSiteMedia(db, config, false, 1)).toMatchObject({ posts: 1, locale_projections: 2, changed: 0, remaining: 3 });
      expect(ffmpegCalls).toBe(0);
      expect(await backfillSiteMedia(db, config, true, 1)).toMatchObject({ ok: true, changed: 2, remaining: 1 });
      const rows = db.db.select().from(postLocales).all();
      const recent = rows.filter((row) => row.draftId === 2);
      for (const row of recent) {
        expect(row.siteMediaJson).toHaveLength(2);
        expect(row.siteMediaJson?.[0]).toMatchObject({ type: "image", alt: "Reviewed description" });
        expect(row.siteMediaJson?.[0]?.path).toMatch(new RegExp(`^media/posts/2-${row.locale}-0\\.png\\?v=`));
        expect(row.siteMediaJson?.[1]?.path).toMatch(new RegExp(`^media/posts/2-${row.locale}-1\\.mp4\\?v=`));
        expect(fs.readFileSync(path.join(config.SITE_PUBLIC_DIR, `media/posts/2-${row.locale}-0.png`), "utf8")).toBe("square-upload");
      }
      expect(rows.find((row) => row.draftId === 1 && row.locale === "ru")?.siteMediaJson).toEqual(stored);
      expect(await backfillSiteMedia(db, config, true, 1)).toMatchObject({ ok: true, changed: 1, remaining: 0 });
      expect(await backfillSiteMedia(db, config, true, 1)).toMatchObject({ changed: 0, remaining: 0 });
    } finally {
      db.close();
    }
  });

  it("leaves a gallery intact when any original attachment cannot be recovered", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "site-originals-backfill-"));
    const config = loadTestConfig({ DATA_DIR: directory });
    const db = openBackendDb(":memory:");
    try {
      const stored = [{ type: "image", path: "media/posts/1-ru-0-vertical.jpg?v=old" }];
      seedTextPost(db, {
        postId: 1,
        ru: "Published",
        siteRu: true,
        mediaRu: [{ type: "image", local_path: path.join(directory, "missing.jpg") }],
        siteMediaRu: stored,
      });
      const result = await backfillSiteMedia(db, config, true, 1);
      expect(result).toMatchObject({ ok: false, changed: 0, remaining: 1 });
      expect(result.failed).toHaveLength(1);
      expect(
        db.db
          .select()
          .from(postLocales)
          .all()
          .find((row) => row.locale === "ru")?.siteMediaJson,
      ).toEqual(stored);
    } finally {
      db.close();
    }
  });

  it("backfills both locale galleries and posters without changing their originals or videos", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "site-responsive-backfill-"));
    const config = loadTestConfig({ DATA_DIR: directory });
    const db = openBackendDb(path.join(directory, "pipeline.db"), 5000);
    try {
      fs.mkdirSync(path.join(config.SITE_PUBLIC_DIR, "media"), { recursive: true });
      for (const file of ["photo.jpg", "poster.jpg", "video.mp4"])
        fs.writeFileSync(path.join(config.SITE_PUBLIC_DIR, "media", file), "original");
      const media = [
        { type: "image", path: "media/photo.jpg" },
        { type: "video", path: "media/video.mp4", poster: "media/poster.jpg" },
      ];
      seedTextPost(db, { postId: 1, en: "English", ru: "Русский", siteEn: true, siteRu: true, siteMediaEn: media, siteMediaRu: media });
      expect(await backfillSiteResponsive(db, config, false)).toMatchObject({ missing: 2, rendered: 0 });
      expect(ffmpegCalls).toBe(0);
      expect(await backfillSiteResponsive(db, config, true)).toMatchObject({ ok: true, rendered: 2, remaining: 0 });
      expect(ffmpegCalls).toBe(2 * RESPONSIVE_WIDTHS.length);
      expect(await backfillSiteResponsive(db, config, false)).toMatchObject({ missing: 0 });
      for (const file of ["photo.jpg", "poster.jpg", "video.mp4"])
        expect(fs.readFileSync(path.join(config.SITE_PUBLIC_DIR, "media", file), "utf8")).toBe("original");
    } finally {
      db.close();
    }
  });

  it("replaces stable media files and preserves a known source extension", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const first = path.join(directory, "first.png");
    const second = path.join(directory, "second.png");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(first, image);
    fs.writeFileSync(second, image);
    const config = loadTestConfig({ DATA_DIR: directory });

    const initial = await materializeSiteMedia(config, 1, "ru", [{ type: "image", local_path: first }]);
    await materializeSiteMedia(config, 1, "ru", [{ type: "image", local_path: second }]);

    expect(initial[0]?.path).toMatch(/^media\/posts\/1-ru-0\.png\?v=[a-f0-9]{12}$/);
    expect(fs.readFileSync(path.join(config.SITE_PUBLIC_DIR, "media", "posts", "1-ru-0.png"))).toEqual(image);
    for (const width of RESPONSIVE_WIDTHS)
      expect(fs.existsSync(path.join(config.SITE_PUBLIC_DIR, "generated", "responsive", `media-posts-1-ru-0-${width}.webp`))).toBe(true);
  });

  it("does not regenerate unchanged responsive derivatives on every feed build", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const image = path.join(directory, "image.jpg");
    fs.writeFileSync(image, "source");
    const config = loadTestConfig({ DATA_DIR: directory });

    await materializeSiteMedia(config, 2, "en", [{ type: "image", local_path: image }]);
    await materializeSiteMedia(config, 2, "en", [{ type: "image", local_path: image }]);

    // The unchanged second build must not add further work.
    expect(ffmpegCalls).toBe(RESPONSIVE_WIDTHS.length);
  });

  it("shares equal locale files and atomically detaches a later replacement", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const first = path.join(directory, "first.jpg");
    const changed = path.join(directory, "changed.jpg");
    fs.writeFileSync(first, "same-source");
    fs.writeFileSync(changed, "new-source");
    const config = loadTestConfig({ DATA_DIR: directory });
    await materializeSiteMedia(config, 3, "ru", [{ type: "image", local_path: first }]);
    await materializeSiteMedia(config, 3, "en", [{ type: "image", local_path: first }]);
    const ru = path.join(config.SITE_PUBLIC_DIR, "media", "posts", "3-ru-0.jpg");
    const en = path.join(config.SITE_PUBLIC_DIR, "media", "posts", "3-en-0.jpg");
    expect(fs.statSync(ru).ino).toBe(fs.statSync(en).ino);
    await materializeSiteMedia(config, 3, "ru", [{ type: "image", local_path: changed }]);
    expect(fs.readFileSync(ru, "utf8")).toBe("new-source");
    expect(fs.readFileSync(en, "utf8")).toBe("same-source");
    expect(fs.statSync(ru).ino).not.toBe(fs.statSync(en).ino);
  });

  it("keeps the original video and draws its poster without vertical padding", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const source = path.join(directory, "source.mp4");
    fs.writeFileSync(source, "video-source");
    const config = loadTestConfig({ DATA_DIR: directory });
    const [item] = await materializeSiteMedia(config, 4, "en", [{ type: "video", local_path: source }]);
    const media = path.join(config.SITE_PUBLIC_DIR, "media", "posts");
    expect(fs.existsSync(path.join(media, "4-en-0.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(media, "4-en-0-vertical.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(media, "4-en-0-original-poster.jpg"))).toBe(true);
    expect(item?.path).toMatch(/^media\/posts\/4-en-0\.mp4\?v=/);
  });

  it("does not send article media to the remote Story processor", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const source = path.join(directory, "source.mp4");
    fs.writeFileSync(source, "video-source");
    const requests: Request[] = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST") return Response.json({ outputs: { standard: { bytes: 8 }, telegram: { bytes: 4 } } });
      return new Response("standard");
    }) as unknown as typeof fetch;
    const config = loadTestConfig({
      DATA_DIR: directory,
      MEDIA_PROCESSOR_PROVIDER: "remote_http",
      MEDIA_PROCESSOR_URL: "http://processor",
      MEDIA_PROCESSOR_TOKEN: "x".repeat(16),
    });

    await materializeSiteMedia(config, 5, "en", [{ type: "video", local_path: source }], fetchImpl);

    expect(requests).toHaveLength(0);
    expect(fs.readFileSync(path.join(config.SITE_PUBLIC_DIR, "media/posts/5-en-0.mp4"), "utf8")).toBe("video-source");
  });

  it("migrates historical URLs without changing their paths or bytes", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const config = loadTestConfig({ DATA_DIR: directory });
    const media = path.join(config.SITE_PUBLIC_DIR, "media");
    const posts = path.join(media, "posts");
    fs.mkdirSync(posts, { recursive: true });
    const legacy = path.join(media, "35.mp4");
    const current = path.join(posts, "35-en-0.mp4");
    fs.writeFileSync(legacy, "historical-video");
    fs.writeFileSync(current, "historical-video");
    expect(await deduplicateSiteMedia(config, false)).toMatchObject({ files: 2, legacy_url_files: 1, reclaimable_bytes: 16 });
    await deduplicateSiteMedia(config, true);
    expect(fs.readFileSync(legacy, "utf8")).toBe("historical-video");
    expect(fs.readFileSync(current, "utf8")).toBe("historical-video");
    expect(fs.statSync(legacy).ino).toBe(fs.statSync(current).ino);
    expect(await deduplicateSiteMedia(config, false)).toMatchObject({ reclaimable_bytes: 0, logical_duplicate_bytes: 16 });
  });
});
