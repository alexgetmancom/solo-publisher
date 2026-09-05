import { and, desc, eq, inArray } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { videoDrafts, videoTargets } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { instagramCredentialsForLocale, instagramGraphHost } from "../../foundation/external/instagram.js";
import { youtubeAccessToken } from "../../foundation/external/youtube.js";
import { zernioRequest } from "../../foundation/external/zernio.js";
import { requestJson } from "../../foundation/http.js";
import { log } from "../../foundation/logger.js";
import { metricNumber, upsertComment } from "../snapshots/creator-store.js";

/**
 * Comment texts for one published video, on whichever platform carries it.
 *
 * Kept apart from the metric collectors because two callers now need exactly
 * this and nothing else: the metric schedule, which collects comments beside a
 * checkpoint reading, and the backfill operation, which sweeps every video ever
 * published without touching a snapshot.
 *
 * Two rules hold on every platform here. Every page is read, not the first one:
 * a page is the newest fifty or hundred, so a video that outgrows one page
 * would lose its oldest comments permanently. And replies are stored beside the
 * comments they answer: a platform's own comment counter includes them, so a
 * store that kept only thread roots could never be reconciled against the
 * number it is displayed next to.
 */

/** Every collector stops here. No video of this Studio's approaches it, and an
 * unbounded loop against a paginated API is how one bad cursor becomes a bill. */
const MAX_PAGES = 40;

type CommentTarget = {
  id: number;
  externalId: string;
  providerPostId: string | null;
  providerAccountId: string | null;
  locale: "ru" | "en";
};

type YouTubeThreads = {
  nextPageToken?: string;
  items?: Array<{
    id?: string;
    snippet?: { totalReplyCount?: number; topLevelComment?: { snippet?: YouTubeCommentSnippet } };
    replies?: { comments?: Array<{ id?: string; snippet?: YouTubeCommentSnippet }> };
  }>;
};
type YouTubeCommentSnippet = { textDisplay?: string; authorDisplayName?: string; likeCount?: number; publishedAt?: string };
type YouTubeComments = { nextPageToken?: string; items?: Array<{ id?: string; snippet?: YouTubeCommentSnippet }> };

type InstagramComment = {
  id?: string;
  text?: string;
  username?: string;
  timestamp?: string;
  like_count?: number;
  replies?: { data?: InstagramComment[]; paging?: { cursors?: { after?: string } } };
};
type InstagramComments = { data?: InstagramComment[]; paging?: { cursors?: { after?: string }; next?: string } };

type ZernioComment = {
  id?: string;
  message?: string;
  createdTime?: string;
  likeCount?: number;
  replyCount?: number;
  from?: { username?: string; name?: string };
  replies?: ZernioComment[];
};
type ZernioComments = { comments?: ZernioComment[]; pagination?: { hasMore?: boolean; cursor?: string | null } };

/**
 * YouTube.
 *
 * `commentThreads.list` answers with thread roots and, asked for them, up to
 * five replies inline. A thread that has more is finished with `comments.list`,
 * which is the only way to reach the rest.
 */
export async function collectYouTubeComments(
  backendDb: BackendDb,
  target: CommentTarget,
  token: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  const auth = { Authorization: `Bearer ${token}` };
  let stored = 0;
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      part: "snippet,replies",
      videoId: target.externalId,
      maxResults: "100",
      order: "time",
      ...(pageToken ? { pageToken } : {}),
    });
    const threads = await requestJson<YouTubeThreads>(fetchImpl, `https://www.googleapis.com/youtube/v3/commentThreads?${query}`, {
      headers: auth,
    });
    for (const thread of threads.items ?? []) {
      const root = thread.snippet?.topLevelComment?.snippet;
      if (!thread.id || !root?.textDisplay) continue;
      stored += store(backendDb, "youtube", target.id, thread.id, root, undefined);
      const inline = thread.replies?.comments ?? [];
      const total = metricNumber(thread.snippet?.totalReplyCount);
      // Inline replies are capped at five, so a busier thread is read out in
      // full rather than silently truncated to what the listing volunteered.
      const replies = total > inline.length ? await youtubeThreadReplies(thread.id, auth, fetchImpl) : inline;
      for (const reply of replies)
        if (reply.id && reply.snippet?.textDisplay) stored += store(backendDb, "youtube", target.id, reply.id, reply.snippet, thread.id);
    }
    if (!threads.nextPageToken) break;
    pageToken = threads.nextPageToken;
  }
  return stored;
}

async function youtubeThreadReplies(
  threadId: string,
  auth: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Array<{ id?: string; snippet?: YouTubeCommentSnippet }>> {
  const all: Array<{ id?: string; snippet?: YouTubeCommentSnippet }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ part: "snippet", parentId: threadId, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
    const answer = await requestJson<YouTubeComments>(fetchImpl, `https://www.googleapis.com/youtube/v3/comments?${query}`, {
      headers: auth,
    });
    all.push(...(answer.items ?? []));
    if (!answer.nextPageToken) break;
    pageToken = answer.nextPageToken;
  }
  return all;
}

function store(
  backendDb: BackendDb,
  platform: "youtube" | "instagram",
  videoTargetId: number,
  commentId: string,
  snippet: YouTubeCommentSnippet,
  parentCommentId: string | undefined,
): number {
  upsertComment(backendDb, {
    platform,
    commentId,
    videoTargetId,
    text: snippet.textDisplay ?? "",
    author: snippet.authorDisplayName,
    likeCount: metricNumber(snippet.likeCount),
    publishedAt: snippet.publishedAt,
    parentCommentId,
  });
  return 1;
}

/**
 * Instagram, through the platform's own Graph API.
 *
 * Replies ride along in the listing rather than costing a request each, which
 * is why they are asked for by field rather than fetched per comment.
 */
export async function collectInstagramComments(
  config: BackendConfig,
  backendDb: BackendDb,
  target: CommentTarget,
  fetchImpl: typeof fetch,
): Promise<number> {
  const { accessToken: token } = instagramCredentialsForLocale(config, target.locale);
  if (!token) throw new Error("Instagram credentials are missing");
  const base = `https://${instagramGraphHost(token)}/${config.INSTAGRAM_GRAPH_API_VERSION}/${target.externalId}/comments`;
  const fields = "id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}";
  let stored = 0;
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ fields, limit: "50", access_token: token, ...(after ? { after } : {}) });
    const answer = await requestJson<InstagramComments>(fetchImpl, `${base}?${query}`);
    for (const comment of answer.data ?? []) {
      if (!comment.id || !comment.text) continue;
      stored += storeInstagram(backendDb, target.id, comment, undefined);
      for (const reply of comment.replies?.data ?? [])
        if (reply.id && reply.text) stored += storeInstagram(backendDb, target.id, reply, comment.id);
    }
    const next = answer.paging?.next ? answer.paging.cursors?.after : undefined;
    if (!next) break;
    after = next;
  }
  return stored;
}

function storeInstagram(
  backendDb: BackendDb,
  videoTargetId: number,
  comment: InstagramComment,
  parentCommentId: string | undefined,
): number {
  upsertComment(backendDb, {
    platform: "instagram",
    commentId: comment.id ?? "",
    videoTargetId,
    text: comment.text ?? "",
    author: comment.username,
    likeCount: metricNumber(comment.like_count),
    publishedAt: comment.timestamp,
    parentCommentId,
  });
  return 1;
}

/**
 * Instagram, through the provider that publishes it.
 *
 * The provider's analytics answer is a flat map of numbers, so a Reel routed
 * this way had a comment count and no comments. Its engagement endpoint takes
 * the same provider post id and resolves it itself; on Instagram it also
 * accepts a comment id, which is how a thread deeper than the listing carries
 * is finished.
 */
export async function collectZernioComments(
  config: BackendConfig,
  backendDb: BackendDb,
  target: CommentTarget,
  fetchImpl: typeof fetch,
): Promise<number> {
  if (!target.providerPostId || !target.providerAccountId) return 0;
  let stored = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = await zernioComments(config, target.providerAccountId, target.providerPostId, cursor, fetchImpl);
    for (const comment of answer.comments ?? []) {
      if (!comment.id || !comment.message) continue;
      stored += storeZernio(backendDb, target.id, comment, undefined);
      const inline = comment.replies ?? [];
      const replies =
        metricNumber(comment.replyCount) > inline.length
          ? await zernioThreadReplies(config, target.providerAccountId, comment.id, fetchImpl)
          : inline;
      for (const reply of replies) if (reply.id && reply.message) stored += storeZernio(backendDb, target.id, reply, comment.id);
    }
    if (!answer.pagination?.hasMore || !answer.pagination.cursor) break;
    cursor = answer.pagination.cursor;
  }
  return stored;
}

async function zernioThreadReplies(
  config: BackendConfig,
  accountId: string,
  commentId: string,
  fetchImpl: typeof fetch,
): Promise<ZernioComment[]> {
  const all: ZernioComment[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = await zernioComments(config, accountId, commentId, cursor, fetchImpl);
    all.push(...(answer.comments ?? []));
    if (!answer.pagination?.hasMore || !answer.pagination.cursor) break;
    cursor = answer.pagination.cursor;
  }
  return all;
}

function zernioComments(
  config: BackendConfig,
  accountId: string,
  postId: string,
  cursor: string | undefined,
  fetchImpl: typeof fetch,
): Promise<ZernioComments> {
  const query = new URLSearchParams({ accountId, limit: "100", ...(cursor ? { cursor } : {}) });
  return zernioRequest<ZernioComments>(config, `inbox/comments/${encodeURIComponent(postId)}?${query}`, fetchImpl);
}

function storeZernio(backendDb: BackendDb, videoTargetId: number, comment: ZernioComment, parentCommentId: string | undefined): number {
  upsertComment(backendDb, {
    platform: "instagram",
    commentId: comment.id ?? "",
    videoTargetId,
    text: comment.message ?? "",
    author: comment.from?.username ?? comment.from?.name,
    likeCount: metricNumber(comment.likeCount),
    publishedAt: comment.createdTime,
    parentCommentId,
  });
  return 1;
}

/** Comment collection is enrichment: it never discards the checkpoint reading
 * it runs beside, and it never fails quietly either. */
export async function collectCommentsQuietly(collect: () => Promise<number>, context: Record<string, unknown>): Promise<number> {
  try {
    return await collect();
  } catch (error) {
    log("warn", "video comments unavailable", { ...context, error });
    return 0;
  }
}

/**
 * Every comment on every video this Studio has ever published.
 *
 * The metric schedule collects comments beside a checkpoint reading, which
 * means a video's comments arrive at that video's polling cadence -- up to a
 * week apart once it is a month old. That is the right cadence for keeping up
 * and the wrong one for catching up, which is what this is for: it reads the
 * platforms directly and writes only comments, leaving snapshots and the
 * schedule exactly as it found them.
 */
export async function backfillVideoComments(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch,
  options: { platforms: string[]; limit: number },
): Promise<Record<string, unknown>> {
  const rows = unsafeDb(backendDb)
    .db.select({
      id: videoTargets.id,
      target: videoTargets.target,
      externalId: videoTargets.externalId,
      providerPostId: videoTargets.providerPostId,
      providerAccountId: videoTargets.providerAccountId,
      deliveryProvider: videoTargets.deliveryProvider,
      locale: videoDrafts.locale,
    })
    .from(videoTargets)
    .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
    .where(and(eq(videoTargets.status, "published"), inArray(videoTargets.target, options.platforms)))
    .orderBy(desc(videoTargets.publishedAt))
    .limit(options.limit)
    .all();

  const tokens = new Map<string, string>();
  const failures: Array<{ videoTargetId: number; target: string; error: string }> = [];
  let stored = 0;
  let read = 0;
  for (const row of rows) {
    const locale = row.locale === "en" ? "en" : "ru";
    const target = {
      id: row.id,
      externalId: row.externalId ?? "",
      providerPostId: row.providerPostId,
      providerAccountId: row.providerAccountId,
      locale,
    } as const;
    try {
      if (row.target === "youtube_shorts") {
        if (!target.externalId) continue;
        // One token per language for the whole sweep. Refreshing per video
        // turns a revoked credential into a hundred identical OAuth failures.
        if (!tokens.has(locale)) tokens.set(locale, await youtubeAccessToken(config, fetchImpl, locale));
        stored += await collectYouTubeComments(backendDb, target, tokens.get(locale) as string, fetchImpl);
      } else if (row.deliveryProvider === "zernio") {
        stored += await collectZernioComments(config, backendDb, target, fetchImpl);
      } else {
        if (!target.externalId) continue;
        stored += await collectInstagramComments(config, backendDb, target, fetchImpl);
      }
      read += 1;
    } catch (error) {
      failures.push({ videoTargetId: row.id, target: row.target, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { videos: rows.length, read, stored, failed: failures.length, failures: failures.slice(0, 10) };
}
