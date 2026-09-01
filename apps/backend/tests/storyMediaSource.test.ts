import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateStoryMedia } from "../src/delivery/story-media.js";
import type { BackendConfig } from "../src/foundation/config.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/** These cases are about how the source is found, not about the encode, and the
 * real recipe needs a real image. stories.test.ts covers the ffmpeg arguments. */
mock.module("../src/foundation/runtime/ffmpeg.js", () => ({
  runFfmpeg: async (args: string[]) => {
    const output = args.at(-1);
    if (!output) throw new Error("ffmpeg output path is missing");
    fs.writeFileSync(output, "encoded story");
  },
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-source-"));
  roots.push(root);
  return root;
}

function config(root: string, overrides: Record<string, string> = {}) {
  return loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "bot-token", DATA_DIR: root, ...overrides });
}

/** A real 2x2 JPEG: the encode is mocked, but the local executor probes the
 * source before it to decide the blurred backdrop, and a probe wants an image. */
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAACAEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AJ/AB//Z",
  "base64",
);

describe("generateStoryMedia input validation", () => {
  it("refuses anything but exactly one media item", async () => {
    const root = tempRoot();
    const item = { type: "photo", local_path: path.join(root, "a.jpg") };

    await expect(generateStoryMedia([], 1, "ru", config(root))).rejects.toThrow("supports one media item");
    await expect(generateStoryMedia([item, item], 1, "ru", config(root))).rejects.toThrow("supports one media item");
    await expect(generateStoryMedia(null, 1, "ru", config(root))).rejects.toThrow("supports one media item");
  });

  it("refuses a media kind a story cannot carry", async () => {
    const root = tempRoot();

    await expect(generateStoryMedia([{ type: "document", local_path: "/tmp/a.pdf" }], 1, "ru", config(root))).rejects.toThrow(
      "supports photo or video media",
    );
    await expect(generateStoryMedia([{ local_path: "/tmp/a.pdf" }], 1, "ru", config(root))).rejects.toThrow(
      "supports photo or video media",
    );
  });

  it("fails when there is neither a usable local file nor a Telegram file id", async () => {
    const root = tempRoot();

    await expect(generateStoryMedia([{ type: "photo" }], 1, "ru", config(root))).rejects.toThrow("Cannot resolve story source media");
    // A relative path is not usable: the worker's cwd is not the media root.
    await expect(generateStoryMedia([{ type: "photo", local_path: "relative/a.jpg" }], 1, "ru", config(root))).rejects.toThrow(
      "Cannot resolve story source media",
    );
    // Neither is a path that no longer exists.
    await expect(generateStoryMedia([{ type: "photo", local_path: path.join(root, "gone.jpg") }], 1, "ru", config(root))).rejects.toThrow(
      "Cannot resolve story source media",
    );
  });
});

describe("generateStoryMedia source resolution", () => {
  it("uses an existing absolute local file without calling Telegram", async () => {
    const root = tempRoot();
    const source = path.join(root, "source.jpg");
    fs.writeFileSync(source, JPEG);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const [item] = await generateStoryMedia([{ type: "photo", local_path: source }], 7, "en", config(root), fetchImpl);

    expect(called).toBe(false);
    expect(String(item?.storyLocalPath)).toContain("draft-7-en-story-standard-");
    expect(item).toMatchObject({ story_width: 1080, story_height: 1920 });
    expect(fs.existsSync(String(item?.storyLocalPath))).toBe(true);
  });

  it("downloads by file id when there is no local file, and keeps the source extension", async () => {
    const root = tempRoot();
    const urls: string[] = [];
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: "photos/file_1.jpg" } });
      return new Response(JPEG);
    }) as unknown as typeof fetch;

    const [item] = await generateStoryMedia([{ type: "photo", file_id: "AgACAgIA" }], 9, "ru", config(root), fetchImpl);

    expect(urls[0]).toBe("https://api.telegram.org/botbot-token/getFile");
    expect(urls[1]).toBe("https://api.telegram.org/file/botbot-token/photos/file_1.jpg");
    expect(fs.existsSync(path.join(root, "story-media", "draft-9-ru-source.jpg"))).toBe(true);
    expect(item?.storyLocalPath).toBeString();
  });

  it("reads a local bot-api absolute file_path in place instead of downloading it", async () => {
    // The self-hosted bot API returns a path on the shared volume; downloading it
    // over HTTP would copy a file that is already on disk.
    const root = tempRoot();
    const source = path.join(root, "already-here.jpg");
    fs.writeFileSync(source, JPEG);
    const urls: string[] = [];
    const fetchImpl = (async (input: URL | RequestInfo) => {
      urls.push(String(input));
      return Response.json({ ok: true, result: { file_path: source } });
    }) as unknown as typeof fetch;

    await generateStoryMedia([{ type: "photo", file_id: "AgACAgIA" }], 3, "ru", config(root), fetchImpl);

    expect(urls).toHaveLength(1);
  });

  it("fails loudly when Telegram rejects getFile or the download", async () => {
    const root = tempRoot();
    const notOk = (async () => Response.json({ ok: false, description: "file is temporarily unavailable" })) as unknown as typeof fetch;
    await expect(generateStoryMedia([{ type: "photo", file_id: "x" }], 1, "ru", config(root), notOk)).rejects.toThrow(
      "Telegram getFile failed",
    );

    const downloadFails = (async (input: URL | RequestInfo) =>
      String(input).endsWith("/getFile")
        ? Response.json({ ok: true, result: { file_path: "photos/a.jpg" } })
        : new Response("nope", { status: 502 })) as unknown as typeof fetch;
    await expect(generateStoryMedia([{ type: "photo", file_id: "x" }], 1, "ru", config(root), downloadFails)).rejects.toThrow(
      "Telegram file download failed: 502",
    );
  });

  it("cannot resolve a file id without a bot token", async () => {
    const root = tempRoot();
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", DATA_DIR: root });

    await expect(generateStoryMedia([{ type: "photo", file_id: "x" }], 1, "ru", config)).rejects.toThrow(
      "Cannot resolve story source media",
    );
  });
});

describe("generateStoryMedia remote provider", () => {
  it("refuses remote_http without a URL and token rather than falling back to local ffmpeg", async () => {
    // Falling back would move the transcode onto the small production box.
    // loadConfig rejects this combination at startup, so the guard inside the
    // transform only fires on a config assembled some other way.
    const root = tempRoot();
    const source = path.join(root, "source.jpg");
    fs.writeFileSync(source, JPEG);
    const remote = {
      ...config(root),
      MEDIA_PROCESSOR_PROVIDER: "remote_http",
      MEDIA_PROCESSOR_URL: "",
      MEDIA_PROCESSOR_TOKEN: "",
    } as BackendConfig;

    await expect(generateStoryMedia([{ type: "photo", local_path: source }], 1, "ru", remote)).rejects.toThrow(
      "media_processor_unavailable",
    );
  });

  it("preserves processor backpressure as a retryable HTTP error", async () => {
    const root = tempRoot();
    const source = path.join(root, "source.jpg");
    fs.writeFileSync(source, JPEG);
    const remote = {
      ...config(root),
      MEDIA_PROCESSOR_PROVIDER: "remote_http",
      MEDIA_PROCESSOR_URL: "http://processor",
      MEDIA_PROCESSOR_TOKEN: "x".repeat(16),
    } as BackendConfig;
    const fetchImpl = (async () =>
      new Response("media_processor_busy", {
        status: 429,
        headers: { "retry-after": "75" },
      })) as unknown as typeof fetch;

    try {
      await generateStoryMedia([{ type: "photo", local_path: source }], 1, "ru", remote, fetchImpl);
      throw new Error("expected processor backpressure");
    } catch (error) {
      expect(error).toMatchObject({ status: 429, retryAfterSeconds: 75 });
    }
  });
});
