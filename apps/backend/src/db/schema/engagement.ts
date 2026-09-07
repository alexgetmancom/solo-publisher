import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** What the audience wrote under a post, on whichever platform it published to.
 *
 * The video platforms answer under a video and keep their own store; a post is
 * a different aggregate, with a different identity, and this is its side. One
 * table rather than one per platform, because the question an operator asks --
 * what did people say about this post -- is not asked per platform, and two
 * tables would have meant two answers to it.
 */
export const postComments = sqliteTable(
  "post_comments",
  {
    /** The channel this was said on, spelled as Delivery spells it:
     * `telegram`, `threads_ru`, `threads_en`. */
    target: text().notNull(),
    /** The platform's own id for the comment. Telegram numbers messages per
     * chat rather than globally, so there it is `<chat>:<message>`. */
    commentId: text().notNull(),
    /** The post on the platform, as Delivery stored it in `external_id`. Null
     * only while it is not yet known -- see `containerId`. */
    externalPostId: text(),
    /** Where the platform put the comment when that is not the post itself.
     * Telegram is the case that needs it: a channel post has no comments, its
     * linked group holds a thread per post, and a comment names the thread. A
     * comment that arrives before that thread's opening forward has been seen
     * is kept here with no post, and is bound when the forward turns up. */
    containerId: text(),
    authorId: text(),
    author: text().notNull().default(""),
    text: text().notNull().default(""),
    /** The comment this one answers, when it answers a comment rather than the
     * post itself. */
    replyToCommentId: text(),
    sentAt: text().notNull(),
    /** Set when the text stored is no longer the first one that was said. */
    editedAt: text(),
    fetchedAt: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.target, table.commentId] }),
    index("idx_post_comments_post").on(table.externalPostId, table.sentAt),
    index("idx_post_comments_container").on(table.target, table.containerId),
    index("idx_post_comments_sent_at").on(table.sentAt),
  ],
);

/** Telegram's tie between a channel post and the thread that discusses it.
 *
 * The forward the channel bot drops into the linked group is the only message
 * that names both, so it is remembered on its own: every comment after it
 * carries the thread and never the post. */
export const telegramDiscussionThreads = sqliteTable(
  "telegram_discussion_threads",
  {
    chatId: text().notNull(),
    threadId: integer().notNull(),
    channelPostId: text().notNull(),
    seenAt: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.threadId] }),
    index("idx_telegram_discussion_threads_post").on(table.channelPostId),
  ],
);
