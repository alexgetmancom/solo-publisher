import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMediaProcessor, ffmpegFailure, type MediaProcessorOptions } from "../../../deploy/media-processor/service.js";
import { telegramVideoKbps } from "../../../deploy/media-processor/story-encode.js";

/**
 * The service that runs on VM-106 and renders every Story. It is reached only
 * through an SSH tunnel from the backend, so its contract — status codes,
 * manifest shape, caching and the disk it leaves behind — is what the caller
 * in delivery/story-media.ts depends on.
 *
 * ffmpeg and ffprobe are injected: this is about the service around them, and
 * the real encoders are exercised separately by scripts/image-smoke.ts against
 * the shipped binaries.
 */

const TOKEN = "media-processor-token";
const KEY = "a".repeat(64);

/** Minimal stand-in for Bun.spawn. `onFfmpeg` decides the exit code and may
 * create the outputs, so a test can simulate a clean render, a failure or a
 * process that never writes anything. */
function fakeSpawn(options: {
  probe?: unknown;
  probeExit?: number;
  ffmpegExit?: number;
  ffmpegStderr?: string;
  writeOutputs?: boolean;
  onSpawn?: (command: string[]) => void;
  ffmpegGate?: Promise<void>;
}) {
  const commands: string[][] = [];
  const spawn = ((command: string[]) => {
    commands.push(command);
    options.onSpawn?.(command);
    const stream = (text: string) => new Response(text).body as ReadableStream;
    if (command[0] === "ffprobe")
      return {
        exited: Promise.resolve(options.probeExit ?? 0),
        stdout: stream(typeof options.probe === "string" ? options.probe : JSON.stringify(options.probe ?? {})),
        stderr: stream(""),
        kill: () => {},
      };
    if (options.writeOutputs !== false) for (const arg of command) if (arg.includes(".part")) fs.writeFileSync(arg, Buffer.alloc(64, 1));
    return {
      exited: options.ffmpegGate?.then(() => options.ffmpegExit ?? 0) ?? Promise.resolve(options.ffmpegExit ?? 0),
      stdout: stream(""),
      stderr: stream(options.ffmpegStderr ?? ""),
      kill: () => {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawn, commands, ffmpegArgs: () => commands.find((command) => command[0] === "ffmpeg") ?? [] };
}

function withProcessor<T>(
  overrides: Partial<MediaProcessorOptions>,
  fn: (context: { processor: ReturnType<typeof createMediaProcessor>; workDir: string }) => Promise<T>,
): Promise<T> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-processor-"));
  fs.mkdirSync(path.join(workDir, "cache"), { recursive: true });
  const processor = createMediaProcessor({ token: TOKEN, workDir, ...overrides });
  return fn({ processor, workDir }).finally(() => fs.rmSync(workDir, { recursive: true, force: true }));
}

function transformRequest(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("http://processor/v1/transforms/ffmpeg", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-studio-transform": "story_vertical",
      "x-studio-media-kind": "video",
      "x-studio-idempotency-key": KEY,
      "content-length": String(typeof body === "string" ? body.length : 8),
      ...headers,
    },
    body,
  });
}

describe("createMediaProcessor", () => {
  it("refuses to start with a token short enough to brute-force", () => {
    expect(() => createMediaProcessor({ token: "short", workDir: "/tmp" })).toThrow(/at least 16 characters/);
  });

  it("reports health without a token, since the tunnel is the only way in", async () => {
    await withProcessor({ revision: "abc123", vaapiDevice: "/definitely/missing" }, async ({ processor }) => {
      const response = await processor.handle(new Request("http://processor/health"));
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ ok: true, queued: 0, active: 0, concurrency: 1, version: "abc123", vaapi: false });
      expect((body.workDisk as { totalBytes: number }).totalBytes).toBeGreaterThan(0);
    });
  });

  it("rejects an unauthorised transform and download", async () => {
    await withProcessor({}, async ({ processor }) => {
      const post = await processor.handle(new Request("http://processor/v1/transforms/ffmpeg", { method: "POST", body: "x" }));
      expect(post.status).toBe(401);
      const get = await processor.handle(new Request(`http://processor/v1/transforms/ffmpeg/${KEY}/standard`));
      expect(get.status).toBe(401);
    });
  });

  it("answers anything else with 404", async () => {
    await withProcessor({}, async ({ processor }) => {
      expect((await processor.handle(new Request("http://processor/"))).status).toBe(404);
      expect((await processor.handle(new Request("http://processor/v1/transforms/ffmpeg", { method: "GET" }))).status).toBe(404);
    });
  });

  it("validates the transform and media kind before accepting bytes", async () => {
    await withProcessor({}, async ({ processor }) => {
      const badTransform = await processor.handle(transformRequest("data", { "x-studio-transform": "sepia" }));
      expect(badTransform.status).toBe(400);
      expect(await badTransform.text()).toBe("invalid_transform_request");
      const badKind = await processor.handle(transformRequest("data", { "x-studio-media-kind": "audio" }));
      expect(badKind.status).toBe(400);
      expect(await badKind.text()).toBe("invalid_media_kind");
    });
  });

  it("rejects an idempotency key that is not a full digest", async () => {
    await withProcessor({ spawn: fakeSpawn({}).spawn }, async ({ processor }) => {
      const response = await processor.handle(transformRequest("data", { "x-studio-idempotency-key": "not-a-digest" }));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("invalid_idempotency_key");
    });
  });

  it("rejects a declared size above the cap without reading the body", async () => {
    await withProcessor({ maxBytes: 100, spawn: fakeSpawn({}).spawn }, async ({ processor }) => {
      const response = await processor.handle(transformRequest("data", { "content-length": "1000" }));
      expect(response.status).toBe(413);
    });
  });

  it("stops a source that understates its own content-length", async () => {
    // The header is a client claim; trusting it lets a small declared upload
    // fill the disk that holds both the work directory and the cache.
    await withProcessor({ maxBytes: 10, spawn: fakeSpawn({}).spawn }, async ({ processor }) => {
      const response = await processor.handle(transformRequest("x".repeat(500), { "content-length": "8" }));
      expect(response.status).toBe(413);
    });
  });

  it("renders a Story video into both variants and reports their sizes", async () => {
    const spawner = fakeSpawn({ probe: { format: { duration: "12" }, streams: [{ codec_type: "video", width: 1080, height: 1920 }] } });
    await withProcessor({ spawn: spawner.spawn }, async ({ processor, workDir }) => {
      const response = await processor.handle(transformRequest("video-bytes"));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { outputs: Record<string, { bytes: number }>; timings: { cacheHit: boolean } };
      expect(Object.keys(body.outputs)).toEqual(["standard", "telegram"]);
      expect(body.outputs.standard?.bytes).toBe(64);
      expect(body.timings.cacheHit).toBe(false);
      expect(fs.existsSync(path.join(workDir, "cache", `${KEY}.standard.mp4`))).toBe(true);
      expect(fs.existsSync(path.join(workDir, "cache", `${KEY}.telegram.mp4`))).toBe(true);
    });
  });

  it("produces only a standard variant for a site transform", async () => {
    const spawner = fakeSpawn({ probe: { format: { duration: "12" }, streams: [{ codec_type: "video", width: 1080, height: 1920 }] } });
    await withProcessor({ spawn: spawner.spawn }, async ({ processor }) => {
      const response = await processor.handle(transformRequest("video-bytes", { "x-studio-transform": "site_vertical" }));
      const body = (await response.json()) as { outputs: Record<string, unknown> };
      expect(Object.keys(body.outputs)).toEqual(["standard"]);
    });
  });

  it("blurs a backdrop for a source that is not already vertical", async () => {
    const wide = fakeSpawn({ probe: { format: { duration: "10" }, streams: [{ codec_type: "video", width: 1920, height: 1080 }] } });
    await withProcessor({ spawn: wide.spawn }, async ({ processor }) => {
      await processor.handle(transformRequest("video-bytes"));
      const args = wide.ffmpegArgs().join(" ");
      expect(args).toContain("scale=540:960");
      expect(args).toContain("crop=540:960");
      expect(args).toContain("boxblur=10:4");
      expect(args).toContain("scale=1080:1920");
      expect(args).toContain("overlay");
      expect(args).not.toContain("boxblur=20:10");
    });
  });

  it("falls back to safe defaults when ffprobe cannot read the source", async () => {
    const unreadable = fakeSpawn({ probeExit: 1 });
    await withProcessor({ spawn: unreadable.spawn }, async ({ processor }) => {
      const response = await processor.handle(transformRequest("video-bytes"));
      // A source it cannot measure must still render, at the conservative
      // bitrate for a full-length clip.
      expect(response.status).toBe(200);
      expect(unreadable.ffmpegArgs().join(" ")).toContain(String(telegramVideoKbps(59, 128_000)));
    });
  });

  it("survives ffprobe returning something that is not JSON", async () => {
    const garbled = fakeSpawn({ probe: "<html>proxy error</html>" });
    await withProcessor({ spawn: garbled.spawn }, async ({ processor }) => {
      expect((await processor.handle(transformRequest("video-bytes"))).status).toBe(200);
    });
  });

  it("serves the cached manifest on a repeat request without spawning ffmpeg", async () => {
    const spawner = fakeSpawn({ probe: { format: { duration: "10" }, streams: [{ codec_type: "video", width: 1080, height: 1920 }] } });
    await withProcessor({ spawn: spawner.spawn }, async ({ processor }) => {
      await processor.handle(transformRequest("video-bytes"));
      const spawnsAfterFirst = spawner.commands.length;
      const repeat = await processor.handle(transformRequest("video-bytes"));
      const body = (await repeat.json()) as { job: string; timings: { cacheHit: boolean } };
      expect(body.timings.cacheHit).toBe(true);
      expect(body.job).toStartWith("cached-");
      expect(spawner.commands).toHaveLength(spawnsAfterFirst);
    });
  });

  it("returns 422 with the tail of ffmpeg's diagnostics", async () => {
    const failing = fakeSpawn({
      ffmpegExit: 1,
      writeOutputs: false,
      ffmpegStderr: "frame=  12 fps=3 q=28\nnoise\n[libx264 @ 0x1] height not divisible by 2\nConversion failed!\n",
    });
    await withProcessor({ spawn: failing.spawn }, async ({ processor }) => {
      const response = await processor.handle(transformRequest("video-bytes"));
      expect(response.status).toBe(422);
      const text = await response.text();
      expect(text).toContain("ffmpeg exit 1");
      expect(text).toContain("Conversion failed!");
      // Progress spam would push the real diagnostic out of the tail.
      expect(text).not.toContain("fps=");
    });
  });

  it("leaves nothing behind when a render fails", async () => {
    const failing = fakeSpawn({ ffmpegExit: 1, writeOutputs: false });
    await withProcessor({ spawn: failing.spawn }, async ({ processor, workDir }) => {
      await processor.handle(transformRequest("video-bytes"));
      // A partial output kept under the cache name would be served later as if
      // it were a finished render.
      expect(fs.readdirSync(path.join(workDir, "cache"))).toEqual([]);
      expect(fs.readdirSync(workDir)).toEqual(["cache"]);
    });
  });

  it("downloads a rendered variant with an explicit length, and 404s the rest", async () => {
    await withProcessor({}, async ({ processor, workDir }) => {
      fs.writeFileSync(path.join(workDir, "cache", `${KEY}.standard.mp4`), Buffer.alloc(128, 2));
      const response = await processor.handle(
        new Request(`http://processor/v1/transforms/ffmpeg/${KEY}/standard`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      // Framing has to be deterministic through the tunnel and its TCP proxy.
      expect(response.headers.get("content-length")).toBe("128");

      const missing = await processor.handle(
        new Request(`http://processor/v1/transforms/ffmpeg/${KEY}/telegram`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      );
      expect(missing.status).toBe(404);
    });
  });

  it("serves a rendered image only as the standard variant", async () => {
    await withProcessor({}, async ({ processor, workDir }) => {
      fs.writeFileSync(path.join(workDir, "cache", `${KEY}.standard.jpg`), Buffer.alloc(32, 3));
      const response = await processor.handle(
        new Request(`http://processor/v1/transforms/ffmpeg/${KEY}/standard`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      );
      expect(response.headers.get("content-type")).toBe("image/jpeg");
    });
  });

  it("runs transforms one at a time", async () => {
    let concurrent = 0;
    let peak = 0;
    const spawner = fakeSpawn({
      probe: { format: { duration: "10" }, streams: [{ codec_type: "video", width: 1080, height: 1920 }] },
      onSpawn: (command) => {
        if (command[0] !== "ffmpeg") return;
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        queueMicrotask(() => {
          concurrent -= 1;
        });
      },
    });
    await withProcessor({ spawn: spawner.spawn }, async ({ processor }) => {
      await Promise.all([
        processor.handle(transformRequest("a", { "x-studio-idempotency-key": "b".repeat(64) })),
        processor.handle(transformRequest("b", { "x-studio-idempotency-key": "c".repeat(64) })),
        processor.handle(transformRequest("c", { "x-studio-idempotency-key": "d".repeat(64) })),
      ]);
      // VM-106 has one VAAPI device and a 2-CPU budget.
      expect(peak).toBe(1);
    });
  });

  it("rejects distinct work immediately while the only encoder slot is busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawner = fakeSpawn({
      probe: { format: { duration: "10" }, streams: [{ codec_type: "video", width: 1080, height: 1920 }] },
      ffmpegGate: gate,
    });
    await withProcessor({ spawn: spawner.spawn, retryAfterSeconds: 75 }, async ({ processor }) => {
      const first = processor.handle(transformRequest("first", { "x-studio-idempotency-key": "b".repeat(64) }));
      await Bun.sleep(1);
      const health = await processor.handle(new Request("http://processor/health"));
      expect(await health.json()).toMatchObject({ ok: false, status: "busy", active: 1, inFlight: 1 });

      const rejected = await processor.handle(transformRequest("second", { "x-studio-idempotency-key": "c".repeat(64) }));
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("retry-after")).toBe("75");
      expect(await rejected.text()).toBe("media_processor_busy");

      release();
      expect((await first).status).toBe(200);
    });
  });

  it("shares one in-flight render between requests with the same content key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawner = fakeSpawn({
      probe: { format: { duration: "10" }, streams: [{ codec_type: "video", width: 1080, height: 1920 }] },
      ffmpegGate: gate,
    });
    await withProcessor({ spawn: spawner.spawn }, async ({ processor }) => {
      const first = processor.handle(transformRequest("first"));
      await Bun.sleep(1);
      const shared = processor.handle(transformRequest("duplicate"));
      release();

      expect((await first).status).toBe(200);
      const sharedResponse = await shared;
      expect(sharedResponse.status).toBe(200);
      expect(((await sharedResponse.json()) as { job: string }).job).toStartWith("shared-");
      expect(spawner.commands.filter((command) => command[0] === "ffmpeg")).toHaveLength(1);
    });
  });

  it("reclaims aged cache entries and orphaned request folders, keeping fresh ones", async () => {
    await withProcessor({ cacheTtlSeconds: 60 }, async ({ processor, workDir }) => {
      const old = new Date(Date.now() - 3_600_000);
      const stale = path.join(workDir, "cache", "stale.mp4");
      const orphan = path.join(workDir, "orphaned-request");
      const fresh = path.join(workDir, "cache", "fresh.mp4");
      fs.writeFileSync(stale, "x");
      fs.writeFileSync(fresh, "x");
      fs.mkdirSync(orphan);
      fs.utimesSync(stale, old, old);
      fs.utimesSync(orphan, old, old);

      processor.pruneWorkDir();

      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(orphan)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      // The cache directory itself is never a prune candidate.
      expect(fs.existsSync(path.join(workDir, "cache"))).toBe(true);
    });
  });
});

describe("telegramVideoKbps", () => {
  it("keeps a full-length clip under the upload boundary", () => {
    // 8.5 MiB over 59s, less audio and container overhead.
    expect(telegramVideoKbps(59, 128_000)).toBe(1056);
    // The whole point of the formula: video plus audio must fit in 8.5 MiB.
    expect(((1056 + 128) * 1000 * 59) / 8 / 1024 / 1024).toBeLessThan(8.5);
  });

  it("never drops below a floor that would make the video unwatchable", () => {
    expect(telegramVideoKbps(59, 10_000_000)).toBe(150);
  });

  it("allows a much higher bitrate for a short clip", () => {
    expect(telegramVideoKbps(5, 128_000)).toBeGreaterThan(telegramVideoKbps(59, 128_000));
  });
});

describe("ffmpegFailure", () => {
  it("names the timeout rather than the signal it caused", () => {
    expect(ffmpegFailure(137, "killed", true, 900)).toBe("media_processing_timeout: ffmpeg exceeded 900s");
  });

  it("calls out an out-of-memory kill, which reads as an ordinary crash otherwise", () => {
    expect(ffmpegFailure(137, "", false, 900)).toContain("likely out of memory");
  });

  it("says so explicitly when ffmpeg failed without printing anything", () => {
    expect(ffmpegFailure(1, "   \n\n", false, 900)).toContain("no diagnostic output");
  });

  it("bounds the message so a failure cannot flood the durable job error", () => {
    expect(ffmpegFailure(1, "detail ".repeat(5000), false, 900).length).toBeLessThanOrEqual(1200);
  });
});
