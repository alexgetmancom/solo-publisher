import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureStoryDerivative, storyVariantPaths } from "../src/delivery/story-derivatives.js";
import { renderStoryVariants } from "../src/delivery/story-media.js";
import type { BackendConfig } from "../src/foundation/config.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/** These cases are about the source a render is handed and the executor it is
 * handed to, not about the encode. stories.test.ts covers the ffmpeg arguments. */
const realFfmpeg = await import("../src/foundation/runtime/ffmpeg.js");
mock.module("../src/foundation/runtime/ffmpeg.js", () => ({
  ...realFfmpeg,
  runFfmpeg: async (args: string[]) => {
    const outputs = args.filter((arg) => /\.(mp4|jpg)$/.test(arg) && arg !== args[args.indexOf("-i") + 1]);
    if (!outputs.length) throw new Error("ffmpeg output path is missing");
    for (const output of outputs) fs.writeFileSync(output, "encoded story");
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

describe("story derivative source", () => {
  it("refuses a source that is not on disk instead of writing an empty variant", async () => {
    const root = tempRoot();

    await expect(ensureStoryDerivative(config(root), path.join(root, "gone.jpg"), false)).rejects.toThrow("story_source_missing");
  });

  it("renders into the content-addressed destination publishing reads", async () => {
    const root = tempRoot();
    const source = path.join(root, "source.jpg");
    fs.writeFileSync(source, JPEG);

    expect(await ensureStoryDerivative(config(root), source, false)).toBe(true);
    expect(fs.existsSync(storyVariantPaths(config(root), source, false).standard)).toBe(true);
    // The second caller finds it made and spends no encode.
    expect(await ensureStoryDerivative(config(root), source, false)).toBe(false);
  });
});

describe("story render remote provider", () => {
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

    await expect(renderStoryVariants(source, path.join(root, "out.jpg"), undefined, false, remote)).rejects.toThrow(
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
      await renderStoryVariants(source, path.join(root, "out.jpg"), undefined, false, remote, fetchImpl);
      throw new Error("expected processor backpressure");
    } catch (error) {
      expect(error).toMatchObject({ status: 429, retryAfterSeconds: 75 });
    }
  });
});
