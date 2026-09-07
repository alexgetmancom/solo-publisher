import type { BackendConfig } from "../foundation/config.js";
import { zernioRequest } from "../foundation/external/zernio.js";
import { ExternalHttpError } from "../foundation/http.js";
import type { PublishResult } from "../publishing/errors.js";
import type { ClaimedPublishJob } from "../publishing/queue.js";
import type { InstagramMetadata } from "../publishing/video-types.js";
import { AmbiguousPublicationError, isAmbiguousTransportFailure } from "./ambiguous-publication.js";
import { payloadMedia, payloadText } from "./social/payload.js";

type ZernioPost = {
  _id?: string;
  id?: string;
  post?: ZernioPost;
  existingPost?: ZernioPost;
  status?: string;
  platforms?: Array<{ platform?: string; platformPostId?: string; platformPostUrl?: string; status?: string; error?: string }>;
  platformAnalytics?: Array<{
    platform?: string;
    platformPostId?: string;
    platformPostUrl?: string;
    status?: string;
    errorMessage?: string;
  }>;
};

type ZernioDuplicateError = {
  error?: string;
  details?: {
    accountId?: string;
    platform?: string;
    existingPostId?: string;
  };
};

export type ZernioPlatform = "threads" | "instagram";
type ZernioPublishResult = { providerPostId: string; externalId: string | null; url: string | null };
type ZernioPublicationInput = {
  accountId: string;
  platform: ZernioPlatform;
  content: string;
  mediaItems: { url: string; type: "image" | "video" }[];
  platformSpecificData?: Record<string, unknown>;
  requestId: string;
};

function postId(post: ZernioPost): string | null {
  return post._id ?? post.id ?? post.post?._id ?? post.post?.id ?? post.existingPost?._id ?? post.existingPost?.id ?? null;
}

/**
 * A post through the provider, for the targets that are not video.
 *
 * Threads and Instagram Stories reach the same endpoint the Reel does; what
 * differs is the platform name and, for a Story, the content type. The request
 * id fences retries of one logical target, so a repeat of the same delivery
 * returns the post that already exists rather than making a second one.
 */
async function publishZernioPublication(
  config: BackendConfig,
  input: ZernioPublicationInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ZernioPublishResult> {
  const create = () =>
    zernioRequest<ZernioPost>(config, "posts", fetchImpl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": input.requestId },
      body: JSON.stringify({
        content: input.content,
        mediaItems: input.mediaItems,
        platforms: [
          {
            platform: input.platform,
            accountId: input.accountId,
            ...(input.platformSpecificData ? { platformSpecificData: input.platformSpecificData } : {}),
          },
        ],
        publishNow: true,
      }),
    });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return zernioPublishResult(await create(), input.platform);
    } catch (error) {
      const reconciled = await reconcileZernioFailure(config, input.accountId, input.platform, error, fetchImpl);
      if (reconciled) return reconciled;
      if (!isAmbiguousTransportFailure(error)) throw error;
      if (attempt === 1) throw new AmbiguousPublicationError("zernio", error);
      // The request id makes one replay safe: Zernio returns `existingPost` for
      // the same logical publication instead of creating another visible post.
    }
  }
  throw new Error("Zernio publication retry loop ended unexpectedly");
}

/**
 * A delivery publisher for a target the registry routed through the provider.
 *
 * The media a provider takes is a public URL, which preparation has already
 * produced for everything it staged, so nothing here uploads bytes.
 */
export function zernioPublisher(
  config: BackendConfig,
  fetchImpl: typeof fetch,
  target: string,
  platform: "threads" | "instagram",
  accountId: string | null,
  contentType?: "story",
): (job: ClaimedPublishJob) => Promise<PublishResult> {
  return async (job) => {
    if (!config.ZERNIO_API_KEY) return { skipped: true, reason: "missing ZERNIO_API_KEY" };
    if (!accountId) return { skipped: true, reason: `${target} has no Zernio account id` };
    const media = payloadMedia(job.payload)
      .filter((item) => item.vpsUrl)
      .map((item) => ({ url: String(item.vpsUrl), type: item.type === "VIDEO" ? ("video" as const) : ("image" as const) }));
    // A Story is one visual and nothing else can stand in for it.
    if (contentType === "story" && media.length === 0) return { ok: false, error: "story_media_missing" };
    const published = await publishZernioPublication(
      config,
      {
        accountId,
        platform,
        content: payloadText(job.payload).trim(),
        mediaItems: contentType === "story" ? media.slice(0, 1) : media,
        ...(contentType ? { platformSpecificData: { contentType } } : {}),
        // One logical target, so a retry of the same delivery is answered with
        // the post that already exists instead of making a second one.
        requestId: `publish-target:${job.jobId}`,
      },
      fetchImpl,
    );
    return { ok: true, id: published.externalId ?? published.providerPostId, url: published.url, providerPostId: published.providerPostId };
  };
}

/** Zernio publishes at the durable publish job time. The request ID fences retries of this logical target. */
export async function publishZernioInstagramReel(
  config: BackendConfig,
  input: { accountId: string; publicUrl: string; metadata: InstagramMetadata; requestId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ZernioPublishResult> {
  return publishZernioPublication(
    config,
    {
      accountId: input.accountId,
      platform: "instagram",
      content: input.metadata.caption.trim(),
      mediaItems: [{ type: "video", url: input.publicUrl }],
      platformSpecificData: { contentType: "reels", shareToFeed: true },
      requestId: input.requestId,
    },
    fetchImpl,
  );
}

/**
 * What the provider says became of one publication: the platform link when it
 * landed, and the platform's own refusal when it did not.
 *
 * The provider accepts a publication before the platform has taken it, so
 * "created" is not "published" — a Reel can sit at the provider as `failed`
 * with nothing on the platform, and a Studio that read only the ids would show
 * an audience a post that does not exist.
 */
export async function zernioPostOutcome(
  config: BackendConfig,
  providerPostId: string,
  platform: ZernioPlatform,
  fetchImpl: typeof fetch = fetch,
): Promise<{ providerPostId: string; externalId: string | null; url: string | null; failure: string | null }> {
  const response = await zernioRequest<{ post?: ZernioPost } & ZernioPost>(
    config,
    `posts/${encodeURIComponent(providerPostId)}`,
    fetchImpl,
  );
  const post = response.post ?? response;
  const platformResult = (post.platforms ?? []).find((item) => item.platform === platform);
  const platformAnalytics = (post.platformAnalytics ?? []).find((item) => item.platform === platform);
  const failed = post.status === "failed" || platformResult?.status === "failed" || platformAnalytics?.status === "failed";
  return {
    ...zernioPublishResult(post as ZernioPost, platform, providerPostId),
    failure: failed
      ? (platformResult?.error ?? platformAnalytics?.errorMessage ?? "the provider reported this publication as failed")
      : null,
  };
}

export async function verifyZernioPost(
  config: BackendConfig,
  providerPostId: string,
  platform: ZernioPlatform,
  fetchImpl: typeof fetch = fetch,
): Promise<ZernioPublishResult> {
  const post = await zernioRequest<ZernioPost>(config, `posts/${encodeURIComponent(providerPostId)}`, fetchImpl);
  return zernioPublishResult(post, platform, providerPostId);
}

async function reconcileZernioFailure(
  config: BackendConfig,
  accountId: string,
  platform: ZernioPlatform,
  error: unknown,
  fetchImpl: typeof fetch,
): Promise<ZernioPublishResult | null> {
  const existingPostId = matchingDuplicatePostId(error, accountId, platform);
  if (!existingPostId) return null;
  try {
    return await verifyZernioPost(config, existingPostId, platform, fetchImpl);
  } catch {
    // The exact-account conflict is authoritative evidence. The lookup only
    // enriches it with the platform ID and URL, which may lag behind creation.
    return { providerPostId: existingPostId, externalId: null, url: null };
  }
}

function zernioPublishResult(post: ZernioPost, requestedPlatform: ZernioPlatform, expectedPostId?: string): ZernioPublishResult {
  const resolved = post.post ?? post.existingPost ?? post;
  const platform = [...(resolved.platforms ?? []), ...(resolved.platformAnalytics ?? [])].find(
    (item) => item.platform === requestedPlatform,
  );
  const id = postId(post);
  if (!id) throw new Error("Zernio did not return a post ID");
  if (expectedPostId && id !== expectedPostId) throw new Error("Zernio returned a different post during reconciliation");
  return { providerPostId: id, externalId: platform?.platformPostId ?? null, url: platform?.platformPostUrl ?? null };
}

function matchingDuplicatePostId(error: unknown, accountId: string, platform: ZernioPlatform): string | null {
  if (!(error instanceof ExternalHttpError) || error.status !== 409 || !error.body) return null;
  let response: ZernioDuplicateError;
  try {
    response = JSON.parse(error.body) as ZernioDuplicateError;
  } catch {
    return null;
  }
  const details = response.details;
  if (
    response.error !== "This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours." ||
    details?.accountId !== accountId ||
    details.platform !== platform ||
    typeof details.existingPostId !== "string" ||
    !details.existingPostId
  )
    return null;
  return details.existingPostId;
}
