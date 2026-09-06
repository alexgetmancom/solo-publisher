import { unlink } from "node:fs/promises";
import path from "node:path";
import { FRAME_SECONDS, frameFeatures } from "../analytics/collection/video-frames.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoFrameFeatures } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { zernioRequest } from "../foundation/external/zernio.js";

/** Instagram serves the file itself, and the source file this Studio uploaded
 * is long deleted by the retention sweep. The provider's analytics answer
 * carries a direct media URL for every Reel it published, which is the only
 * copy of a months-old video anyone here can still read frames from. */
/** The provider's paged answer for a whole account.
 *
 * Instagram signs its media links with an expiry of about a day. Asking for
 * one post by id returns the provider's stored copy, whose link is as old as
 * its last sync and therefore dead for anything but today's videos; asking for
 * the account's list mints them again. One paged read per run replaces one
 * refused download per video. */
type ZernioAccountAnalytics = {
  posts?: Array<{ _id?: string; latePostId?: string; mediaItems?: Array<{ type?: string; url?: string }> }>;
  pagination?: { page?: number; pages?: number };
};

/** How many posts to ask for per page. */
const PAGE_SIZE = 50;

/** Those URLs are signed and short-lived, so the file is fetched and read in
 * one pass and never stored. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Instagram serves its own media to its own account, but not at whatever rate
 * a script asks for: a run that pulled two dozen files back to back was
 * answered with 403 on everything after it. This is a catch-up sweep with no
 * deadline, so it waits. */
const PAUSE_BETWEEN_DOWNLOADS_MS = 4_000;

/** Once the platform starts refusing, it keeps refusing for a while. Stopping
 * says so plainly and leaves the rest for the next run, instead of turning one
 * throttle into a hundred failures in the report. */
const REFUSALS_BEFORE_STOPPING = 5;

/** The frames wanted are in the first seconds, and Instagram's progressive mp4
 * carries its index at the front, so the first few megabytes are enough. A
 * ranged read is also what a player does, which matters: the CDN answers a
 * plain full-file fetch from a datacenter with 403 while serving the same
 * range to a browser. */
const RANGE_BYTES = 3_000_000;

/** A CDN that serves people rather than scripts wants to see a browser. This
 * is our own media on our own account; the header is about being served, not
 * about pretending to be someone else. */
const DOWNLOAD_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
  Range: `bytes=0-${RANGE_BYTES}`,
} as const;

type Candidate = {
  videoDraftId: number;
  label: string | null;
  providerPostId: string | null;
  providerAccountId: string | null;
  localPath: string | null;
};

/**
 * Measures the first seconds of videos that have already been published.
 *
 * The opening is the one thing that decides a Short, and nothing recorded it:
 * whether Maru put her face in front, cut straight to gameplay, or stacked a
 * split screen was known only to whoever watched it. This reads it back off
 * the videos themselves.
 */
export async function backfillVideoFrames(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  input: { apply: boolean; limit: number },
): Promise<Record<string, unknown>> {
  const candidates = loadCandidates(backendDb).slice(0, input.limit);
  const measured: Array<Record<string, unknown>> = [];
  const failed: Array<{ ref: string; reason: string }> = [];
  const accountId = candidates.find((candidate) => candidate.providerAccountId)?.providerAccountId ?? null;
  const media =
    input.apply && accountId && candidates.some((candidate) => !candidate.localPath)
      ? await mediaIndex(config, fetchImpl, accountId, Math.ceil(candidates.length / PAGE_SIZE) + 1)
      : new Map<string, string>();
  let refusals = 0;
  let stopped: string | null = null;
  if (input.apply)
    for (const candidate of candidates) {
      if (refusals >= REFUSALS_BEFORE_STOPPING) {
        stopped = `the platform refused ${refusals} downloads in a row; the rest is left for a later run`;
        break;
      }
      const ref = `video:${candidate.videoDraftId}`;
      let temporary: string | null = null;
      try {
        const source = candidate.localPath ?? (await downloadReel(config, fetchImpl, candidate, media));
        if (!source) {
          failed.push({ ref, reason: "no readable copy of this video: no local file and no media URL from the provider" });
          continue;
        }
        temporary = candidate.localPath ? null : source;
        const capturedAt = new Date().toISOString();
        const shapes: string[] = [];
        for (const atSeconds of FRAME_SECONDS) {
          const features = await frameFeatures(source, atSeconds);
          shapes.push(features.shape);
          unsafeDb(backendDb)
            .db.insert(videoFrameFeatures)
            .values({
              videoDraftId: candidate.videoDraftId,
              atSeconds,
              featuresJson: { ...features },
              source: candidate.localPath ? "local_file" : "instagram_media",
              capturedAt,
            })
            .onConflictDoUpdate({
              target: [videoFrameFeatures.videoDraftId, videoFrameFeatures.atSeconds],
              set: { featuresJson: { ...features }, capturedAt },
            })
            .run();
        }
        measured.push({ ref, label: candidate.label, shapes });
        refusals = 0;
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        refusals = /media_download_failed: (403|429)/.test(reason) ? refusals + 1 : 0;
        failed.push({ ref, reason });
      } finally {
        if (temporary) {
          await unlink(temporary).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_DOWNLOADS_MS));
        }
      }
    }
  return {
    applied: input.apply,
    candidates: candidates.length,
    mediaLinks: media.size,
    measured: measured.length,
    ...(stopped ? { stopped } : {}),
    failed,
    sample: input.apply ? measured.slice(0, 5) : candidates.slice(0, 5).map((candidate) => `video:${candidate.videoDraftId}`),
  };
}

/** Published videos with no frame reading yet, newest first. */
function loadCandidates(backendDb: BackendDb): Candidate[] {
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT d.id AS videoDraftId, d.label AS label,
              (SELECT t.provider_post_id FROM video_targets t
                WHERE t.video_draft_id = d.id AND t.target = 'instagram_reels' AND t.provider_post_id IS NOT NULL LIMIT 1) AS providerPostId,
              (SELECT t.provider_account_id FROM video_targets t
                WHERE t.video_draft_id = d.id AND t.target = 'instagram_reels' AND t.provider_account_id IS NOT NULL LIMIT 1) AS providerAccountId,
              (SELECT a.local_path FROM studio_media_assets a WHERE a.id = d.studio_media_asset_id AND d.source_pruned_at IS NULL) AS localPath
         FROM video_drafts d
        WHERE EXISTS (SELECT 1 FROM video_targets t WHERE t.video_draft_id = d.id AND t.status = 'published')
          AND NOT EXISTS (SELECT 1 FROM video_frame_features f WHERE f.video_draft_id = d.id)
        ORDER BY d.id DESC`,
    )
    .all() as Candidate[];
}

/** Every media link the account will give us, minted now, keyed by both ids
 * the provider uses for a post. */
async function mediaIndex(
  config: BackendConfig,
  fetchImpl: typeof fetch,
  accountId: string,
  pagesNeeded: number,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (let page = 1; page <= pagesNeeded; page += 1) {
    const answer = await zernioRequest<ZernioAccountAnalytics>(
      config,
      `analytics?${new URLSearchParams({ accountId, limit: String(PAGE_SIZE), page: String(page) })}`,
      fetchImpl,
    );
    for (const post of answer.posts ?? []) {
      const url = post.mediaItems?.find((item) => item.type === "video" && item.url)?.url;
      if (!url) continue;
      if (post._id) index.set(post._id, url);
      if (post.latePostId) index.set(post.latePostId, url);
    }
    if ((answer.pagination?.pages ?? 1) <= page) break;
  }
  return index;
}

/** Fetches the published Reel into a temporary file and returns its path. */
async function downloadReel(
  config: BackendConfig,
  fetchImpl: typeof fetch,
  candidate: Candidate,
  media: Map<string, string>,
): Promise<string | null> {
  const url = candidate.providerPostId ? media.get(candidate.providerPostId) : null;
  if (!url) return null;
  const response = await fetchImpl(url, { headers: { ...DOWNLOAD_HEADERS }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok && response.status !== 206) throw new Error(`media_download_failed: ${response.status}`);
  const target = path.join(config.MEDIA_CACHE_DIR, `frame-source-${candidate.videoDraftId}.mp4`);
  await Bun.write(target, await response.arrayBuffer());
  return target;
}
