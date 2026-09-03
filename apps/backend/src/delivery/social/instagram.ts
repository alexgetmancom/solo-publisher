import type { BackendConfig } from "../../foundation/config.js";
import { type InstagramCredentials, instagramGraphHost } from "../../foundation/external/instagram.js";
import { externalFetch } from "../../foundation/http.js";
import { redactExternalSecrets } from "../../foundation/redact.js";
import type { PublishResult } from "../../publishing/errors.js";
import { httpPublishError } from "../../publishing/errors.js";
import { ambiguousExternalMutation } from "../ambiguous-publication.js";
import { InstagramContainerInvalidError, isExpiredInstagramContainer } from "./instagram-container.js";
import { payloadMedia } from "./payload.js";

type GraphResponse = {
  id?: string;
  permalink?: string;
  status?: string;
  status_code?: string;
  error?: { code?: number; message?: string };
};

type MediaProbe = {
  status: number | "unreachable";
  contentType: string | null;
  contentLength: string | null;
  error?: string;
};
type InstagramStoryState = {
  stage: "create" | "processing" | "ready" | "publish_sent";
  containerId?: string;
  publishedId?: string;
  polls: number;
  rebuilds: number;
  publishAttempts: number;
};

const INSTAGRAM_STATE_KEY = "_instagramStoryState";
const READY_POLLS = 30;
const PUBLISH_ATTEMPTS = 5;
const CONTAINER_ATTEMPTS = 2;
const POLL_DELAYS_MS = [250, 750, 1_500, 3_000, 5_000] as const;

export async function publishInstagramStory(
  payload: Record<string, unknown>,
  config: BackendConfig,
  credentials: InstagramCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  if (!credentials.accessToken) throw new Error("missing Instagram access token");
  if (!credentials.userId) throw new Error("missing Instagram user id");

  const media = payloadMedia(payload).find((item) => item.storyVpsUrl || item.vpsUrl);
  if (!media) return { ok: false, skipped: true, reason: "missing_public_media_url" };
  const publicUrl = media.storyVpsUrl || media.vpsUrl;
  if (!publicUrl) return { ok: false, skipped: true, reason: "missing_public_media_url" };
  const state = instagramStoryState(payload[INSTAGRAM_STATE_KEY]);
  if (!state || state.stage === "create") {
    const rebuilds = state?.rebuilds ?? 0;
    const creation = await graphPost(
      config,
      credentials,
      `${credentials.userId}/media`,
      {
        media_type: "STORIES",
        ...(media.type === "VIDEO" ? { video_url: publicUrl } : { image_url: publicUrl }),
      },
      fetchImpl,
    );
    if (!creation.id) return { ok: false, error: JSON.stringify(creation) };
    return deferredInstagram({ stage: "processing", containerId: creation.id, polls: 0, rebuilds, publishAttempts: 0 }, 250);
  }

  if (state.stage === "processing") {
    if (!state.containerId) throw new Error("instagram_story_state_missing_container");
    const status = await graphGet(config, credentials, state.containerId, { fields: "status_code,status" }, fetchImpl);
    const code = status.status_code ?? status.status;
    if (code === "FINISHED") return deferredInstagram({ ...state, stage: "ready" }, 0);
    if (code === "ERROR" || code === "EXPIRED") {
      if (state.rebuilds + 1 < CONTAINER_ATTEMPTS)
        return deferredInstagram(
          { stage: "create", polls: 0, rebuilds: state.rebuilds + 1, publishAttempts: 0 },
          pollDelay(state.rebuilds),
        );
      const mediaProbe = await probePublicMedia(publicUrl, fetchImpl);
      throw new InstagramContainerInvalidError(
        `Instagram container rejected media: ${JSON.stringify({
          containerId: state.containerId,
          statusCode: code,
          providerStatus: status.status ?? null,
          providerError: status.error ?? null,
          mediaType: media.type,
          publicUrl,
          mediaProbe,
        })}`,
      );
    }
    const polls = state.polls + 1;
    if (polls >= READY_POLLS) throw new Error(`instagram_container_timeout:${state.containerId}`);
    return deferredInstagram({ ...state, polls }, pollDelay(polls));
  }

  if (state.stage === "ready") {
    if (!state.containerId) throw new Error("instagram_story_state_missing_container");
    try {
      const published = await ambiguousExternalMutation("instagram_stories", () =>
        graphPost(config, credentials, `${credentials.userId}/media_publish`, { creation_id: state.containerId as string }, fetchImpl),
      );
      if (!published.id) return { ok: false, error: JSON.stringify(published) };
      return deferredInstagram({ ...state, stage: "publish_sent", publishedId: published.id }, 0);
    } catch (error) {
      if (!isExpiredInstagramContainer(error)) throw error;
      const publishAttempts = state.publishAttempts + 1;
      if (publishAttempts < PUBLISH_ATTEMPTS) return deferredInstagram({ ...state, publishAttempts }, pollDelay(publishAttempts));
      if (state.rebuilds + 1 < CONTAINER_ATTEMPTS)
        return deferredInstagram(
          { stage: "create", polls: 0, rebuilds: state.rebuilds + 1, publishAttempts: 0 },
          pollDelay(state.rebuilds),
        );
      throw new InstagramContainerInvalidError(error instanceof Error ? error.message : String(error));
    }
  }

  if (!state.publishedId) throw new Error("instagram_story_state_missing_publication");
  const published = await graphGet(config, credentials, state.publishedId, { fields: "id,permalink" }, fetchImpl);
  if (published.id !== state.publishedId) throw new Error("Instagram verification did not return the expected media");
  return {
    ok: true,
    id: state.publishedId,
    url: published.permalink ?? null,
    raw: published,
    verification: { status: "verified", providerId: state.publishedId },
  };
}

function deferredInstagram(state: InstagramStoryState, retryAfterMs: number): PublishResult {
  return {
    deferred: true,
    resumeKey: INSTAGRAM_STATE_KEY,
    resumeValue: state,
    retryAfterMs,
    state: state.stage,
  };
}

function instagramStoryState(value: unknown): InstagramStoryState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Partial<InstagramStoryState>;
  if (!state.stage || !["create", "processing", "ready", "publish_sent"].includes(state.stage)) return null;
  return {
    stage: state.stage,
    ...(typeof state.containerId === "string" ? { containerId: state.containerId } : {}),
    ...(typeof state.publishedId === "string" ? { publishedId: state.publishedId } : {}),
    polls: Number.isSafeInteger(state.polls) ? Number(state.polls) : 0,
    rebuilds: Number.isSafeInteger(state.rebuilds) ? Number(state.rebuilds) : 0,
    publishAttempts: Number.isSafeInteger(state.publishAttempts) ? Number(state.publishAttempts) : 0,
  };
}

function pollDelay(attempt: number): number {
  return POLL_DELAYS_MS[Math.min(Math.max(0, attempt), POLL_DELAYS_MS.length - 1)] ?? 5_000;
}

export async function verifyInstagramPublication(
  id: string,
  config: BackendConfig,
  credentials: InstagramCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; url: string | null }> {
  const media = await graphGet(config, credentials, id, { fields: "id,permalink" }, fetchImpl);
  if (media.id !== id) throw new Error("Instagram verification did not return the expected media");
  return { id, url: media.permalink ?? null };
}

async function probePublicMedia(publicUrl: string, fetchImpl: typeof fetch): Promise<MediaProbe> {
  try {
    const response = await externalFetch(fetchImpl, publicUrl, { method: "HEAD" });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
    };
  } catch (error) {
    return {
      status: "unreachable",
      contentType: null,
      contentLength: null,
      error: redactExternalSecrets(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function graphPost(
  config: BackendConfig,
  credentials: InstagramCredentials,
  path: string,
  payload: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<GraphResponse> {
  return graphRequest(config, credentials, path, fetchImpl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...payload, access_token: instagramToken(credentials) }),
  });
}

async function graphGet(
  config: BackendConfig,
  credentials: InstagramCredentials,
  path: string,
  query: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<GraphResponse> {
  const params = new URLSearchParams({ ...query, access_token: instagramToken(credentials) });
  return graphRequest(config, credentials, `${path}?${params}`, fetchImpl);
}

async function graphRequest(
  config: BackendConfig,
  credentials: InstagramCredentials,
  path: string,
  fetchImpl: typeof fetch,
  init?: RequestInit,
): Promise<GraphResponse> {
  const host = instagramGraphHost(credentials.accessToken ?? "");
  const version = config.INSTAGRAM_GRAPH_API_VERSION;
  const response = await externalFetch(fetchImpl, `https://${host}/${version}/${path.replace(/^\/+/, "")}`, init);
  const body = await response.text();
  if (!response.ok) throw httpPublishError(response, body, "Instagram API");
  return body ? (JSON.parse(body) as GraphResponse) : {};
}

function instagramToken(credentials: InstagramCredentials): string {
  if (!credentials.accessToken) throw new Error("missing Instagram access token");
  return credentials.accessToken;
}
