import crypto from "node:crypto";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { type PublishMediaItem, payloadMedia } from "../delivery/social/payload.js";
import { ensureStoryDerivative, preparedStoryMedia, storyVariantPaths } from "../delivery/story-derivatives.js";
import { generateStoryMedia } from "../delivery/story-media.js";
import type { BackendConfig } from "../foundation/config.js";
import { selectMediaForTarget } from "../publishing/media-policy.js";
import { publicationTimeline } from "./timeline.js";

type MediaHealth = {
  ok?: boolean;
  queued?: number;
  active?: number;
  concurrency?: number;
  version?: string;
  vaapi?: boolean;
  workDisk?: { availableBytes?: number; totalBytes?: number };
};

export async function mediaProcessorStatus(config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const url = mediaUrl(config, "/health");
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    const health = (await response.json()) as MediaHealth;
    return {
      ok: response.ok && health.ok === true,
      provider: config.MEDIA_PROCESSOR_PROVIDER,
      url: redactMediaUrl(config.MEDIA_PROCESSOR_URL),
      latencyMs: Date.now() - startedAt,
      ...health,
    };
  } catch (error) {
    return {
      ok: false,
      provider: config.MEDIA_PROCESSOR_PROVIDER,
      url: redactMediaUrl(config.MEDIA_PROCESSOR_URL),
      latencyMs: Date.now() - startedAt,
      error: String(error instanceof Error ? error.message : error),
    };
  }
}

export async function diagnoseMediaProcessor(config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const health = await mediaProcessorStatus(config, fetchImpl);
  const fixture = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=",
    "base64",
  );
  const idempotencyKey = crypto.createHash("sha256").update("ops-media-diagnose-v1").digest("hex");
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(mediaUrl(config, "/v1/transforms/ffmpeg"), {
      method: "POST",
      headers: mediaHeaders(config, fixture.byteLength, idempotencyKey, "image"),
      body: fixture,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const result = parseJson(text);
    return {
      ok: Boolean(health.ok) && response.ok,
      health,
      authenticatedFixture: {
        ok: response.ok,
        status: response.status,
        durationMs: Date.now() - startedAt,
        idempotencyKey,
        result: result ?? text.slice(0, 800),
      },
    };
  } catch (error) {
    return {
      ok: false,
      health,
      authenticatedFixture: {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: String(error instanceof Error ? error.message : error),
      },
    };
  }
}

export function mediaJobReport(backendDb: BackendDb, ref: string): Record<string, unknown> {
  const timeline = publicationTimeline(backendDb, ref);
  const events = (timeline.events as Array<Record<string, unknown>>).filter((event) => {
    const details = event.details as Record<string, unknown> | undefined;
    return event.type === "publish.job.phase" || String(details?.phase ?? "").includes("media");
  });
  return { ref, mediaEvents: events, timeline };
}

export async function reprocessPostMedia(
  backendDb: BackendDb,
  config: BackendConfig,
  ref: string,
  apply: boolean,
): Promise<Record<string, unknown>> {
  if (!/^post:\d+$/.test(ref)) throw new Error("--ref must look like post:106");
  const rows = unsafeDb(backendDb)
    .sqlite.query(
      `SELECT job_id,target,payload_json
       FROM publish_jobs
       WHERE publication_key=? AND target IN ('instagram_stories','instagram_stories_ru','telegram_stories')
       ORDER BY job_id`,
    )
    .all(ref) as Array<{ job_id: number; target: string; payload_json: string | null }>;
  const plans = rows.flatMap((row) => {
    const payload = parseJson(row.payload_json ?? "{}") as Record<string, unknown> | null;
    const media = payload ? selectMediaForTarget(row.target, payloadMedia(payload)) : [];
    if (!payload || media.length === 0) return [];
    const locale: "ru" | "en" = payload.locale === "ru" || row.target.endsWith("_ru") ? "ru" : "en";
    return [{ jobId: row.job_id, target: row.target, locale, payload, media }];
  });
  const unique = [...new Map(plans.map((plan) => [`${plan.locale}:${JSON.stringify(plan.media)}`, plan])).values()];
  if (!apply)
    return {
      ok: true,
      apply: false,
      ref,
      count: unique.length,
      plan: unique.map(({ jobId, target, locale, media }) => ({ jobId, target, locale, media })),
    };
  const postId = Number(ref.slice(5));
  const results = [];
  for (const plan of unique) {
    const startedAt = Date.now();
    const output = await repairStoryMedia(config, plan.media, postId, plan.locale);
    results.push({
      jobId: plan.jobId,
      target: plan.target,
      locale: plan.locale,
      durationMs: Date.now() - startedAt,
      outputs: output.map((item) => ({
        storyLocalPath: item.storyLocalPath,
        telegramStoryLocalPath: item.telegramStoryLocalPath,
      })),
    });
  }
  return { ok: true, apply: true, ref, count: results.length, results, published: false };
}

/**
 * The operator's "make this Story again" for one item.
 *
 * It re-renders into the content-addressed path publishing reads, so the repair
 * is what the next attempt picks up. Only media that never became a Studio asset
 * -- a payload carrying nothing but a Telegram file id -- goes the resolving
 * route, which is also the only one that can fetch the source back.
 */
async function repairStoryMedia(
  config: BackendConfig,
  media: PublishMediaItem[],
  postId: number,
  locale: "ru" | "en",
): Promise<PublishMediaItem[]> {
  const [source] = media;
  if (!source || typeof source.localPath !== "string") return generateStoryMedia(media, postId, locale, config);
  const video = String(source.type ?? "")
    .toLowerCase()
    .includes("video");
  await ensureStoryDerivative(config, source.localPath, video, { postId, locale, source: "repair" }, true);
  const prepared = preparedStoryMedia(config, source);
  if (!prepared) throw new Error(`story_repair_failed: ${storyVariantPaths(config, source.localPath, video).standard}`);
  return [prepared];
}

function mediaUrl(config: BackendConfig, pathname: string): string {
  if (config.MEDIA_PROCESSOR_PROVIDER !== "remote_http" || !config.MEDIA_PROCESSOR_URL || !config.MEDIA_PROCESSOR_TOKEN)
    throw new Error("remote media processor is not configured");
  return `${config.MEDIA_PROCESSOR_URL.replace(/\/$/, "")}${pathname}`;
}

function mediaHeaders(config: BackendConfig, bytes: number, idempotencyKey: string, kind: "image" | "video"): Record<string, string> {
  return {
    authorization: `Bearer ${config.MEDIA_PROCESSOR_TOKEN}`,
    "content-length": String(bytes),
    "content-type": kind === "video" ? "video/mp4" : "image/jpeg",
    "x-studio-transform": "story_vertical",
    "x-studio-media-kind": kind,
    "x-studio-idempotency-key": idempotencyKey,
  };
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function redactMediaUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "configured";
  }
}
