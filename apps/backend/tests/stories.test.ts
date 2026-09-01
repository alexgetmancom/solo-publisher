import { describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localStoryFfmpegArgs, needsVerticalBlur, remoteStoryFfmpegArgs } from "../../../deploy/media-processor/story-encode.js";
import { publishInstagramStory } from "../src/delivery/social/instagram.js";
import { InstagramContainerInvalidError } from "../src/delivery/social/instagram-container.js";
import { telegramStoryCaption, telegramStoryCaptionInput, telegramStoryUploadMedia } from "../src/delivery/social/telegramStories.js";
import { generateStoryMedia } from "../src/delivery/story-media.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/** The encode is mocked, but the local executor probes the source before it to
 * decide the blurred backdrop, so these cases need media a probe can read. */
function encodeFixture(target: string, size: string): void {
  const encoded = Bun.spawnSync([
    "ffmpeg",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${size}:d=1`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-y",
    target,
  ]);
  if (encoded.exitCode !== 0) throw new Error(`fixture encode failed: ${encoded.stderr.toString()}`);
}

const ffmpegCalls: string[][] = [];
/** Set by the case that needs an encode to die with its output half-written. */
let ffmpegDiesAfterWriting = false;
const instantSleep = async (_milliseconds: number): Promise<void> => {};
mock.module("../src/foundation/runtime/ffmpeg.js", () => {
  return {
    runFfmpeg: async (args: string[]) => {
      ffmpegCalls.push(args);
      // Both Story outputs of a video come out of one invocation, so every path
      // that is not a flag has to be written, not just the last argument.
      const outputs = args.filter((arg) => /\.(mp4|jpg)$/.test(arg) && arg !== args[args.indexOf("-i") + 1]);
      if (!outputs.length) throw new Error("ffmpeg output path is missing");
      for (const output of outputs) fs.writeFileSync(output, "fake story image content");
      if (ffmpegDiesAfterWriting) throw new Error("media_processing_failed: ffmpeg exit 137: process was killed (likely out of memory)");
    },
  };
});

describe("story publishers", () => {
  it("generates a 1080x1920 story-safe image with ffmpeg", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-image-"));
    const source = path.join(dir, "source.png");
    fs.writeFileSync(
      source,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    );
    try {
      const generated = await generateStoryMedia([{ type: "photo", local_path: source }], 1, "ru", loadTestConfig({ DATA_DIR: dir }));
      expect(generated[0]).toMatchObject({ story_width: 1080, story_height: 1920 });
      expect(fs.existsSync(String(generated[0]?.story_local_path))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders both Story shapes of a video in one pass, without changing source FPS", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-video-"));
    const source = path.join(dir, "source.mp4");
    encodeFixture(source, "1080x1920");
    try {
      const generated = await generateStoryMedia([{ type: "video", local_path: source }], 2, "en", loadTestConfig({ DATA_DIR: dir }));
      expect(generated[0]).toMatchObject({ story_width: 1080, story_height: 1920 });
      expect(String(generated[0]?.story_local_path)).toEndWith(".mp4");
      expect(fs.existsSync(String(generated[0]?.story_local_path))).toBe(true);
      // Telegram's own encode rides a lower ceiling; delivery falling back to the
      // standard render is how a Story became too large to send.
      expect(fs.existsSync(String(generated[0]?.telegramStoryLocalPath))).toBe(true);
      const ffmpegArgs = ffmpegCalls.at(-1) ?? [];
      expect(ffmpegArgs[ffmpegArgs.indexOf("-t") + 1]).toBe("58.9");
      expect(ffmpegArgs).not.toContain("-r");
      expect(ffmpegArgs.filter((arg) => arg === "libx264")).toHaveLength(2);
      // The Telegram budget is computed around the source audio's own bitrate,
      // so re-encoding audio here would quietly spend it.
      expect(ffmpegArgs.slice(ffmpegArgs.indexOf("-c:a"), ffmpegArgs.indexOf("-c:a") + 2)).toEqual(["-c:a", "copy"]);
      expect(ffmpegArgs).not.toContain("-b:a");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blurs a backdrop locally for the same frames the remote worker blurs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-blur-"));
    const source = path.join(dir, "source.mp4");
    // A landscape source: black bars locally and a blurred backdrop remotely was
    // one post with two looks, decided by nothing but the configured executor.
    encodeFixture(source, "1920x1080");
    try {
      await generateStoryMedia([{ type: "video", local_path: source }], 3, "en", loadTestConfig({ DATA_DIR: dir }));
      const filter = (ffmpegCalls.at(-1) ?? [])[(ffmpegCalls.at(-1) ?? []).indexOf("-filter_complex") + 1] ?? "";
      expect(filter).toContain("boxblur");
      expect(filter).toContain("overlay=(W-w)/2:(H-h)/2");
      // The blur is the only difference; the upload belongs to VAAPI alone.
      expect(filter).not.toContain("hwupload");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the local and remote Story recipes on one graph", () => {
    const local = localStoryFfmpegArgs("source.mp4", "standard.mp4", "telegram.mp4", 1100, true);
    const remote = remoteStoryFfmpegArgs("source.mp4", "standard.mp4", "telegram.mp4", 1100, true);
    const graph = (args: string[]) => args[args.indexOf("-filter_complex") + 1] ?? "";
    // Same recipe either side of the encoder: the hardware upload is the delta.
    expect(graph(remote)).toBe(graph(local).replace(",split=2[out0][out1]", ",format=nv12,hwupload,split=2[out0][out1]"));
    expect(local.filter((arg) => arg === "-b:v")).toEqual(remote.filter((arg) => arg === "-b:v"));
    expect(local[local.indexOf("telegram.mp4") - 8]).toBe(remote[remote.indexOf("telegram.mp4") - 8]);
  });

  it("leaves nothing behind under the name that means the variant is ready", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-partial-"));
    const source = path.join(dir, "source.mp4");
    encodeFixture(source, "1080x1920");
    // An encode killed halfway used to leave a truncated MP4 under the final
    // name, and `moov atom not found` was then published as a finished Story.
    ffmpegDiesAfterWriting = true;
    try {
      await expect(generateStoryMedia([{ type: "video", local_path: source }], 4, "en", loadTestConfig({ DATA_DIR: dir }))).rejects.toThrow(
        "killed",
      );
      const storyDir = path.join(dir, "story-media");
      const left = fs.existsSync(storyDir) ? fs.readdirSync(storyDir).filter((name) => name.includes("story-")) : [];
      expect(left).toEqual([]);
    } finally {
      ffmpegDiesAfterWriting = false;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses VAAPI only in the remote worker recipe", () => {
    const args = remoteStoryFfmpegArgs("source.mp4", "standard.mp4", "telegram.mp4", 1100, true);
    expect(args.slice(0, 4)).toEqual(["-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va"]);
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "h264_vaapi"]);
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("format=nv12,hwupload,split=2");
    expect(args[args.indexOf("-filter_complex") + 1]).not.toContain("fps=50");
    expect(args.filter((arg) => arg === "h264_vaapi")).toHaveLength(2);
    expect(args.filter((arg) => arg === "-t")).toHaveLength(2);
    expect(args[args.indexOf("standard.mp4") - 2]).toBe("-t");
    expect(args[args.indexOf("standard.mp4") - 1]).toBe("58.9");
    expect(args[args.indexOf("telegram.mp4") - 2]).toBe("-t");
    expect(args[args.indexOf("telegram.mp4") - 1]).toBe("58.9");
    expect(args).toContain("telegram.mp4");
  });

  it("keeps near-9:16 media plain and adds blur beyond the five-percent tolerance", () => {
    expect(needsVerticalBlur(1080, 1920)).toBe(false);
    expect(needsVerticalBlur(1080, 1830)).toBe(false);
    expect(needsVerticalBlur(1080, 1600)).toBe(true);
    expect(needsVerticalBlur(720, 1600)).toBe(true);
  });

  it("uploads generated story paths as files, rather than treating them as Telegram file IDs", () => {
    expect(telegramStoryUploadMedia("/data/story-media/draft-59-ru.jpg", "IMAGE", { width: 0, height: 0, duration: 0 })).toEqual({
      type: "photo",
      file: "file:/data/story-media/draft-59-ru.jpg",
    });
    expect(telegramStoryUploadMedia("/data/story-media/draft-59-en.mp4", "VIDEO", { width: 1080, height: 1920, duration: 59 })).toEqual({
      type: "video",
      file: "file:/data/story-media/draft-59-en.mp4",
      width: 1080,
      height: 1920,
      duration: 59,
      supportsStreaming: true,
    });
  });

  it("removes links from Telegram Story captions", () => {
    expect(telegramStoryCaption("Read more: https://alexgetman.com/post/59\n\n\nThank you")).toBe("Read more:\n\nThank you");
  });

  it("keeps a hidden Telegram link clickable in a Story caption", () => {
    expect(
      telegramStoryCaptionInput("Read guide", [{ type: "text_link", offset: 5, length: 5, url: "https://example.com/guide" }]),
    ).toEqual({
      text: "Read guide",
      entities: [{ _: "messageEntityTextUrl", offset: 5, length: 5, url: "https://example.com/guide" }],
    });
  });

  it("creates, waits for and publishes an Instagram story", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      { id: "container-1" },
      { status_code: "FINISHED" },
      { id: "story-1" },
      { permalink: "https://instagram.com/stories/a/1" },
    ];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    const config = loadTestConfig({
      INSTAGRAM_RU_ACCESS_TOKEN: "IG-token",
      INSTAGRAM_RU_USER_ID: "ig-user",
    });

    const result = await publishInstagramStory(
      { text: "Story caption", media: [{ type: "IMAGE", vpsUrl: "https://example.com/story.jpg" }] },
      config,
      { accessToken: "IG-token", userId: "ig-user" },
      fetchImpl,
    );

    expect(result).toMatchObject({ ok: true, id: "story-1", url: "https://instagram.com/stories/a/1" });
    expect(requests.map((request) => request.url)).toEqual([
      "https://graph.instagram.com/v23.0/ig-user/media",
      expect.stringContaining("https://graph.instagram.com/v23.0/container-1?"),
      "https://graph.instagram.com/v23.0/ig-user/media_publish",
      expect.stringContaining("https://graph.instagram.com/v23.0/story-1?"),
    ]);
    expect(String(requests[0]?.init?.body)).toContain("media_type=STORIES");
    expect(String(requests[0]?.init?.body)).toContain("image_url=https%3A%2F%2Fexample.com%2Fstory.jpg");
  });

  it("recreates an Instagram Story container that reaches ERROR before publication", async () => {
    const requests: string[] = [];
    const responses = [
      { id: "container-bad" },
      { status_code: "ERROR", status: "upload failed" },
      null,
      { id: "container-good" },
      { status_code: "FINISHED" },
      { id: "story-2" },
      { permalink: "https://instagram.com/stories/a/2" },
    ];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      if (init?.method === "HEAD") {
        responses.shift();
        return new Response(null, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Content-Length": "1234" },
        });
      }
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    const config = loadTestConfig({
      INSTAGRAM_RU_ACCESS_TOKEN: "IG-token",
      INSTAGRAM_RU_USER_ID: "ig-user",
    });

    const result = await publishInstagramStory(
      { media: [{ type: "IMAGE", vpsUrl: "https://example.com/story.jpg" }] },
      config,
      { accessToken: "IG-token", userId: "ig-user" },
      fetchImpl,
      instantSleep,
    );

    expect(result).toMatchObject({ ok: true, id: "story-2" });
    expect(requests.filter((url) => url.endsWith("/ig-user/media"))).toHaveLength(2);
    expect(requests).toContain("https://example.com/story.jpg");
  }, 10_000);

  it("includes public media diagnostics when Instagram rejects both containers", async () => {
    const responses = [
      { id: "container-1" },
      { status_code: "ERROR", status: "upload failed" },
      { id: "container-2" },
      { status_code: "ERROR", status: "upload failed again" },
    ];
    const fetchImpl = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Content-Length": "4321" },
        });
      }
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    const config = loadTestConfig({
      INSTAGRAM_RU_ACCESS_TOKEN: "IG-token",
      INSTAGRAM_RU_USER_ID: "ig-user",
    });

    const failure = await publishInstagramStory(
      { media: [{ type: "IMAGE", vpsUrl: "https://example.com/story.jpg" }] },
      config,
      { accessToken: "IG-token", userId: "ig-user" },
      fetchImpl,
      instantSleep,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InstagramContainerInvalidError);
    expect(String(failure)).toContain('"containerId":"container-2"');
    expect(String(failure)).toContain('"providerStatus":"upload failed again"');
    expect(String(failure)).toContain('"contentType":"image/jpeg"');
    expect(String(failure)).toContain('"contentLength":"4321"');
  }, 10_000);
});
