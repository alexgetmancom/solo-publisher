import fs from "node:fs";
import path from "node:path";
// deploy/media-processor is a separately built Docker image (see its Dockerfile),
// not a workspace package, but it lives in this same repo: import its ffmpeg
// recipe directly rather than keeping a second copy that can drift out of sync.
import {
  localStoryFfmpegArgs,
  needsVerticalBlur,
  STORY_MAX_DURATION_SECONDS,
  telegramVideoKbps,
  verticalImageFfmpegArgs,
} from "../../../../deploy/media-processor/story-encode.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { probeMediaMetadata, runFfmpeg } from "../foundation/runtime/ffmpeg.js";
import { withTimeout } from "../foundation/runtime/timeout.js";
import { processVerticalMediaRemotely } from "./remote-media-processor.js";
import { temporaryPath } from "./site-media-storage.js";

/** Where durable Story derivatives live. */
export function storyDirectory(config: BackendConfig): string {
  return path.join(config.DATA_DIR, "story-media");
}

/**
 * One source file into the Story shapes, wherever the caller wants them.
 *
 * Ingress, the operator's backfill and the operator's repair all reach the
 * recipe through here: the same transform, the same timeout, the same
 * permissions.
 */
export async function renderStoryVariants(
  source: string,
  output: string,
  telegramOutput: string | undefined,
  video: boolean,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (config.MEDIA_PROCESSOR_PROVIDER === "remote_http") await transformRemotely(source, output, telegramOutput, video, config, fetchImpl);
  else await transformLocally(source, output, telegramOutput, video, config);
}

/**
 * The local executor, doing what the remote one does for itself.
 *
 * The remote worker probes the source and decides the blurred backdrop from the
 * frame it finds; nothing was doing that here, so a source that is not 9:16 was
 * rendered onto black bars locally and blurred remotely -- the same post, two
 * looks, depending only on which executor a deployment happens to run. The probe
 * is the input to that decision, so it belongs on both sides of it.
 *
 * A video also has two Story shapes, not one. The Telegram variant rides a
 * bitrate computed for its upload ceiling, and delivery falls back to the
 * standard render when it is absent -- a file that can be too large to send.
 */
async function transformLocally(
  source: string,
  output: string,
  telegramOutput: string | undefined,
  video: boolean,
  config: BackendConfig,
): Promise<void> {
  if (video && !telegramOutput) throw new Error("story_variant_missing_telegram_output: a Story video is two files, not one");
  const metadata = await probeMediaMetadata(source);
  const blur = needsVerticalBlur(metadata.width, metadata.height);
  // A probe that reports no duration would divide the Telegram budget by zero.
  const duration = metadata.durationSeconds || STORY_MAX_DURATION_SECONDS;
  // ffmpeg writes its outputs in place, so a process killed mid-encode -- OOM,
  // a container restart -- left a truncated MP4 sitting under the name that
  // means "this variant is ready". `moov atom not found`, handed to Instagram
  // as a finished Story. Encode beside the name and move in when it is whole:
  // then the file being there is the record that it was made, as claimed.
  const targets = [output, ...(telegramOutput ? [telegramOutput] : [])];
  const partials = new Map(targets.map((target) => [target, temporaryPath(target)]));
  const partial = (target: string) => partials.get(target) ?? target;
  const args =
    video && telegramOutput
      ? localStoryFfmpegArgs(
          source,
          partial(output),
          partial(telegramOutput),
          telegramVideoKbps(duration, metadata.audioBitrate ?? 0),
          blur,
        )
      : verticalImageFfmpegArgs(source, partial(output), blur);
  try {
    await withTimeout(runFfmpeg(args), storyTransformTimeout(config), "story_transform_timeout");
    for (const target of targets) {
      await withTimeout(fs.promises.chmod(partial(target), 0o664), 30_000, "story_output_finalize_timeout");
      await withTimeout(fs.promises.rename(partial(target), target), 30_000, "story_output_finalize_timeout");
    }
  } finally {
    for (const target of targets) await fs.promises.rm(partial(target), { force: true }).catch(() => {});
  }
}

/** Media Processing Port. The delivery adapters only receive the finished
 * asset; a configured remote worker owns CPU/memory-heavy ffmpeg work. */
async function transformRemotely(
  source: string,
  output: string,
  telegramOutput: string | undefined,
  video: boolean,
  config: BackendConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const stat = await fs.promises.stat(source);
  const timeoutSeconds = storyTransformTimeout(config) / 1000;
  log("info", "story media remote upload started", { source, bytes: stat.size, timeoutSeconds });
  const result = await processVerticalMediaRemotely({
    config,
    source,
    kind: video ? "video" : "image",
    variants: [{ name: "standard", output }, ...(video && telegramOutput ? [{ name: "telegram", output: telegramOutput }] : [])],
    timeoutMs: timeoutSeconds * 1000,
    fetchImpl,
  });
  log("info", "story media remote processing completed", {
    source,
    phase: "media_processor.external",
    providerRequestId: result.requestId ?? result.job,
    ...result.timings,
  });
}

function storyTransformTimeout(config: BackendConfig): number {
  // Leave time for provider publication and durable finalization before the
  // queue-level deadline. The abort also stops the HTTP upload to VM-106.
  return Math.max(10_000, Math.min(config.MEDIA_PROCESSOR_TIMEOUT_SECONDS * 1000, (config.PUBLISH_JOB_TIMEOUT_SECONDS - 30) * 1000));
}
