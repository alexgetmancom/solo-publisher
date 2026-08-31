import fs from "node:fs";
import path from "node:path";
// deploy/media-processor is a separately built Docker image (see its Dockerfile),
// not a workspace package, but it lives in this same repo: import its ffmpeg
// recipe directly rather than keeping a second copy that can drift out of sync.
import { storyFfmpegArgs } from "../../../../deploy/media-processor/story-encode.js";
import type { BackendConfig } from "../foundation/config.js";
import { materializeTelegramFile } from "../foundation/external/telegram-files.js";
import { log } from "../foundation/logger.js";
import { runFfmpeg } from "../foundation/runtime/ffmpeg.js";
import { withTimeout } from "../foundation/runtime/timeout.js";
import { processVerticalMediaRemotely } from "./remote-media-processor.js";
import type { PublishMediaItem } from "./social/payload.js";

/** Where Story artefacts live, for both the prepared ones and the recovered ones. */
export function storyDirectory(config: BackendConfig): string {
  return path.join(config.DATA_DIR, "story-media");
}

/**
 * One source file into the Story shapes, wherever the caller wants them.
 *
 * The preparation worker and the publish-time recovery path both go through
 * here: the same recipe, the same timeout, the same permissions. Two
 * implementations of "make the Story version" is how they would disagree.
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
  else
    await withTimeout(
      runFfmpeg(storyFfmpegArgs(source, output, video ? "video" : "image")),
      storyTransformTimeout(config),
      "story_transform_timeout",
    );
  await withTimeout(fs.promises.chmod(output, 0o664), 30_000, "story_output_finalize_timeout");
}

export async function generateStoryMedia(
  raw: unknown,
  draftId: number,
  locale: "ru" | "en",
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishMediaItem[]> {
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  if (items.length !== 1) throw new Error("Story-safe generation supports one media item");
  const item = items[0] as Record<string, unknown>;
  const type = String(item.type ?? "").toLowerCase();
  if (!["photo", "image", "video"].includes(type)) throw new Error("Story-safe generation supports photo or video media");
  const startedAt = Date.now();
  let resolveMs = 0;
  let transformMs = 0;
  let finalizeMs = 0;
  let outputBytes = 0;
  let success = false;
  let failure: unknown;
  const directory = path.join(config.DATA_DIR, "story-media");
  const video = type === "video";
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    const resolveStartedAt = Date.now();
    let source: string;
    try {
      source = await withTimeout(
        resolveSource(item, draftId, locale, directory, config, fetchImpl),
        30_000,
        "story_source_resolution_timeout",
      );
    } finally {
      resolveMs = Date.now() - resolveStartedAt;
    }
    const stamp = Date.now();
    const output = path.join(directory, `draft-${draftId}-${locale}-story-standard-${stamp}.${video ? "mp4" : "jpg"}`);
    const telegramOutput = video ? path.join(directory, `draft-${draftId}-${locale}-story-telegram-${stamp}.mp4`) : undefined;

    const transformStartedAt = Date.now();
    try {
      await renderStoryVariants(source, output, telegramOutput, video, config, fetchImpl);
    } finally {
      transformMs = Date.now() - transformStartedAt;
    }

    const finalizeStartedAt = Date.now();
    try {
      outputBytes = (await fs.promises.stat(output)).size;
    } finally {
      finalizeMs = Date.now() - finalizeStartedAt;
    }
    success = true;
    return [
      {
        ...(item as unknown as PublishMediaItem),
        story_local_path: output,
        storyLocalPath: output,
        ...(telegramOutput && fs.existsSync(telegramOutput) ? { telegramStoryLocalPath: telegramOutput } : {}),
        story_width: 1080,
        story_height: 1920,
      },
    ];
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    log(success ? "info" : "warn", "operation timing", {
      operation: "media.story.transform",
      draftId,
      locale,
      kind: video ? "video" : "image",
      provider: config.MEDIA_PROCESSOR_PROVIDER,
      success,
      totalMs: Date.now() - startedAt,
      resolveMs,
      transformMs,
      finalizeMs,
      outputBytes,
      ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
    });
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

async function resolveSource(
  item: Record<string, unknown>,
  draftId: number,
  locale: string,
  directory: string,
  config: BackendConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const local = stringValue(item.local_path) || stringValue(item.localPath) || stringValue(item.path);
  if (local && path.isAbsolute(local) && fs.existsSync(local)) return local;
  const fileId = stringValue(item.file_id) || stringValue(item.fileId);
  if (!fileId || !config.controllerBotToken) throw new Error("Cannot resolve story source media");
  const extension = String(item.type ?? "").toLowerCase() === "video" ? ".mp4" : ".jpg";
  const target = path.join(directory, `draft-${draftId}-${locale}-source${extension}`);
  await materializeTelegramFile(config, { fileId }, { target, extension, fetchImpl });
  return target;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
