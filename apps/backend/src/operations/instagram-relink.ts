import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { zernioRequest } from "../foundation/external/zernio.js";
import { IMPORTED_HISTORY } from "./archive-import.js";

/** How far apart the two copies of one video may be published. They go out
 * together, but a post crossing midnight in one timezone and not the other is
 * ordinary. */
const SAME_RELEASE_DAYS = 2;

/** How far two durations of the same file may read. One is Instagram's whole
 * seconds and the other is a container's own answer, so they disagree by
 * rounding and by nothing else. */
const SAME_LENGTH_SECONDS = 1.5;

const PAGE_SIZE = 50;

type ZernioPost = {
  _id?: string;
  publishedAt?: string;
  content?: string;
  platforms?: Array<{ accountId?: string; platformPostId?: string; analytics?: { videoDurationSeconds?: number } }>;
  analytics?: { videoDurationSeconds?: number };
};

type Candidate = { videoDraftId: number; label: string; publishedAt: string; durationSeconds: number | null };

/**
 * Finds the Instagram post that is the same video as one we only know from
 * YouTube.
 *
 * The channel's back catalogue went out on both platforms, but only the
 * YouTube side carries an id we can read off a downloaded file. Without the
 * Instagram post there is no skip rate for those videos, and the skip rate is
 * the one figure Instagram publishes about the first three seconds -- the
 * question the openings work exists to answer.
 *
 * Matched on the day and on the length of the file, and only where exactly one
 * post fits both. Two videos went out on the same day often enough that a day
 * alone decides nothing, and a wrongly attached skip rate is worse than a
 * missing one: a missing figure is visible and a wrong one is not.
 */
export async function relinkInstagramPosts(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  input: { apply: boolean; accountId: string },
): Promise<Record<string, unknown>> {
  const candidates = loadCandidates(backendDb);
  const taken = new Set(
    (
      unsafeDb(backendDb)
        .sqlite.prepare("SELECT provider_post_id AS id FROM video_targets WHERE provider_post_id IS NOT NULL")
        .all() as Array<{ id: string }>
    ).map((row) => row.id),
  );
  const posts = (await allPosts(config, fetchImpl, input.accountId)).filter((post) => !taken.has(post._id ?? ""));
  const linked: Array<Record<string, unknown>> = [];
  const ambiguous: Array<Record<string, unknown>> = [];
  const unmatched: string[] = [];
  const used = new Set<string>();
  for (const candidate of candidates) {
    const seconds = candidate.durationSeconds;
    if (seconds === null) {
      unmatched.push(`video:${candidate.videoDraftId}: its length is not known, so a day is all there is to go on`);
      continue;
    }
    const fits = posts.filter((post) => {
      if (used.has(post._id ?? "")) return false;
      const length = post.analytics?.videoDurationSeconds ?? post.platforms?.[0]?.analytics?.videoDurationSeconds;
      if (!post.publishedAt || !length) return false;
      const apart = Math.abs(Date.parse(post.publishedAt) - Date.parse(candidate.publishedAt)) / 86_400_000;
      return apart <= SAME_RELEASE_DAYS && Math.abs(length - seconds) <= SAME_LENGTH_SECONDS;
    });
    if (fits.length !== 1) {
      const entry = {
        ref: `video:${candidate.videoDraftId}`,
        label: candidate.label.slice(0, 60),
        seconds: candidate.durationSeconds,
        fits: fits.length,
        posts: fits.slice(0, 3).map((post) => ({ publishedAt: post.publishedAt, caption: (post.content ?? "").slice(0, 60) })),
      };
      if (fits.length === 0) unmatched.push(`${entry.ref}: no post of that length went out within two days`);
      else ambiguous.push(entry);
      continue;
    }
    const post = fits[0];
    const platform = post?.platforms?.find((row) => row.accountId === input.accountId) ?? post?.platforms?.[0];
    if (!post?._id || !platform?.platformPostId) continue;
    used.add(post._id);
    if (input.apply)
      unsafeDb(backendDb)
        .db.insert(videoTargets)
        .values({
          videoDraftId: candidate.videoDraftId,
          target: "instagram_reels",
          metadataJson: { caption: post.content ?? "" },
          status: "published",
          deliveryProvider: "zernio",
          providerAccountId: input.accountId,
          providerPostId: post._id,
          externalId: platform.platformPostId,
          publishedAt: post.publishedAt,
          confirmationSource: IMPORTED_HISTORY,
          createdAt: post.publishedAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
    linked.push({ ref: `video:${candidate.videoDraftId}`, label: candidate.label.slice(0, 50), publishedAt: post.publishedAt });
  }
  return {
    applied: input.apply,
    candidates: candidates.length,
    linked: linked.length,
    ambiguous: ambiguous.slice(0, 15),
    ambiguousCount: ambiguous.length,
    unmatchedCount: unmatched.length,
    unmatched: unmatched.slice(0, 10),
    sample: linked.slice(0, 5),
    note: "A video is linked only where exactly one post shares its day and its length. Anything else is listed rather than guessed: a skip rate attached to the wrong video is worse than none, because a missing figure is visible and a wrong one is not.",
  };
}

/** Videos published on YouTube that have no Instagram copy recorded. */
function loadCandidates(backendDb: BackendDb): Candidate[] {
  return (
    unsafeDb(backendDb)
      .sqlite.prepare(
        `SELECT d.id AS videoDraftId, d.label AS label, t.published_at AS publishedAt,
                json_extract(t.metadata_json, '$.videoDurationMs') AS durationMs
           FROM video_drafts d
           JOIN video_targets t ON t.video_draft_id = d.id AND t.target = 'youtube_shorts' AND t.status = 'published'
          WHERE t.published_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM video_targets i WHERE i.video_draft_id = d.id AND i.target = 'instagram_reels')
          ORDER BY t.published_at DESC`,
      )
      .all() as Array<Candidate & { durationMs: number | null }>
  ).map((row) => ({ ...row, durationSeconds: row.durationMs ? row.durationMs / 1000 : null }));
}

/** Every post the account has, minted fresh. */
async function allPosts(config: BackendConfig, fetchImpl: typeof fetch, accountId: string): Promise<ZernioPost[]> {
  const posts: ZernioPost[] = [];
  for (let page = 1; ; page += 1) {
    const answer = await zernioRequest<{ posts?: ZernioPost[]; pagination?: { pages?: number } }>(
      config,
      `analytics?${new URLSearchParams({ accountId, limit: String(PAGE_SIZE), page: String(page) })}`,
      fetchImpl,
    );
    posts.push(...(answer.posts ?? []));
    if ((answer.pagination?.pages ?? 1) <= page) break;
  }
  return posts;
}
