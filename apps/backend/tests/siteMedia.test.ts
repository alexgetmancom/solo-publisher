import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeSiteMedia } from "../src/delivery/site-media.js";
import { deduplicateSiteMedia } from "../src/operations/site-media-deduplicate.js";
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

    expect(initial[0]?.path).toMatch(/^media\/posts\/1-ru-0-vertical\.jpg\?v=[a-f0-9]{12}$/);
    expect(fs.readFileSync(path.join(config.SITE_PUBLIC_DIR, "media", "posts", "1-ru-0.png"))).toEqual(image);
    for (const width of [360, 640, 960])
      expect(fs.existsSync(path.join(config.SITE_PUBLIC_DIR, "generated", "responsive", `media-posts-1-ru-0-vertical-${width}.webp`))).toBe(
        true,
      );
  });

  it("does not regenerate unchanged responsive derivatives on every feed build", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const image = path.join(directory, "image.jpg");
    fs.writeFileSync(image, "source");
    const config = loadTestConfig({ DATA_DIR: directory });

    await materializeSiteMedia(config, 2, "en", [{ type: "image", local_path: image }]);
    await materializeSiteMedia(config, 2, "en", [{ type: "image", local_path: image }]);

    // one vertical projection plus its three responsive derivatives; the
    // unchanged second build must not add further work.
    expect(ffmpegCalls).toBe(4);
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

  it("keeps only the vertical video master and poster in permanent site media", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const source = path.join(directory, "source.mp4");
    fs.writeFileSync(source, "video-source");
    const config = loadTestConfig({ DATA_DIR: directory });
    const [item] = await materializeSiteMedia(config, 4, "en", [{ type: "video", local_path: source }]);
    const media = path.join(config.SITE_PUBLIC_DIR, "media", "posts");
    expect(fs.existsSync(path.join(media, "4-en-0.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(media, "4-en-0-vertical.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(media, "4-en-0-poster.jpg"))).toBe(true);
    expect(item?.path).toMatch(/^media\/posts\/4-en-0-vertical\.mp4\?v=/);
  });

  it("uses the shared Story transform for the remote site derivative", async () => {
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

    expect(requests[0]?.headers.get("x-studio-transform")).toBe("story_vertical");
    expect(requests[0]?.headers.get("x-studio-idempotency-key")).toMatch(/^[a-f0-9]{64}$/);
    expect(requests[1]?.url).toEndWith(`/standard`);
    expect(requests.some((request) => request.url.endsWith("/telegram"))).toBe(false);
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
