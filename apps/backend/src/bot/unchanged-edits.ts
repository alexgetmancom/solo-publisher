import type { Bot } from "grammy";
import { recordTapUnchangedEdit } from "../foundation/tap-measurement.js";

/** How many messages the bot remembers the contents of. One operator holds one
 * screen and a handful of live cards; this is generous enough that the entry
 * for a card is still there when a worker refreshes it an hour later, and small
 * enough to be invisible against the container's memory. */
const REMEMBERED_MESSAGES = 200;

type Remembered = string;
const contents = new Map<string, Remembered>();

/**
 * Refuses to send a screen edit the message already shows.
 *
 * A tap that redraws the screen it is already on is a whole round trip -- the
 * one cost a button screen has -- spent to be told `message is not modified`.
 * Pagination clamped at the last page, the active period tapped again, a card
 * refreshed by a worker on a cycle where nothing moved: all of them pay it, and
 * `isUnchangedMessageEdit` exists because all of them arrive.
 *
 * The bot sent every one of those messages, so it knows what each one says
 * without asking. Remembering it turns those taps from ~380 ms into nothing.
 *
 * This has to run outside the menu plugin's own transformer, which is installed
 * per update and therefore wraps every transformer installed on the bot: by the
 * time the payload reaches here a `Menu` in `reply_markup` has already been
 * rendered to the keyboard it will actually send. Comparing before that would
 * compare a menu object with itself and skip edits that do change.
 *
 * Telegram's own rejection is still handled downstream. The memory is
 * process-local and starts empty, so the first edit of any message after a
 * restart is sent and answered by Telegram exactly as before.
 */
export function installUnchangedEditGuard(bot: Bot): void {
  bot.api.config.use(async (previous, method, payload, signal) => {
    const key = messageKey(payload);
    if (key !== null && method === "editMessageText") {
      const content = contentOf(payload);
      if (contents.get(key) === content) {
        recordTapUnchangedEdit();
        return { ok: true, result: true } as Awaited<ReturnType<typeof previous>>;
      }
      const response = await previous(method, payload, signal);
      if (response.ok) remember(key, content);
      return response;
    }
    // Any other write to a message this remembers leaves it showing something
    // the memory cannot describe -- a new keyboard, a caption, no message at
    // all. Forgetting is the only answer that cannot be wrong.
    if (key !== null) contents.delete(key);
    const response = await previous(method, payload, signal);
    // A message the bot just sent is a message whose contents it knows, so the
    // first redraw of a freshly sent screen is free too.
    if (method === "sendMessage" && response.ok) {
      const sent = response.result as { chat?: { id?: number | string }; message_id?: number } | undefined;
      if (sent?.chat?.id !== undefined && sent.message_id !== undefined) remember(`${sent.chat.id}:${sent.message_id}`, contentOf(payload));
    }
    return response;
  });
}

/** The message a payload writes to, or null when it names no single one:
 * an inline message the bot cannot address, or a method that is not about one
 * message at all. */
function messageKey(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { chat_id: chatId, message_id: messageId } = payload as { chat_id?: unknown; message_id?: unknown };
  if ((typeof chatId !== "number" && typeof chatId !== "string") || typeof messageId !== "number") return null;
  return `${chatId}:${messageId}`;
}

/** What a message will show, addressed apart from where it lives, so the text
 * a `sendMessage` put there compares equal to the `editMessageText` that would
 * put it there again. Key order comes from the one call site that builds the
 * payload and is stable; a reordering would cost a round trip, never a wrong
 * answer. */
function contentOf(payload: unknown): string {
  const rest = { ...(payload as Record<string, unknown>) };
  delete rest.chat_id;
  delete rest.message_id;
  return JSON.stringify(rest);
}

function remember(key: string, content: Remembered): void {
  contents.delete(key);
  contents.set(key, content);
  while (contents.size > REMEMBERED_MESSAGES) {
    const oldest = contents.keys().next().value;
    if (oldest === undefined) break;
    contents.delete(oldest);
  }
}
