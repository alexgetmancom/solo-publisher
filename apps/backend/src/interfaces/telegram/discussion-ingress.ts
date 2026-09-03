import type { Bot, Context } from "grammy";
import type { Message } from "grammy/types";
import type { BackendDb } from "../../db/client.js";
import { type DiscussionMessage, recordDiscussionMessage } from "../../engagement/discussion-comments.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";

/**
 * The channel's discussion group, read into the Studio.
 *
 * This is installed ahead of the admin gate, because the whole point is the
 * people who are not the operator: the gate answers a stranger's callback and
 * stops, which is right for every button and wrong for a comment. It writes and
 * calls `next()` regardless, so nothing downstream sees a group message it did
 * not see before -- the gate still refuses to act on one.
 */
export function installDiscussionIngress(bot: Bot, config: BackendConfig, backendDb: BackendDb): void {
  const record = (message: Message, edited: boolean) => {
    try {
      recordDiscussionMessage(backendDb, config.TELEGRAM_CHANNEL_USERNAME, describe(message, edited));
    } catch (error) {
      // A comment that cannot be stored is not worth failing the update over:
      // the same chain carries the operator's own taps.
      log("warn", "discussion comment not recorded", { chatId: message.chat.id, messageId: message.message_id, error: String(error) });
    }
  };
  bot.on("message", async (ctx: Context, next) => {
    if (ctx.message) record(ctx.message, false);
    await next();
  });
  bot.on("edited_message", async (ctx: Context, next) => {
    if (ctx.editedMessage) record(ctx.editedMessage, true);
    await next();
  });
}

/** grammY's message, narrowed to what Engagement stores. */
function describe(message: Message, edited: boolean): DiscussionMessage {
  const origin = message.forward_origin;
  const reply = message.reply_to_message;
  const replyOrigin = reply?.forward_origin;
  return {
    messageId: message.message_id,
    chatId: message.chat.id,
    chatType: message.chat.type,
    threadId: message.message_thread_id,
    isAutomaticForward: message.is_automatic_forward,
    forwardOrigin: origin?.type === "channel" ? { chatUsername: origin.chat.username, messageId: origin.message_id } : undefined,
    replyToMessageId: reply?.message_id,
    replyToIsAutomaticForward: reply?.is_automatic_forward,
    replyToForwardMessageId: replyOrigin?.type === "channel" ? replyOrigin.message_id : undefined,
    authorId: message.from?.id,
    authorName: authorName(message),
    text: message.text ?? message.caption ?? "",
    // Telegram dates are whole seconds since the epoch; an edit carries the
    // moment of the edit, which is what the row should say it now holds.
    date: new Date((edited ? (message.edit_date ?? message.date) : message.date) * 1000),
    edited,
  };
}

/** What the comment is signed with. A channel posting as itself has no `from`
 * worth showing, so the channel's own title is the name. */
function authorName(message: Message): string {
  if (message.sender_chat) return message.sender_chat.title ?? "";
  const from = message.from;
  if (!from) return "";
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "";
}
