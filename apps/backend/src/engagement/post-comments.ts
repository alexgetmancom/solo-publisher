import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { postComments, publicationTargets } from "../db/schema.js";

/** One comment as the platform handed it over. */
export type IncomingComment = {
  target: string;
  commentId: string;
  externalPostId: string | null;
  containerId?: string | null | undefined;
  authorId?: string | null | undefined;
  author?: string | undefined;
  text?: string | undefined;
  replyToCommentId?: string | null | undefined;
  sentAt: Date;
  edited?: boolean | undefined;
};

/** Stores one comment, and says whether it could be tied to a post.
 *
 * `unbound` is not a failure: Telegram can deliver a comment before the forward
 * that names its post, and dropping it would make the count wrong for exactly
 * the posts with the most discussion. `bindContainer` is what settles those. */
export function recordPostComment(backendDb: BackendDb, comment: IncomingComment, now = new Date()): "bound" | "unbound" {
  const fetchedAt = now.toISOString();
  const sentAt = comment.sentAt.toISOString();
  unsafeDb(backendDb)
    .db.insert(postComments)
    .values({
      target: comment.target,
      commentId: comment.commentId,
      externalPostId: comment.externalPostId,
      containerId: comment.containerId ?? null,
      authorId: comment.authorId ?? null,
      author: comment.author ?? "",
      text: comment.text ?? "",
      replyToCommentId: comment.replyToCommentId ?? null,
      sentAt,
      editedAt: comment.edited ? fetchedAt : null,
      fetchedAt,
    })
    .onConflictDoUpdate({
      target: [postComments.target, postComments.commentId],
      // What was said can change; who said it and when it first arrived cannot.
      // The post is only ever filled in, never cleared: a re-read that cannot
      // resolve it must not undo a binding that already succeeded.
      set: {
        text: comment.text ?? "",
        fetchedAt,
        ...(comment.edited ? { editedAt: fetchedAt } : {}),
        ...(comment.externalPostId ? { externalPostId: comment.externalPostId } : {}),
      },
    })
    .run();
  return comment.externalPostId ? "bound" : "unbound";
}

/** Ties every comment left in one container to the post that container turned
 * out to be about. */
export function bindContainer(backendDb: BackendDb, target: string, containerId: string, externalPostId: string): void {
  unsafeDb(backendDb)
    .db.update(postComments)
    .set({ externalPostId })
    .where(and(eq(postComments.target, target), eq(postComments.containerId, containerId), isNull(postComments.externalPostId)))
    .run();
}

export type DiscussedPublication = {
  target: string;
  externalPostId: string;
  publicationKey: string | null;
  url: string | null;
  comments: { commentId: string; author: string; text: string; sentAt: string; edited: boolean; replyToCommentId: string | null }[];
};

/** The most recently discussed posts, each with its comments oldest-first,
 * which is the order a conversation is read in. */
export function recentPostComments(backendDb: BackendDb, limit: number): DiscussedPublication[] {
  const posts = unsafeDb(backendDb)
    .db.select({
      target: postComments.target,
      externalPostId: postComments.externalPostId,
      latest: sql<string>`max(${postComments.sentAt})`,
    })
    .from(postComments)
    .where(sql`${postComments.externalPostId} is not null`)
    .groupBy(postComments.target, postComments.externalPostId)
    .orderBy(desc(sql`max(${postComments.sentAt})`))
    .limit(limit)
    .all();

  return posts.map((post) => {
    const externalPostId = String(post.externalPostId);
    const publication = unsafeDb(backendDb)
      .db.select({ publicationKey: publicationTargets.publicationKey, url: publicationTargets.url })
      .from(publicationTargets)
      .where(and(eq(publicationTargets.target, post.target), eq(publicationTargets.externalId, externalPostId)))
      .get();
    return {
      target: post.target,
      externalPostId,
      publicationKey: publication?.publicationKey ?? null,
      url: publication?.url ?? null,
      comments: unsafeDb(backendDb)
        .db.select({
          commentId: postComments.commentId,
          author: postComments.author,
          text: postComments.text,
          sentAt: postComments.sentAt,
          editedAt: postComments.editedAt,
          replyToCommentId: postComments.replyToCommentId,
        })
        .from(postComments)
        .where(and(eq(postComments.target, post.target), eq(postComments.externalPostId, externalPostId)))
        .orderBy(postComments.sentAt)
        .all()
        .map(({ editedAt, ...rest }) => ({ ...rest, edited: editedAt !== null })),
    };
  });
}

/** Comment text for the audience report, newest first. */
export function recentCommentTexts(backendDb: BackendDb, limit: number): { platform: string; text: string; at: string }[] {
  return unsafeDb(backendDb)
    .db.select({ platform: postComments.target, text: postComments.text, at: postComments.sentAt })
    .from(postComments)
    .where(sql`trim(${postComments.text}) <> ''`)
    .orderBy(desc(postComments.sentAt))
    .limit(limit)
    .all();
}
