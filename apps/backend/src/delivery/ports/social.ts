import { createSerialQueue } from "../../../../../shared/serial-queue.js";
import { isStoryTarget } from "../../botTargets.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import { hasResumeState } from "../../publishing/delivery-payload.js";
import { selectMediaForTarget } from "../../publishing/media-policy.js";
import type { ClaimedPublishJob } from "../../publishing/queue.js";
import { prepareMediaItems } from "../media-prepare.js";
import { createPlatformAdapters, type TargetRouting } from "../platform-adapters.js";
import type { DeliveryPorts } from "../ports.js";
import { payloadMedia } from "../social/payload.js";
import { ensurePreparedStoryMedia } from "../story-derivatives.js";

type PreparedMedia = Awaited<ReturnType<typeof prepareMediaItems>>;
const MAX_PREPARATION_CACHE_ENTRIES = 32;

export function createPlatformPorts(config: BackendConfig, fetchImpl: typeof fetch = fetch, routing: TargetRouting = {}): DeliveryPorts {
  // Publisher instances own their preparation state. This prevents cache entries
  // from leaking between test runs or independently configured worker instances.
  const mediaCache = new Map<string, Promise<PreparedMedia>>();
  const enqueueMediaPreparation = createSerialQueue();
  const prepare = (job: ClaimedPublishJob, publisherConfig: BackendConfig) =>
    withPreparedMedia(job, publisherConfig, fetchImpl, mediaCache, enqueueMediaPreparation);
  return createPlatformAdapters(config, fetchImpl, prepare, routing);
}

async function withPreparedMedia(
  job: ClaimedPublishJob,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  mediaCache: Map<string, Promise<PreparedMedia>>,
  enqueue: <T>(prepare: () => Promise<T>) => Promise<T>,
): Promise<ClaimedPublishJob> {
  // A job carrying resume state is going back to finish a publication, not to
  // build one: the media it would prepare has already been uploaded and the
  // adapter will not look at it again.
  if (hasResumeState(job.payload)) return job;
  const media = payloadMedia(job.payload);
  if (media.length === 0) return job;
  // A Story is one vertical visual. Select the locale's first item before any
  // transformation: remaining album images belong only to feed targets and
  // must not consume Story-processing capacity. The Studio source is already
  // a local durable asset, so do not send it through ordinary feed staging
  // before Story rendering; that redundant step can otherwise stall a Story
  // before it ever reaches the Media Processing Port.
  const storySource = selectMediaForTarget(job.target, media);
  if (isStoryTarget(job.target)) log("info", "story delivery preparation started", { jobId: job.jobId, target: job.target });
  const sourceMedia = isStoryTarget(job.target) ? await requireStoryMedia(config, storySource) : storySource;
  const key = mediaCacheKey(job, sourceMedia, config);
  // One preparation per (post, target, media) within a delivery cycle. The
  // staged public copy is a cache; the Story derivative itself belongs to the
  // durable asset and is normally already there, made at ingress.
  let prepared = readBoundedCache(mediaCache, key);
  if (!prepared) {
    prepared = enqueue(() => prepareMediaItems(config, sourceMedia, fetchImpl, job.target));
    writeBoundedCache(mediaCache, key, prepared);
  }
  let items: PreparedMedia;
  try {
    items = await prepared;
  } catch (error) {
    mediaCache.delete(key);
    throw error;
  }
  return { ...job, payload: { ...job.payload, media: items } };
}

async function requireStoryMedia(config: BackendConfig, media: ReturnType<typeof payloadMedia>): Promise<ReturnType<typeof payloadMedia>> {
  const [source] = media;
  if (!source) return media;
  // Normally a read: ingress made the variant. It is still rendered here for an
  // asset older than that path, or one whose derivative did not survive the
  // disk, because a publication must not depend on when its file was imported.
  const prepared = await ensurePreparedStoryMedia(config, source);
  if (prepared) return [prepared];
  throw new Error("story_media_unavailable: the post carries no local media to render a Story from");
}

function mediaCacheKey(job: ClaimedPublishJob, media: ReturnType<typeof payloadMedia>, config: BackendConfig): string {
  return JSON.stringify({
    post: job.publicationKey,
    target: job.target,
    locale: job.payload.locale ?? "en",
    // Story media is a separately rendered 9:16 asset. It must never share
    // a preparation entry with the source image used by feed targets.
    story: isStoryTarget(job.target),
    media: media.map((item) => [item.fileId, item.localPath, item.type]),
    remote: config.REMOTE_MEDIA_PATH,
  });
}

function readBoundedCache<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function writeBoundedCache<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_PREPARATION_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}
