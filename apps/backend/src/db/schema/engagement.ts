import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** What the channel's discussion group says back, kept beside the publication
 * it is about.
 *
 * Telegram gives a channel post no comments of its own: the linked group holds
 * them, and the tie between the two is one message the channel bot forwards
 * into that group when the post goes out. Every comment then hangs off that
 * forward. So the forward is what has to be remembered -- a comment carries the
 * thread it is in, never the channel post the thread is about.
 */
export const telegramDiscussionThreads = sqliteTable(
  "telegram_discussion_threads",
  {
    chatId: text().notNull(),
    /** The forwarded copy's id in the group, which is also every comment's
     * `message_thread_id`. */
    threadId: integer().notNull(),
    /** The post in the channel, as Delivery stored it in `external_id`. */
    channelPostId: text().notNull(),
    seenAt: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.threadId] }),
    index("idx_telegram_discussion_threads_post").on(table.channelPostId),
  ],
);

export const telegramComments = sqliteTable(
  "telegram_comments",
  {
    chatId: text().notNull(),
    messageId: integer().notNull(),
    threadId: integer().notNull(),
    /** Denormalised from the thread so a comment can be read without it, and
     * so a thread the bot never saw opened does not silently drop comments. */
    channelPostId: text(),
    authorId: text(),
    authorName: text().notNull().default(""),
    text: text().notNull().default(""),
    /** The comment this one answers, when it answers a comment rather than the
     * post. Null for a reply to the forwarded post itself. */
    replyToMessageId: integer(),
    sentAt: text().notNull(),
    /** An edit arrives as a separate update carrying the same message id, so
     * the row is rewritten and this says the text is no longer the first one. */
    editedAt: text(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.messageId] }),
    index("idx_telegram_comments_post").on(table.channelPostId, table.sentAt),
    index("idx_telegram_comments_sent_at").on(table.sentAt),
  ],
);
