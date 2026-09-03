import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../foundation/config.js";
import { OperationTimeoutError, withTimeout } from "../foundation/runtime/timeout.js";
import { HttpPublishError } from "../publishing/errors.js";
import { mediaTransformKey } from "./media-idempotency.js";
import { writeResponseAtomically } from "./site-media-storage.js";

const VERTICAL_MEDIA_RECIPE = "vertical-variants-v6";
const VERTICAL_MEDIA_TRANSFORM = "story_vertical";

export type RemoteMediaManifest = {
  job?: string;
  requestId?: string;
  timings?: { uploadMs?: number; queueWaitMs?: number; ffmpegMs?: number; totalMs?: number; cacheHit?: boolean };
  outputs?: Record<string, { bytes?: number }>;
};

/** The only HTTP client for the vertical media processor. Callers declare the
 * variants they consume; upload, manifest validation and atomic downloads stay
 * identical for site and social delivery. */
export async function processVerticalMediaRemotely(input: {
  config: BackendConfig;
  source: string;
  kind: "image" | "video";
  variants: ReadonlyArray<{ name: string; output: string }>;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  uploadBody?: BodyInit;
}): Promise<RemoteMediaManifest> {
  const { config, source, kind, variants, timeoutMs } = input;
  if (!config.MEDIA_PROCESSOR_URL || !config.MEDIA_PROCESSOR_TOKEN)
    throw new Error("media_processor_unavailable: remote_http requires MEDIA_PROCESSOR_URL and MEDIA_PROCESSOR_TOKEN");
  const fetchImpl = input.fetchImpl ?? fetch;
  const stat = await fs.promises.stat(source);
  const idempotencyKey = await mediaTransformKey(source, `${VERTICAL_MEDIA_RECIPE}:${kind}`);
  const base = config.MEDIA_PROCESSOR_URL.replace(/\/$/, "");
  let response: Response;
  try {
    response = await withTimeout(
      fetchImpl(`${base}/v1/transforms/ffmpeg`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.MEDIA_PROCESSOR_TOKEN}`,
          "content-length": String(stat.size),
          "content-type": kind === "video" ? "video/mp4" : "image/jpeg",
          "x-studio-transform": VERTICAL_MEDIA_TRANSFORM,
          "x-studio-media-kind": kind,
          "x-studio-output-name": path.basename(variants[0]?.output ?? source),
          "x-studio-idempotency-key": idempotencyKey,
        },
        body: input.uploadBody ?? Bun.file(source),
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs,
      "media_processor_upload_timeout",
    );
  } catch (error) {
    if (error instanceof OperationTimeoutError || (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)))
      throw new Error(`media_processor_timeout: remote worker exceeded ${Math.ceil(timeoutMs / 1000)}s`);
    throw error;
  }
  if (!response.ok || !response.body) {
    const detail = (await response.text()).slice(0, 800);
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader == null ? Number.NaN : Number(retryAfterHeader);
    throw new HttpPublishError(
      `media_processor_failed: ${response.status}${detail ? ` ${detail}` : ""}`,
      response.status,
      detail,
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("media_processor_failed: expected a JSON transform manifest");
  const manifest = (await response.json()) as RemoteMediaManifest;
  const missing = variants.find(({ name }) => !manifest.outputs?.[name]);
  if (missing) throw new Error(`media_processor_failed: missing ${missing.name} output`);

  for (const variant of variants) {
    const download = await withTimeout(
      fetchImpl(`${base}/v1/transforms/ffmpeg/${idempotencyKey}/${variant.name}`, {
        headers: { authorization: `Bearer ${config.MEDIA_PROCESSOR_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      }),
      30_000,
      "media_processor_variant_download_timeout",
    );
    if (!download.ok) throw new Error(`media_processor_variant_failed: ${variant.name} ${download.status}`);
    await withTimeout(writeResponseAtomically(variant.output, download), 30_000, "media_processor_variant_write_timeout");
    await withTimeout(fs.promises.chmod(variant.output, 0o664), 30_000, "media_processor_variant_finalize_timeout");
  }
  return manifest;
}
