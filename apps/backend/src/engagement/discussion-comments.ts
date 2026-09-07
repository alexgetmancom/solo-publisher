import { and, eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { telegramDiscussionThreads } from "../db/schema.js";
import { bindContainer, recordPostComment } from "./post-comments.js";

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

/** Telegram numbers messages per chat, not globally, so a comment is only
 * identified by the pair. */
const commentId = (chatId: string, messageId: number) => `${chatId}:${messageId}`;

const normalizeUsername = (value: string) => value.replace(/^@/, "").toLowerCase();

/**
 * Records one message from the channel's linked discussion group.
 *
 * Two shapes arrive here and only two are kept. The automatic forward opens a
 * thread and is the only message that names the channel post, so it is stored
 * as the thread's identity and nothing else. Everything else in a thread is a
 * comment. A message in neither shape -- someone talking in the group outside
 * any post, a private chat -- is not this feature's and is ignored.
 */
export function recordDiscussionMessage(backendDb: BackendDb, channelUsername: string, message: DiscussionMessage): DiscussionOutcome {
  if (message.chatType !== "group" && message.chatType !== "supergroup") return "ignored";
  const channel = normalizeUsername(channelUsername);
  if (!channel) return "ignored";
  const chatId = String(message.chatId);

  if (message.isAutomaticForward) {
    const origin = message.forwardOrigin;
    // Any channel may be forwarded into a group; only ours opens a thread here.
    if (!origin?.messageId || normalizeUsername(origin.chatUsername ?? "") !== channel) return "ignored";
    const channelPostId = String(origin.messageId);
    unsafeDb(backendDb)
      .db.insert(telegramDiscussionThreads)
      .values({ chatId, threadId: message.messageId, channelPostId, seenAt: message.date.toISOString() })
      .onConflictDoUpdate({
        target: [telegramDiscussionThreads.chatId, telegramDiscussionThreads.threadId],
        set: { channelPostId },
      })
      .run();
    // A thread the bot met late may already hold comments that could not name
    // their post. They can now.
    bindContainer(backendDb, "telegram", threadKey(chatId, message.messageId), channelPostId);
    return "thread";
  }

  const threadId = message.threadId;
  if (threadId === undefined) return "ignored";
  const outcome = recordPostComment(
    backendDb,
    {
      target: "telegram",
      commentId: commentId(chatId, message.messageId),
      externalPostId: resolveChannelPost(backendDb, chatId, threadId, message),
      containerId: threadKey(chatId, threadId),
      authorId: message.authorId === undefined ? null : String(message.authorId),
      author: message.authorName ?? "",
      text: message.text ?? "",
      // The forwarded post is the thread root, not a comment; answering it is
      // what a top-level comment does, and it has no parent comment.
      replyToCommentId:
        message.replyToMessageId === undefined || message.replyToMessageId === threadId
          ? null
          : commentId(chatId, message.replyToMessageId),
      sentAt: message.date,
      edited: message.edited,
    },
    message.date,
  );
  return outcome === "bound" ? "comment" : "unbound";
}

/** A thread is only a thread within its chat. */
const threadKey = (chatId: string, threadId: number) => `${chatId}:${threadId}`;

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
