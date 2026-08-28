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
import { generateStoryMedia } from "../story-media.js";

type PreparedMedia = Awaited<ReturnType<typeof prepareMediaItems>>;
const MAX_PREPARATION_CACHE_ENTRIES = 32;

export function createPlatformPorts(config: BackendConfig, fetchImpl: typeof fetch = fetch, routing: TargetRouting = {}): DeliveryPorts {
  // Publisher instances own their preparation state. This prevents cache entries
  // from leaking between test runs or independently configured worker instances.
  const mediaCache = new Map<string, Promise<PreparedMedia>>();
  // VM-106 accepts one ffmpeg job at a time.  Rendering had previously been
  // started before the ordinary media-preparation queue, so three Story
  // targets for one post could open concurrent streamed requests through the
  // SSH tunnel.  Keep that resource explicit and share the finished render
  // between Telegram and Instagram targets of the same locale.
  const storyMediaCache = new Map<string, Promise<ReturnType<typeof payloadMedia>>>();
  const enqueueMediaPreparation = createSerialQueue();
  const enqueueStoryPreparation = createSerialQueue();
  const prepare = (job: ClaimedPublishJob, publisherConfig: BackendConfig) =>
    withPreparedMedia(job, publisherConfig, fetchImpl, mediaCache, enqueueMediaPreparation, (job, media) => {
      const key = storyMediaCacheKey(job, media);
      let rendered = readBoundedCache(storyMediaCache, key);
      if (!rendered) {
        rendered = enqueueStoryPreparation(() => createStoryMedia(job, media, publisherConfig));
        writeBoundedCache(storyMediaCache, key, rendered);
      }
      return rendered.catch((error) => {
        storyMediaCache.delete(key);
        throw error;
      });
    });
  return createPlatformAdapters(config, fetchImpl, prepare, routing);
}

async function withPreparedMedia(
  job: ClaimedPublishJob,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  mediaCache: Map<string, Promise<PreparedMedia>>,
  enqueue: <T>(prepare: () => Promise<T>) => Promise<T>,
  renderStory: (job: ClaimedPublishJob, media: ReturnType<typeof payloadMedia>) => Promise<ReturnType<typeof payloadMedia>>,
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
  const sourceMedia = isStoryTarget(job.target) ? await renderStory(job, storySource) : storySource;
  const key = mediaCacheKey(job, sourceMedia, config);
  // One preparation per (post, target, media) within a delivery cycle. The
  // rendered files persist on disk and are aged out by pruneMediaCache, so
  // there is no per-user refcount: nothing here owns eager deletion.
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

async function createStoryMedia(job: ClaimedPublishJob, media: ReturnType<typeof payloadMedia>, config: BackendConfig) {
  const [source] = media;
  if (!source) return media;
  // A prior attempt may already have rendered a valid Story asset. Reusing it
  // is both idempotent and essential for recovery: retrying must not depend on
  // re-downloading or re-transcoding an unchanged source video.
  if (source.storyLocalPath) return [source];
  const locale = job.payload.locale === "ru" ? "ru" : "en";
  const draftId = Number(job.payload.draftId ?? job.jobId);
  return generateStoryMedia([source], Number.isSafeInteger(draftId) ? draftId : job.jobId, locale, config);
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

function storyMediaCacheKey(job: ClaimedPublishJob, media: ReturnType<typeof payloadMedia>): string {
  return JSON.stringify({
    draft: job.payload.draftId ?? job.publicationKey,
    locale: job.payload.locale ?? "en",
    media: media.map((item) => [item.fileId, item.localPath, item.type]),
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
