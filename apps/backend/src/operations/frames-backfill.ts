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
  posts?: Array<{
    _id?: string;
    latePostId?: string;
    thumbnailUrl?: string;
    mediaItems?: Array<{ type?: string; url?: string }>;
  }>;
  pagination?: { page?: number; pages?: number };
};

/** How many posts to ask for per page. */
const PAGE_SIZE = 50;

/** Those URLs are signed and short-lived, so the file is fetched and read in
 * one pass and never stored. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Instagram serves its own media to its own account, but not at whatever rate
 * a script asks for. This is a catch-up sweep with no deadline, so it waits. */
const PAUSE_BETWEEN_DOWNLOADS_MS = 4_000;

/** A video older than about a week is refused outright: the signed link the
 * account list mints still points at the file, and the CDN answers 403 for it
 * from any address, which two hosts on different networks confirm. The cover
 * image of the same post is served for as long as the post exists, so the
 * archive is measured from that -- one frame, the one the opening is judged
 * by, rather than three. */
const COVER_ONLY_SECONDS = [0] as const;

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

/** The cover is one small image, so it is asked for whole. */
const COVER_HEADERS = {
  "User-Agent": DOWNLOAD_HEADERS["User-Agent"],
  Accept: "image/jpeg,image/*;q=0.9,*/*;q=0.8",
} as const;

type Media = { video: string | null; cover: string | null };

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
      ? await mediaIndex(config, fetchImpl, accountId, candidates)
      : new Map<string, Media>();
  if (input.apply)
    for (const candidate of candidates) {
      const ref = `video:${candidate.videoDraftId}`;
      let temporary: string | null = null;
      try {
        const fetched = candidate.localPath ? null : await downloadOpening(config, fetchImpl, candidate, media);
        const source = candidate.localPath ?? fetched?.path ?? null;
        if (!source) {
          failed.push({ ref, reason: "no readable copy of this video: no local file, and the provider offers neither the file nor a cover" });
          continue;
        }
        temporary = candidate.localPath ? null : source;
        const from = candidate.localPath ? "local_file" : (fetched?.from ?? "instagram_media");
        const capturedAt = new Date().toISOString();
        const shapes: string[] = [];
        for (const atSeconds of from === "instagram_cover" ? COVER_ONLY_SECONDS : FRAME_SECONDS) {
          const features = await frameFeatures(source, atSeconds);
          shapes.push(features.shape);
          unsafeDb(backendDb)
            .db.insert(videoFrameFeatures)
            .values({ videoDraftId: candidate.videoDraftId, atSeconds, featuresJson: { ...features }, source: from, capturedAt })
            .onConflictDoUpdate({
              target: [videoFrameFeatures.videoDraftId, videoFrameFeatures.atSeconds],
              set: { featuresJson: { ...features }, capturedAt },
            })
            .run();
        }
        measured.push({ ref, label: candidate.label, from, shapes });
      } catch (error) {
        failed.push({ ref, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
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
    fromCover: measured.filter((entry) => entry.from === "instagram_cover").length,
    failed,
    sample: input.apply ? measured.slice(0, 5) : candidates.slice(0, 5).map((candidate) => `video:${candidate.videoDraftId}`),
    note: "A video Instagram still serves is read at 0, 1 and 3 seconds. An older one is refused from any address, and is read once from the post's cover instead: `from: instagram_cover` marks a reading that describes the cover Instagram shows, not the frame at zero seconds.",
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

/** Every link the account will give us for the posts wanted, minted now and
 * keyed by both ids the provider uses for a post.
 *
 * The pages are walked until every candidate is found rather than for a fixed
 * count: the videos still missing a reading are the oldest ones, and they sit
 * at the far end of an account's history. */
async function mediaIndex(
  config: BackendConfig,
  fetchImpl: typeof fetch,
  accountId: string,
  candidates: Candidate[],
): Promise<Map<string, Media>> {
  const wanted = new Set(candidates.map((candidate) => candidate.providerPostId).filter((id): id is string => Boolean(id)));
  const index = new Map<string, Media>();
  for (let page = 1; ; page += 1) {
    const answer = await zernioRequest<ZernioAccountAnalytics>(
      config,
      `analytics?${new URLSearchParams({ accountId, limit: String(PAGE_SIZE), page: String(page) })}`,
      fetchImpl,
    );
    for (const post of answer.posts ?? []) {
      const media: Media = {
        video: post.mediaItems?.find((item) => item.type === "video" && item.url)?.url ?? null,
        cover: post.thumbnailUrl ?? null,
      };
      if (!media.video && !media.cover) continue;
      for (const id of [post._id, post.latePostId]) {
        if (!id) continue;
        index.set(id, media);
        wanted.delete(id);
      }
    }
    if (wanted.size === 0 || (answer.pagination?.pages ?? 1) <= page) break;
  }
  return index;
}

/** Fetches enough of the opening to read it: the file itself when Instagram
 * still serves it, and otherwise the post's cover image, which it serves for
 * as long as the post exists. */
async function downloadOpening(
  config: BackendConfig,
  fetchImpl: typeof fetch,
  candidate: Candidate,
  index: Map<string, Media>,
): Promise<{ path: string; from: "instagram_media" | "instagram_cover" } | null> {
  const media = candidate.providerPostId ? index.get(candidate.providerPostId) : null;
  if (!media) return null;
  if (media.video) {
    const path = await fetchInto(fetchImpl, media.video, config, candidate, DOWNLOAD_HEADERS);
    if (path) return { path, from: "instagram_media" };
  }
  if (media.cover) {
    const path = await fetchInto(fetchImpl, media.cover, config, candidate, COVER_HEADERS);
    if (path) return { path, from: "instagram_cover" };
  }
  return null;
}

/** Writes what the CDN serves into the media cache, or answers null when it
 * refuses -- which for a video more than about a week old it always does. */
async function fetchInto(
  fetchImpl: typeof fetch,
  url: string,
  config: BackendConfig,
  candidate: Candidate,
  headers: Record<string, string>,
): Promise<string | null> {
  const response = await fetchImpl(url, { headers: { ...headers }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok && response.status !== 206) return null;
  const target = path.join(config.MEDIA_CACHE_DIR, `frame-source-${candidate.videoDraftId}`);
  await Bun.write(target, await response.arrayBuffer());
  return target;
}
