import { and, desc, eq, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { publicationTargets, telegramComments, telegramDiscussionThreads } from "../db/schema.js";

/** The parts of a Telegram message this reads. Written down rather than taken
 * from grammY's `Message`, because what is stored has to be visible in one
 * place -- and because the tests build these by hand. */
export type DiscussionMessage = {
  messageId: number;
  chatId: number | string;
  chatType: string;
  threadId?: number | undefined;
  isAutomaticForward?: boolean | undefined;
  /** Where an automatic forward came from: the channel, and the post's id. */
  forwardOrigin?: { chatUsername?: string | undefined; messageId?: number | undefined } | undefined;
  replyToMessageId?: number | undefined;
  /** Set when the replied-to message is itself the automatic forward, which is
   * what a top-level comment answers. */
  replyToIsAutomaticForward?: boolean | undefined;
  replyToForwardMessageId?: number | undefined;
  authorId?: number | undefined;
  authorName?: string | undefined;
  text?: string | undefined;
  date: Date;
  edited?: boolean | undefined;
};

export type DiscussionOutcome = "thread" | "comment" | "unbound" | "ignored";

const normalizeUsername = (value: string) => value.replace(/^@/, "").toLowerCase();

/**
 * Records one message from the channel's linked discussion group.
 *
 * Two shapes arrive here and only two are kept. The automatic forward opens a
 * thread and is the only message that names the channel post, so it is stored
 * as the thread's identity and nothing else. Everything else in a thread is a
 * comment. A message in neither shape -- someone talking in the group outside
 * any post, the bot's own replies, a private chat -- is not this feature's and
 * is ignored.
 *
 * `unbound` is a comment on a thread opened before the bot could see it: there
 * is no forward to learn the post from, so the comment is kept with the thread
 * it belongs to and no post. Dropping it instead would make the count wrong for
 * exactly the posts that already have the most discussion.
 */
export function recordDiscussionMessage(backendDb: BackendDb, channelUsername: string, message: DiscussionMessage): DiscussionOutcome {
  if (message.chatType !== "group" && message.chatType !== "supergroup") return "ignored";
  const channel = normalizeUsername(channelUsername);
  if (!channel) return "ignored";
  const chatId = String(message.chatId);
  const now = message.date.toISOString();

  if (message.isAutomaticForward) {
    const origin = message.forwardOrigin;
    // Any channel may be forwarded into a group; only ours opens a thread here.
    if (!origin?.messageId || normalizeUsername(origin.chatUsername ?? "") !== channel) return "ignored";
    unsafeDb(backendDb)
      .db.insert(telegramDiscussionThreads)
      .values({ chatId, threadId: message.messageId, channelPostId: String(origin.messageId), seenAt: now })
      .onConflictDoUpdate({
        target: [telegramDiscussionThreads.chatId, telegramDiscussionThreads.threadId],
        set: { channelPostId: String(origin.messageId) },
      })
      .run();
    // A thread the bot met late may already hold comments that could not name
    // their post. They can now.
    unsafeDb(backendDb)
      .db.update(telegramComments)
      .set({ channelPostId: String(origin.messageId) })
      .where(
        and(
          eq(telegramComments.chatId, chatId),
          eq(telegramComments.threadId, message.messageId),
          sql`${telegramComments.channelPostId} is null`,
        ),
      )
      .run();
    return "thread";
  }

  const threadId = message.threadId;
  if (threadId === undefined) return "ignored";
  const channelPostId = resolveChannelPost(backendDb, chatId, threadId, message);
  unsafeDb(backendDb)
    .db.insert(telegramComments)
    .values({
      chatId,
      messageId: message.messageId,
      threadId,
      channelPostId,
      authorId: message.authorId === undefined ? null : String(message.authorId),
      authorName: message.authorName ?? "",
      text: message.text ?? "",
      // The forwarded post is the thread root, not a comment; answering it is
      // what a top-level comment does, and it has no parent comment.
      replyToMessageId: message.replyToMessageId === threadId ? null : (message.replyToMessageId ?? null),
      sentAt: now,
      editedAt: message.edited ? now : null,
    })
    .onConflictDoUpdate({
      target: [telegramComments.chatId, telegramComments.messageId],
      // An edit rewrites what was said; who said it and when it first arrived
      // are not the edit's to change.
      set: { text: message.text ?? "", editedAt: now, ...(channelPostId ? { channelPostId } : {}) },
    })
    .run();
  return channelPostId ? "comment" : "unbound";
}

/** The thread's own record first; the forwarded post the comment answers is the
 * only other place the channel post is named. */
function resolveChannelPost(backendDb: BackendDb, chatId: string, threadId: number, message: DiscussionMessage): string | null {
  const known = unsafeDb(backendDb)
    .db.select({ channelPostId: telegramDiscussionThreads.channelPostId })
    .from(telegramDiscussionThreads)
    .where(and(eq(telegramDiscussionThreads.chatId, chatId), eq(telegramDiscussionThreads.threadId, threadId)))
    .get();
  if (known?.channelPostId) return known.channelPostId;
  if (message.replyToIsAutomaticForward && message.replyToForwardMessageId) return String(message.replyToForwardMessageId);
  return null;
}

type DiscussionComment = {
  messageId: number;
  author: string;
  text: string;
  sentAt: string;
  edited: boolean;
  replyToMessageId: number | null;
};

export type DiscussedPublication = {
  channelPostId: string;
  publicationKey: string | null;
  url: string | null;
  comments: DiscussionComment[];
};

/** The newest discussed posts, each with its comments oldest-first, which is
 * the order a conversation is read in. */
export function recentDiscussions(backendDb: BackendDb, limit = 10): DiscussedPublication[] {
  const posts = unsafeDb(backendDb)
    .db.select({
      channelPostId: telegramComments.channelPostId,
      latest: sql<string>`max(${telegramComments.sentAt})`,
    })
    .from(telegramComments)
    .where(sql`${telegramComments.channelPostId} is not null`)
    .groupBy(telegramComments.channelPostId)
    .orderBy(desc(sql`max(${telegramComments.sentAt})`))
    .limit(limit)
    .all();

  return posts.map((post) => {
    const channelPostId = String(post.channelPostId);
    const publication = unsafeDb(backendDb)
      .db.select({ publicationKey: publicationTargets.publicationKey, url: publicationTargets.url })
      .from(publicationTargets)
      .where(and(eq(publicationTargets.target, "telegram"), eq(publicationTargets.externalId, channelPostId)))
      .get();
    return {
      channelPostId,
      publicationKey: publication?.publicationKey ?? null,
      url: publication?.url ?? null,
      comments: commentsOf(backendDb, channelPostId),
    };
  });
}

function commentsOf(backendDb: BackendDb, channelPostId: string): DiscussionComment[] {
  return unsafeDb(backendDb)
    .db.select({
      messageId: telegramComments.messageId,
      authorName: telegramComments.authorName,
      text: telegramComments.text,
      sentAt: telegramComments.sentAt,
      editedAt: telegramComments.editedAt,
      replyToMessageId: telegramComments.replyToMessageId,
    })
    .from(telegramComments)
    .where(eq(telegramComments.channelPostId, channelPostId))
    .orderBy(telegramComments.sentAt)
    .all()
    .map((row) => ({
      messageId: row.messageId,
      author: row.authorName,
      text: row.text,
      sentAt: row.sentAt,
      edited: row.editedAt !== null,
      replyToMessageId: row.replyToMessageId,
    }));
}
