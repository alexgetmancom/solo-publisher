import { and, desc, eq, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { socialComments, videoDrafts, videoTargets } from "../../db/schema.js";

export type SocialCommentThread = {
  platform: string;
  target: string;
  videoTargetId: number;
  url: string | null;
  label: string;
  comments: { commentId: string; author: string | null; text: string; likeCount: number; publishedAt: string | null }[];
};

/** The comments the video platforms answered with, newest video first.
 *
 * They arrive as enrichment on the video metrics checkpoint, not on a schedule
 * of their own, so an empty answer here means one of two different things --
 * nothing was said, or the checkpoint never reached the comment call. The
 * fetched-at of the newest comment is what tells them apart, which is why it is
 * reported rather than dropped. */
export function recentSocialComments(backendDb: BackendDb, limit: number): SocialCommentThread[] {
  const threads = unsafeDb(backendDb)
    .db.select({
      videoTargetId: socialComments.videoTargetId,
      platform: socialComments.platform,
      target: videoTargets.target,
      url: videoTargets.externalUrl,
      label: videoDrafts.label,
      latest: sql<string>`max(${socialComments.publishedAt})`,
    })
    .from(socialComments)
    .innerJoin(videoTargets, eq(videoTargets.id, socialComments.videoTargetId))
    .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
    .groupBy(socialComments.videoTargetId, socialComments.platform)
    .orderBy(desc(sql`max(${socialComments.publishedAt})`))
    .limit(limit)
    .all();

  return threads.map((thread) => ({
    platform: thread.platform,
    target: thread.target,
    videoTargetId: thread.videoTargetId,
    url: thread.url,
    label: thread.label,
    comments: unsafeDb(backendDb)
      .db.select({
        commentId: socialComments.commentId,
        author: socialComments.author,
        text: socialComments.text,
        likeCount: socialComments.likeCount,
        publishedAt: socialComments.publishedAt,
      })
      .from(socialComments)
      .where(and(eq(socialComments.videoTargetId, thread.videoTargetId), eq(socialComments.platform, thread.platform)))
      .orderBy(desc(socialComments.publishedAt))
      .all(),
  }));
}
