import type { BackendConfig } from "../../foundation/config.js";
import { type ThreadsTarget, threadsCredentials } from "../../foundation/external/threads.js";
import { formBody, requestJson } from "../../foundation/http.js";
import type { PublishResult } from "../../publishing/errors.js";
import { threadsBody, threadsTextLimit } from "../../publishing/threads-text.js";
import { ambiguousExternalMutation } from "../ambiguous-publication.js";
import { payloadMedia, payloadText, splitText } from "./payload.js";

type ThreadsResponse = {
  id?: string;
  permalink?: string;
  status?: string;
  error_message?: string;
};
type NowImplementation = () => number;
type ThreadsRuntime = { accessToken: string; containerTimeoutSeconds: number };
type ThreadsState = {
  stage:
    | "create_child"
    | "wait_child"
    | "create_primary"
    | "wait_primary"
    | "create_parent"
    | "publish"
    | "create_reply"
    | "wait_reply"
    | "verify";
  containerId?: string;
  childIds: string[];
  itemIndex: number;
  publishedIds: string[];
  partIndex: number;
  polls: number;
  carouselRebuilds: number;
  startedAtMs: number;
};

/** The adapter's own progress, and -- separately -- the ids that have reached
 * the audience: only the second may carry the resume prefix. */
const THREADS_PROGRESS_KEY = "threadsProgress";
const THREADS_RESUME_KEY = "_threadsPublishedIds";
const POLL_DELAYS_MS = [250, 750, 1_500, 3_000, 5_000] as const;

export async function publishToThreads(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
  target: ThreadsTarget = "threads_ru",
  nowImpl: NowImplementation = Date.now,
): Promise<PublishResult> {
  const runtime = threadsRuntime(config, target);
  if (!runtime) return { skipped: true, reason: `missing ${threadsCredentials(config, target).envName}` };
  // One post by default: the text is written to fit 500 characters and preflight
  // refuses the draft otherwise, so there is nothing to continue into. A chain is
  // only built when the author waived the rule for this draft and saw the cost.
  const chainApproved = payload.threadsChainApproved === true;
  const entities = Array.isArray(payload.entities) ? (payload.entities as Record<string, unknown>[]) : [];
  const text = threadsBody(target, payloadText(payload), entities, { chain: chainApproved }).text;
  const limit = threadsTextLimit(target);
  if (text.length > limit && !chainApproved) return { ok: false, error: `threads_text_too_long:${text.length}/${limit}` };
  const parts = chainApproved ? splitText(text, limit) : [text];
  const mediaItems = payloadMedia(payload).filter((item) => item.vpsUrl);
  const state = threadsState(payload[THREADS_PROGRESS_KEY]) ?? initialThreadsState(mediaItems.length, nowImpl());

  if (state.stage === "create_child") {
    const item = mediaItems[state.itemIndex];
    if (!item) throw new Error("threads_carousel_item_missing");
    const child = await callThreads(
      runtime,
      "me/threads",
      {
        media_type: item.type,
        is_carousel_item: true,
        [item.type === "VIDEO" ? "video_url" : "image_url"]: item.vpsUrl,
      },
      fetchImpl,
      "POST",
    );
    if (!child.id) throw new Error("threads_carousel_child_missing");
    return deferredThreads({ ...state, stage: "wait_child", containerId: child.id, polls: 0, startedAtMs: nowImpl() }, 250);
  }

  if (state.stage === "create_primary") {
    const item = mediaItems[0];
    const container = await callThreads(
      runtime,
      "me/threads",
      item
        ? { media_type: item.type, text: parts[0], [item.type === "VIDEO" ? "video_url" : "image_url"]: item.vpsUrl }
        : { media_type: "TEXT", text: parts[0] },
      fetchImpl,
      "POST",
    );
    if (!container.id) throw new Error("threads_container_missing");
    return deferredThreads({ ...state, stage: "wait_primary", containerId: container.id, polls: 0, startedAtMs: nowImpl() }, 250);
  }

  if (state.stage === "create_parent") {
    try {
      const parent = await callThreads(
        runtime,
        "me/threads",
        { media_type: "CAROUSEL", text: parts[0], children: state.childIds.join(",") },
        fetchImpl,
        "POST",
      );
      if (!parent.id) throw new Error("threads_carousel_parent_missing");
      return deferredThreads({ ...state, stage: "wait_primary", containerId: parent.id, polls: 0, startedAtMs: nowImpl() }, 250);
    } catch (error) {
      if (state.carouselRebuilds === 0 && isInvalidCarouselError(error)) {
        const { containerId: _containerId, ...withoutContainer } = state;
        return deferredThreads({ ...withoutContainer, stage: "create_child", childIds: [], itemIndex: 0, carouselRebuilds: 1 }, 250);
      }
      throw error;
    }
  }

  if (state.stage === "create_reply") {
    const parentId = state.publishedIds.at(-1);
    const part = parts[state.partIndex];
    if (!parentId || !part) throw new Error("threads_reply_state_invalid");
    const reply = await callThreads(runtime, "me/threads", { media_type: "TEXT", text: part, reply_to_id: parentId }, fetchImpl, "POST");
    if (!reply.id) throw new Error("threads_reply_container_missing");
    return deferredThreads({ ...state, stage: "wait_reply", containerId: reply.id, polls: 0, startedAtMs: nowImpl() }, 250);
  }

  if (state.stage === "wait_child" || state.stage === "wait_primary" || state.stage === "wait_reply") {
    if (!state.containerId) throw new Error("threads_state_missing_container");
    const status = await callThreads(runtime, state.containerId, { fields: "status,error_message" }, fetchImpl, "GET");
    if (status.status === "ERROR" || status.status === "EXPIRED")
      throw new Error(`Threads container ${state.containerId} failed: ${status.error_message ?? status.status}`);
    if (status.status !== "FINISHED") {
      if (nowImpl() >= state.startedAtMs + runtime.containerTimeoutSeconds * 1000)
        throw new Error(`Threads container ${state.containerId} timed out`);
      const polls = state.polls + 1;
      return deferredThreads({ ...state, polls }, pollDelay(polls));
    }
    if (state.stage === "wait_child") {
      const childIds = [...state.childIds, state.containerId];
      const itemIndex = state.itemIndex + 1;
      const { containerId: _containerId, ...withoutContainer } = state;
      return deferredThreads(
        { ...withoutContainer, stage: itemIndex < mediaItems.length ? "create_child" : "create_parent", childIds, itemIndex },
        0,
      );
    }
    return deferredThreads({ ...state, stage: "publish", containerId: state.containerId }, 0);
  }

  if (state.stage === "publish") {
    if (!state.containerId) throw new Error("threads_state_missing_container");
    const published = await ambiguousExternalMutation("threads", () =>
      callThreads(runtime, "me/threads_publish", { creation_id: state.containerId as string }, fetchImpl, "POST"),
    );
    if (!published.id) throw new Error("threads_publish_missing");
    const publishedIds = [...state.publishedIds, published.id];
    const partIndex = state.partIndex + 1;
    const { containerId: _containerId, ...withoutContainer } = state;
    return deferredThreads(
      {
        ...withoutContainer,
        stage: partIndex < parts.length ? "create_reply" : "verify",
        publishedIds,
        partIndex,
      },
      0,
    );
  }

  const rootId = state.publishedIds[0];
  if (!rootId) throw new Error("threads_state_missing_publication");
  const verified = await callThreads(runtime, rootId, { fields: "id,permalink" }, fetchImpl, "GET");
  if (verified.id !== rootId) throw new Error("Threads verification returned a different post");
  return {
    ok: true,
    id: rootId,
    ids: state.publishedIds,
    url: verified.permalink?.replace("threads.net", "threads.com") ?? null,
    verification: { status: "verified", providerId: rootId },
  };
}

function initialThreadsState(mediaCount: number, now: number): ThreadsState {
  return {
    stage: mediaCount > 1 ? "create_child" : "create_primary",
    childIds: [],
    itemIndex: 0,
    publishedIds: [],
    partIndex: 0,
    polls: 0,
    carouselRebuilds: 0,
    startedAtMs: now,
  };
}

function deferredThreads(state: ThreadsState, retryAfterMs: number): PublishResult {
  return {
    deferred: true,
    progressKey: THREADS_PROGRESS_KEY,
    progressValue: state,
    ...(state.publishedIds.length > 0 ? { resumeKey: THREADS_RESUME_KEY, resumeValue: state.publishedIds } : {}),
    retryAfterMs,
    state: state.stage,
  };
}

function threadsState(value: unknown): ThreadsState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Partial<ThreadsState>;
  const stages: ThreadsState["stage"][] = [
    "create_child",
    "wait_child",
    "create_primary",
    "wait_primary",
    "create_parent",
    "publish",
    "create_reply",
    "wait_reply",
    "verify",
  ];
  if (!state.stage || !stages.includes(state.stage)) return null;
  return {
    stage: state.stage,
    ...(typeof state.containerId === "string" ? { containerId: state.containerId } : {}),
    childIds: Array.isArray(state.childIds) ? state.childIds.filter((id): id is string => typeof id === "string") : [],
    itemIndex: integer(state.itemIndex),
    publishedIds: Array.isArray(state.publishedIds) ? state.publishedIds.filter((id): id is string => typeof id === "string") : [],
    partIndex: integer(state.partIndex),
    polls: integer(state.polls),
    carouselRebuilds: integer(state.carouselRebuilds),
    startedAtMs: typeof state.startedAtMs === "number" && Number.isFinite(state.startedAtMs) ? state.startedAtMs : Date.now(),
  };
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function pollDelay(attempt: number): number {
  return POLL_DELAYS_MS[Math.min(Math.max(0, attempt), POLL_DELAYS_MS.length - 1)] ?? 5_000;
}

export async function verifyThreadsPost(
  id: string,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
  target: ThreadsTarget = "threads_ru",
): Promise<{ id: string; url: string | null }> {
  const runtime = threadsRuntime(config, target);
  if (!runtime) throw new Error(`missing ${threadsCredentials(config, target).envName}`);
  const post = await callThreads(runtime, id, { fields: "id,permalink" }, fetchImpl, "GET");
  if (post.id !== id) throw new Error("Threads verification returned a different post");
  return { id, url: post.permalink?.replace("threads.net", "threads.com") ?? null };
}

function isInvalidCarouselError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return message.includes("4279004") || (message.includes("carousel") && message.includes("invalid"));
}

async function callThreads(
  runtime: ThreadsRuntime,
  endpoint: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
  method: "GET" | "POST" = "POST",
): Promise<ThreadsResponse> {
  const url = new URL(`https://graph.threads.net/v1.0/${endpoint}`);
  const body = formBody({ ...payload, access_token: runtime.accessToken });
  if (method === "GET") {
    for (const [key, value] of body.entries()) url.searchParams.append(key, value);
    return requestJson<ThreadsResponse>(fetchImpl, url.toString());
  }
  return requestJson<ThreadsResponse>(fetchImpl, url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

function threadsRuntime(config: BackendConfig, target: ThreadsTarget): ThreadsRuntime | null {
  const { accessToken } = threadsCredentials(config, target);
  return accessToken
    ? {
        accessToken,
        containerTimeoutSeconds: config.THREADS_CONTAINER_TIMEOUT_SECONDS,
      }
    : null;
}
