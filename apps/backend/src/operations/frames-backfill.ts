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
type ZernioPostAnalytics = {
  platforms?: Array<{ platform?: string; platformPostId?: string; mediaItems?: Array<{ type?: string; url?: string }> }>;
  platformPostId?: string;
  mediaItems?: Array<{ type?: string; url?: string }>;
};

/** The live read of what is actually on the account right now. Instagram signs
 * its media links with an expiry, and the analytics answer is served from the
 * provider's own cache -- so for anything older than the last sync its links
 * are already dead, while this endpoint mints new ones. It only reaches the
 * 25 most recent posts, which is why it is tried first and not alone. */
type ZernioPlatformPosts = {
  posts?: Array<{ id?: string; mediaUrl?: string; videoUrl?: string; mediaItems?: Array<{ type?: string; url?: string }> }>;
};

/** Those URLs are signed and short-lived, so the file is fetched and read in
 * one pass and never stored. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

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
  if (input.apply)
    for (const candidate of candidates) {
      const ref = `video:${candidate.videoDraftId}`;
      let temporary: string | null = null;
      try {
        const source = candidate.localPath ?? (await downloadReel(config, fetchImpl, candidate));
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
      } catch (error) {
        failed.push({ ref, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
      } finally {
        if (temporary) await unlink(temporary).catch(() => undefined);
      }
    }
  return {
    applied: input.apply,
    candidates: candidates.length,
    measured: measured.length,
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

/** A media link minted now, for one of the account's most recent posts. */
async function liveMediaUrl(
  config: BackendConfig,
  fetchImpl: typeof fetch,
  accountId: string,
  platformPostId: string,
): Promise<string | null> {
  try {
    const live = await zernioRequest<ZernioPlatformPosts>(config, `accounts/${accountId}/posts`, fetchImpl);
    const post = (live.posts ?? []).find((entry) => entry.id === platformPostId);
    return post?.videoUrl ?? post?.mediaUrl ?? post?.mediaItems?.find((item) => item.type === "video" && item.url)?.url ?? null;
  } catch {
    // The archive is the point of this command; a live read that refuses must
    // not stop the videos whose links are still good.
    return null;
  }
}

/** Fetches the published Reel into a temporary file and returns its path. */
async function downloadReel(config: BackendConfig, fetchImpl: typeof fetch, candidate: Candidate): Promise<string | null> {
  if (!candidate.providerPostId) return null;
  const data = await zernioRequest<ZernioPostAnalytics>(
    config,
    `analytics?${new URLSearchParams({ postId: candidate.providerPostId })}`,
    fetchImpl,
  );
  const instagram = data.platforms?.find((platform) => platform.platform === "instagram");
  const platformPostId = instagram?.platformPostId ?? data.platformPostId ?? null;
  const items = instagram?.mediaItems ?? data.mediaItems ?? [];
  const url =
    (candidate.providerAccountId && platformPostId
      ? await liveMediaUrl(config, fetchImpl, candidate.providerAccountId, platformPostId)
      : null) ?? items.find((item) => item.type === "video" && item.url)?.url;
  if (!url) return null;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`media_download_failed: ${response.status}`);
  const target = path.join(config.MEDIA_CACHE_DIR, `frame-source-${candidate.videoDraftId}.mp4`);
  await Bun.write(target, await response.arrayBuffer());
  return target;
}
