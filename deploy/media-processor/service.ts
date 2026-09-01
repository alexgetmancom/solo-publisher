import { existsSync, readdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { createSerialQueue } from "../../shared/serial-queue.js";
import {
  needsVerticalBlur,
  remoteSiteVideoFfmpegArgs,
  remoteStoryFfmpegArgs,
  telegramVideoKbps,
  verticalImageFfmpegArgs,
} from "./story-encode.js";

/**
 * The whole media processor as a request handler, with its environment passed
 * in rather than read from Bun.env and its paths rooted at an injected work
 * directory. server.ts is only the bootstrap that reads the environment and
 * binds a port.
 *
 * It is split this way so the service can be exercised: as a top-level script
 * it threw at import time on a missing token, called Bun.serve immediately and
 * hard-coded /work, so nothing about it could be tested and 287 lines of the
 * VM-106 hot path ran unverified. Ffmpeg is reached through the injected
 * `spawn`, so a test can drive exit codes and timeouts without encoding.
 */

export type MediaProcessorOptions = {
  token: string;
  workDir: string;
  maxBytes?: number;
  timeoutSeconds?: number;
  cacheTtlSeconds?: number;
  revision?: string | undefined;
  /** Present on VM-106 only; a runner has no /dev/dri. */
  vaapiDevice?: string | undefined;
  spawn?: typeof Bun.spawn | undefined;
  retryAfterSeconds?: number | undefined;
};

export type MediaProcessor = {
  handle: (request: Request) => Promise<Response>;
  pruneWorkDir: (now?: number) => void;
};

type ProcessingTimings = { uploadMs: number; queueWaitMs: number; ffmpegMs: number; totalMs: number; cacheHit: boolean };

/** `content-length` is a client claim, so the cap is also enforced on the bytes
 * that actually arrive — otherwise an understated header fills the VM disk that
 * holds both the work directory and the cache. */
async function streamToFile(source: ReadableStream<Uint8Array>, output: string, limitBytes: number): Promise<void> {
  const sink = Bun.file(output).writer();
  const reader = source.getReader();
  let written = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > limitBytes) {
        await reader.cancel();
        throw new Error("source_exceeds_limit");
      }
      sink.write(value);
    }
  } finally {
    sink.end();
  }
}

export function ffmpegFailure(exitCode: number, stderr: string, timedOut: boolean, timeoutSeconds: number): string {
  if (timedOut) return `media_processing_timeout: ffmpeg exceeded ${timeoutSeconds}s`;
  if (exitCode === 137) return "media_processing_failed: ffmpeg exit 137: process was killed (likely out of memory)";
  const detail = stderr
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^frame=\s*\d+\s+fps=/.test(line))
    .slice(-4)
    .join(" · ");
  return `media_processing_failed: ffmpeg exit ${exitCode}: ${detail || "no diagnostic output"}`.slice(0, 1200);
}

export function createMediaProcessor(options: MediaProcessorOptions): MediaProcessor {
  const { token, workDir } = options;
  if (!token || token.length < 16) throw new Error("MEDIA_PROCESSOR_TOKEN must contain at least 16 characters");
  const maxBytes = options.maxBytes ?? 1_073_741_824;
  const timeoutSeconds = options.timeoutSeconds ?? 900;
  const cacheTtlSeconds = options.cacheTtlSeconds ?? 86_400;
  const spawn = options.spawn ?? Bun.spawn;
  const cacheDir = `${workDir}/cache`;
  const enqueue = createSerialQueue();
  const inFlight = new Map<string, Promise<Response>>();
  const retryAfterSeconds = options.retryAfterSeconds ?? 60;
  let queued = 0;
  let active = 0;
  let rejected = 0;
  let shared = 0;

  const authorized = (request: Request) => request.headers.get("authorization") === `Bearer ${token}`;

  function queue<T>(work: () => Promise<T>): Promise<T> {
    queued += 1;
    return enqueue(async () => {
      queued -= 1;
      active += 1;
      try {
        return await work();
      } finally {
        active -= 1;
      }
    });
  }

  // The VM disk is finite: aged cache entries and orphaned per-request folders
  // (left behind by a crash before their finally block) are reclaimed here.
  function pruneWorkDir(now = Date.now()): void {
    const cutoff = now - cacheTtlSeconds * 1000;
    for (const dir of [workDir, cacheDir]) {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (dir === workDir && name === "cache") continue;
        const target = `${dir}/${name}`;
        try {
          if (statSync(target).mtimeMs < cutoff) rmSync(target, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  function processedAsset(file: string, mediaKind: string, job: string): Response {
    return new Response(Bun.file(file), {
      headers: {
        "content-type": mediaKind === "video" ? "video/mp4" : "image/jpeg",
        // The processor is reached through an SSH tunnel and a local TCP proxy.
        // An explicit size makes the response framing deterministic for Bun's
        // streaming client instead of relying on connection-close semantics.
        "content-length": String(statSync(file).size),
        "x-media-processor-job": job,
      },
    });
  }

  function manifest(idempotencyKey: string, mediaKind: string, transform: string, job: string, timings: ProcessingTimings): Response {
    const variants = transform === "story_vertical" && mediaKind === "video" ? ["standard", "telegram"] : ["standard"];
    return Response.json({
      job,
      requestId: job,
      timings,
      outputs: Object.fromEntries(
        variants.map((variant) => {
          const file = `${cacheDir}/${idempotencyKey}.${variant}${mediaKind === "video" ? ".mp4" : ".jpg"}`;
          return [variant, { bytes: statSync(file).size }];
        }),
      ),
    });
  }

  function cachedManifest(
    idempotencyKey: string,
    mediaKind: string,
    transform: string,
    enqueuedAt: number,
    job = `cached-${idempotencyKey.slice(0, 12)}`,
  ): Response | null {
    const ext = mediaKind === "video" ? ".mp4" : ".jpg";
    const standardCached = `${cacheDir}/${idempotencyKey}.standard${ext}`;
    const telegramCached = `${cacheDir}/${idempotencyKey}.telegram${ext}`;
    if (!existsSync(standardCached) || (transform === "story_vertical" && mediaKind === "video" && !existsSync(telegramCached)))
      return null;
    return manifest(idempotencyKey, mediaKind, transform, job, {
      uploadMs: 0,
      queueWaitMs: 0,
      ffmpegMs: 0,
      totalMs: Date.now() - enqueuedAt,
      cacheHit: true,
    });
  }

  async function probeSource(input: string): Promise<{ duration: number; audioBitrate: number; width: number; height: number }> {
    const fallback = { duration: 59, audioBitrate: 128_000, width: 0, height: 0 };
    const child = spawn(
      ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,bit_rate,width,height", "-of", "json", input],
      { stdout: "pipe", stderr: "ignore" },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream).text()]);
    if (exitCode !== 0) return fallback;
    try {
      const parsed = JSON.parse(stdout) as {
        format?: { duration?: string };
        streams?: Array<{ codec_type?: string; bit_rate?: string; width?: number; height?: number }>;
      };
      const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
      const video = parsed.streams?.find((stream) => stream.codec_type === "video");
      return {
        duration: Math.min(59, Math.max(1, Number(parsed.format?.duration) || 59)),
        audioBitrate: Math.max(0, Number(audio?.bit_rate) || 128_000),
        width: Number(video?.width) || 0,
        height: Number(video?.height) || 0,
      };
    } catch {
      return fallback;
    }
  }

  async function transcode(
    source: ReadableStream<Uint8Array>,
    sourceSize: number,
    mediaKind: string,
    transform: "story_vertical" | "site_vertical",
    idempotencyKey: string,
    enqueuedAt: number,
  ): Promise<Response> {
    const startedAt = Date.now();
    const queueWaitMs = startedAt - enqueuedAt;
    if (!Number.isFinite(sourceSize) || sourceSize <= 0 || sourceSize > maxBytes)
      return new Response("invalid_source_size", { status: 413 });
    if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) return new Response("invalid_idempotency_key", { status: 400 });
    const ext = mediaKind === "video" ? ".mp4" : ".jpg";
    const standardCached = `${cacheDir}/${idempotencyKey}.standard${ext}`;
    const telegramCached = `${cacheDir}/${idempotencyKey}.telegram${ext}`;
    const cached = cachedManifest(idempotencyKey, mediaKind, transform, enqueuedAt);
    if (cached) return cached;
    const id = crypto.randomUUID();
    const folder = `${workDir}/${id}`;
    const input = `${folder}/source${ext}`;
    // Keep the final media extension so ffmpeg selects the right muxer even
    // while the output is still an atomic temporary file.
    const standardPartial = `${standardCached}.${id}.part${ext}`;
    const telegramPartial = `${telegramCached}.${id}.part${ext}`;
    try {
      await mkdir(folder, { recursive: true });
      await mkdir(cacheDir, { recursive: true });
      // Keep the incoming asset streaming to the VM disk; only ffmpeg owns the
      // media bytes after this point.
      const uploadStartedAt = Date.now();
      try {
        await streamToFile(source, input, maxBytes);
      } catch {
        return new Response("invalid_source_size", { status: 413 });
      }
      // This VM's compose.yml caps the container at 2 CPUs; keep ffmpeg inside that budget.
      const sourceMetadata = await probeSource(input);
      const blur = needsVerticalBlur(sourceMetadata.width, sourceMetadata.height);
      const args =
        mediaKind === "video"
          ? transform === "story_vertical"
            ? remoteStoryFfmpegArgs(
                input,
                standardPartial,
                telegramPartial,
                telegramVideoKbps(sourceMetadata.duration, sourceMetadata.audioBitrate),
                blur,
              )
            : remoteSiteVideoFfmpegArgs(input, standardPartial, blur)
          : verticalImageFfmpegArgs(input, standardPartial, blur);
      const uploadMs = Date.now() - uploadStartedAt;
      const ffmpegStartedAt = Date.now();
      const child = spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutSeconds * 1000);
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr as ReadableStream).text()]);
      const ffmpegMs = Date.now() - ffmpegStartedAt;
      clearTimeout(timer);
      if (exitCode !== 0) return new Response(ffmpegFailure(exitCode, stderr, timedOut, timeoutSeconds), { status: 422 });
      await rename(standardPartial, standardCached);
      if (transform === "story_vertical" && mediaKind === "video") await rename(telegramPartial, telegramCached);
      const timings = { uploadMs, queueWaitMs, ffmpegMs, totalMs: Date.now() - enqueuedAt, cacheHit: false };
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", message: "media transform completed", job: id, timings }));
      return manifest(idempotencyKey, mediaKind, transform, id, timings);
    } finally {
      // Only the atomically renamed cache entry survives a request; the source
      // folder and any partial output are always reclaimed.
      rmSync(folder, { recursive: true, force: true });
      rmSync(standardPartial, { force: true });
      rmSync(telegramPartial, { force: true });
    }
  }

  async function handle(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/health") {
      const disk = statfsSync(workDir);
      return Response.json({
        ok: active === 0 && queued === 0,
        status: active > 0 || queued > 0 ? "busy" : "ready",
        queued,
        active,
        concurrency: 1,
        inFlight: inFlight.size,
        rejected,
        shared,
        version: options.revision ?? "unknown",
        vaapi: existsSync(options.vaapiDevice ?? "/dev/dri/renderD128"),
        workDisk: { availableBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize },
      });
    }
    const download = pathname.match(/^\/v1\/transforms\/ffmpeg\/([a-f0-9]{64})\/(standard|telegram)$/);
    if (request.method === "GET" && download) {
      if (!authorized(request)) return new Response("unauthorized", { status: 401 });
      const [, idempotencyKey, variant] = download;
      if (!idempotencyKey || !variant) return new Response("invalid_download_path", { status: 400 });
      const mp4 = `${cacheDir}/${idempotencyKey}.${variant}.mp4`;
      const jpg = `${cacheDir}/${idempotencyKey}.${variant}.jpg`;
      if (existsSync(mp4)) return processedAsset(mp4, "video", `cached-${idempotencyKey.slice(0, 12)}`);
      if (variant === "standard" && existsSync(jpg)) return processedAsset(jpg, "image", `cached-${idempotencyKey.slice(0, 12)}`);
      return new Response("not_found", { status: 404 });
    }
    if (request.method !== "POST" || pathname !== "/v1/transforms/ffmpeg") return new Response("not_found", { status: 404 });
    if (!authorized(request)) return new Response("unauthorized", { status: 401 });
    const source = request.body;
    const transform = request.headers.get("x-studio-transform");
    if ((transform !== "story_vertical" && transform !== "site_vertical") || !source)
      return new Response("invalid_transform_request", { status: 400 });
    const mediaKind =
      request.headers.get("x-studio-media-kind") === "video"
        ? "video"
        : request.headers.get("x-studio-media-kind") === "image"
          ? "image"
          : null;
    if (!mediaKind) return new Response("invalid_media_kind", { status: 400 });
    const sourceSize = Number(request.headers.get("content-length"));
    const idempotencyKey = request.headers.get("x-studio-idempotency-key") ?? "";
    if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) return new Response("invalid_idempotency_key", { status: 400 });
    const enqueuedAt = Date.now();
    const cached = cachedManifest(idempotencyKey, mediaKind, transform, enqueuedAt);
    if (cached) {
      await source.cancel().catch(() => {});
      return cached;
    }
    const existing = inFlight.get(idempotencyKey);
    if (existing) {
      shared += 1;
      await source.cancel().catch(() => {});
      await existing;
      return (
        cachedManifest(idempotencyKey, mediaKind, transform, enqueuedAt, `shared-${idempotencyKey.slice(0, 12)}`) ??
        new Response("media_processing_shared_job_failed", { status: 503 })
      );
    }
    // A queued HTTP request cannot make progress while the only ffmpeg slot is
    // occupied, yet its caller's deadline keeps ticking. Reject distinct work
    // immediately so the durable publish/site queues retry it later instead of
    // timing out and leaving an orphaned encode behind.
    if (active > 0 || queued > 0) {
      rejected += 1;
      await source.cancel().catch(() => {});
      return new Response("media_processor_busy", {
        status: 429,
        headers: { "retry-after": String(retryAfterSeconds) },
      });
    }
    const work = queue(() => transcode(source, sourceSize, mediaKind, transform, idempotencyKey, enqueuedAt));
    inFlight.set(idempotencyKey, work);
    void work.then(
      () => inFlight.delete(idempotencyKey),
      () => inFlight.delete(idempotencyKey),
    );
    return work;
  }

  return { handle, pruneWorkDir };
}
