import fs from "node:fs";
import type { BackendConfig } from "../../foundation/config.js";
import { externalFetch } from "../../foundation/http.js";
import type { PublishResult } from "../../publishing/errors.js";
import { httpPublishError, publishJson } from "../../publishing/errors.js";
import { formatPlatformText } from "../../publishing/platform-profiles.js";
import { ambiguousExternalMutation, isAmbiguousPublicationError } from "../ambiguous-publication.js";
import { guessContentType, payloadMedia, payloadText, payloadThread } from "./payload.js";
import { toContentState } from "./x-content-state.js";

const UPLOAD_URL = "https://api.x.com/2/media/upload";
type SleepImplementation = (milliseconds: number) => Promise<void>;
const defaultSleep: SleepImplementation = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** The posts of a chain that have already reached the audience. */
const CHAIN_RESUME_KEY = "_xPublishedIds";

/** One post, or a thread as a reply chain: each part answers the one before it
 * and carries its own media. A part that fails after earlier ones went out
 * hands their ids back, so the retry continues the chain instead of starting a
 * second one. */
export async function publishToX(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: SleepImplementation = defaultSleep,
): Promise<PublishResult> {
  assertXAccessToken(config);
  const parts = [{ text: payloadText(payload), media: payloadMedia(payload) }, ...payloadThread(payload)];
  const resumed = payload[CHAIN_RESUME_KEY];
  const publishedIds = Array.isArray(resumed) ? resumed.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  let raw: unknown = null;
  try {
    for (const part of parts.slice(publishedIds.length)) {
      const mediaIds: string[] = [];
      for (const item of part.media) {
        if (!item.localPath || !fs.existsSync(item.localPath)) continue;
        mediaIds.push(
          await uploadMedia(item.localPath, item.type === "VIDEO" ? "tweet_video" : "tweet_image", config, fetchImpl, sleepImpl),
        );
      }
      const parentId = publishedIds.at(-1);
      const body = JSON.stringify({
        text: formatPlatformText("x", part.text),
        ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}),
        ...(parentId ? { reply: { in_reply_to_tweet_id: parentId } } : {}),
      });
      const response = await ambiguousExternalMutation("x", () =>
        xFetch("https://api.x.com/2/tweets", config, fetchImpl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      );
      const result = await publishJson<{ data?: { id?: string } }>(response, "X tweet create");
      raw = result;
      const id = result.data?.id;
      // Nothing to reply to and nothing to settle on: the first post without an
      // id is not published, and a later one leaves the chain to resume.
      if (!id && publishedIds.length === 0) return { ok: false, id: null, url: null, raw };
      if (!id) throw new Error("x_tweet_missing_id");
      publishedIds.push(id);
    }
  } catch (error) {
    if (isAmbiguousPublicationError(error) || publishedIds.length === 0) throw error;
    return {
      ok: false,
      partial: true,
      retryable: true,
      resumeKey: CHAIN_RESUME_KEY,
      ids: publishedIds,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const [rootId] = publishedIds;
  if (!rootId) return { ok: false, id: null, url: null, raw };
  return { ok: true, id: rootId, ids: publishedIds, url: `https://x.com/i/web/status/${rootId}`, raw };
}

/** Where a half-published Article leaves the draft it already created. */
const ARTICLE_RESUME_KEY = "_xArticleDraftId";

/** Publishes an Article in the two calls X requires: a draft carrying the body,
 * then the publish that puts it in front of an audience.
 *
 * Only the second call can reach anyone, so only it is ambiguous when the
 * transport is lost. The draft id is handed back on a retryable failure so the
 * next attempt publishes the draft it already made instead of writing a second
 * one -- the same resume the Threads chain uses, under its own key. */
export async function publishXArticle(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: SleepImplementation = defaultSleep,
): Promise<PublishResult> {
  assertXAccessToken(config);
  // The queue stores a resume under its key as the id list it settled with.
  const resumed = payload[ARTICLE_RESUME_KEY];
  let articleId = Array.isArray(resumed) ? String(resumed.find((id) => typeof id === "string" && id.length > 0) ?? "") : "";

  if (!articleId) {
    const mediaIds: string[] = [];
    for (const item of payloadMedia(payload)) {
      if (item.type === "VIDEO" || !item.localPath || !fs.existsSync(item.localPath)) continue;
      mediaIds.push(await uploadMedia(item.localPath, "tweet_image", config, fetchImpl, sleepImpl));
    }
    const entities = Array.isArray(payload.entities) ? (payload.entities as Record<string, unknown>[]) : [];
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    if (!title) return { ok: false, error: "x_article_title_missing" };
    // A lost draft call has reached nobody: it is an ordinary retryable failure,
    // and the retry writes a fresh draft rather than adopting an unknown one.
    const draft = await publishJson<{ data?: { id?: string } }>(
      await xFetch("https://api.x.com/2/articles/draft", config, fetchImpl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content_state: toContentState(payloadText(payload), entities, mediaIds) }),
      }),
      "X article draft",
    );
    articleId = draft.data?.id ?? "";
    if (!articleId) return { ok: false, error: "x_article_draft_missing_id" };
  }

  try {
    const response = await ambiguousExternalMutation("x_article", () =>
      xFetch(`https://api.x.com/2/articles/${encodeURIComponent(articleId)}/publish`, config, fetchImpl, { method: "POST" }),
    );
    const result = await publishJson<{ data?: { id?: string } }>(response, "X article publish");
    const id = result.data?.id ?? articleId;
    return { ok: true, id, url: `https://x.com/i/article/${id}`, raw: result };
  } catch (error) {
    if (isAmbiguousPublicationError(error)) throw error;
    // The draft exists and nobody has seen it. Carrying its id forward is what
    // keeps a retry from leaving a second unpublished article behind.
    return {
      ok: false,
      partial: true,
      retryable: true,
      resumeKey: ARTICLE_RESUME_KEY,
      ids: [articleId],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function verifyXPost(id: string, config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<{ id: string }> {
  const response = await xFetch(`https://api.x.com/2/tweets/${encodeURIComponent(id)}`, config, fetchImpl, { method: "GET" });
  const result = await publishJson<{ data?: { id?: string } }>(response, "X post verify");
  if (result.data?.id !== id) throw new Error("X verification did not return the expected post");
  return { id };
}

async function uploadMedia(
  filePath: string,
  category: "tweet_image" | "tweet_video",
  config: BackendConfig,
  fetchImpl: typeof fetch,
  sleepImpl: SleepImplementation,
): Promise<string> {
  const initialized = await publishJson<{ data?: { id?: string } }>(
    await xFetch(`${UPLOAD_URL}/initialize`, config, fetchImpl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        total_bytes: fs.statSync(filePath).size,
        media_type: guessContentType(filePath),
        media_category: category,
      }),
    }),
    "X media INIT",
  );
  const mediaId = initialized.data?.id;
  if (!mediaId) throw new Error("X media INIT missing data.id");

  const handle = await fs.promises.open(filePath, "r");
  try {
    let position = 0;
    let segmentIndex = 0;
    const chunk = Buffer.alloc(2 * 1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const form = new FormData();
      form.set("segment_index", String(segmentIndex));
      // Copy out of the reusable read buffer: the next iteration overwrites it,
      // and nothing here guarantees the Blob has finished reading by then.
      const segment = Buffer.from(chunk.subarray(0, bytesRead));
      form.set("media", new Blob([segment], { type: "application/octet-stream" }), `segment-${segmentIndex}`);
      const response = await xFetch(`${UPLOAD_URL}/${mediaId}/append`, config, fetchImpl, { method: "POST", body: form });
      if (!response.ok) throw httpPublishError(response, await response.text(), `X media APPEND ${segmentIndex}`);
      position += bytesRead;
      segmentIndex += 1;
    }
  } finally {
    await handle.close();
  }

  const finalized = await publishJson<ProcessingResponse>(
    await xFetch(`${UPLOAD_URL}/${mediaId}/finalize`, config, fetchImpl, { method: "POST" }),
    "X media FINALIZE",
  );
  await waitForProcessing(mediaId, finalized.data?.processing_info ?? finalized.processing_info, config, fetchImpl, sleepImpl);
  return mediaId;
}

async function waitForProcessing(
  mediaId: string,
  initial: ProcessingInfo | undefined,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  sleepImpl: SleepImplementation,
): Promise<void> {
  let processing = initial;
  const deadline = Date.now() + 600_000;
  while (processing && ["pending", "in_progress"].includes(processing.state ?? "")) {
    if (Date.now() >= deadline) throw new Error("X media processing timeout");
    await sleepImpl(Math.max(1, processing.check_after_secs ?? 5) * 1000);
    const query = new URLSearchParams({ media_id: mediaId });
    const result = await publishJson<ProcessingResponse>(
      await xFetch(`${UPLOAD_URL}?${query}`, config, fetchImpl, { method: "GET" }),
      "X media STATUS",
    );
    processing = result.data?.processing_info ?? result.processing_info;
    if (processing?.state === "failed") throw new Error(`X video processing failed: ${processing.error?.message ?? "Unknown error"}`);
  }
}

type ProcessingInfo = { state?: string; check_after_secs?: number; error?: { message?: string } };
type ProcessingResponse = { data?: { processing_info?: ProcessingInfo }; processing_info?: ProcessingInfo };

async function xFetch(url: string, config: BackendConfig, fetchImpl: typeof fetch, init: RequestInit): Promise<Response> {
  assertXAccessToken(config);
  return externalFetch(fetchImpl, url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${config.X_ACCESS_TOKEN}` } });
}

function assertXAccessToken(config: BackendConfig): void {
  if (!config.X_ACCESS_TOKEN) throw new Error("missing X OAuth access token; connect X in Studio > Channels");
}
