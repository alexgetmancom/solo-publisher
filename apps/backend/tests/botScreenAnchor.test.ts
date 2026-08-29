import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import type { PublicationEffect } from "../src/bot/effects.js";
import { executePublicationEffects } from "../src/bot/effects.js";
import type { BackendDb } from "../src/db/client.js";
import { withDb } from "./helpers/db.js";

type Recorder = { ctx: Context; edits: string[]; replies: string[] };

/** A tap: the update carries the message its button sits on. */
function tapped(messageId: number, options: { editFails?: true } = {}): Recorder {
  const edits: string[] = [];
  const replies: string[] = [];
  let nextMessageId = messageId;
  const ctx = {
    from: { id: 42 },
    chat: { id: 100 },
    callbackQuery: { data: "x", message: { message_id: messageId } },
    answerCallbackQuery: async () => true,
    editMessageText: async (text: string) => {
      if (options.editFails) throw new Error("Bad Request: message can't be edited");
      edits.push(text);
      return undefined;
    },
    reply: async (text: string) => {
      replies.push(text);
      nextMessageId += 1;
      return { message_id: nextMessageId };
    },
    replyWithPhoto: async () => {
      nextMessageId += 1;
      return { message_id: nextMessageId };
    },
  } as unknown as Context;
  return { ctx, edits, replies };
}

/** A typed message: there is nothing of the bot's to write over. */
function typed(): Recorder {
  const edits: string[] = [];
  const replies: string[] = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 100 },
    message: { text: "hi" },
    editMessageText: async (text: string) => void edits.push(text),
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 7 };
    },
  } as unknown as Context;
  return { ctx, edits, replies };
}

const screen = (text: string): PublicationEffect => ({ type: "screen", text });

describe("screen anchor", () => {
  it("writes the answer to a tap over the message that was tapped", () =>
    withDb(async (backendDb: BackendDb) => {
      const chat = tapped(10);

      await executePublicationEffects(chat.ctx, backendDb, [screen("The next question")]);

      expect(chat.edits).toEqual(["The next question"]);
      expect(chat.replies).toEqual([]);
    }));

  it("answers a typed message with a new message", () =>
    withDb(async (backendDb: BackendDb) => {
      const chat = typed();

      await executePublicationEffects(chat.ctx, backendDb, [screen("The next question")]);

      expect(chat.edits).toEqual([]);
      expect(chat.replies).toEqual(["The next question"]);
    }));

  /** One update writes over the tapped message once. A second screen would
   * otherwise overwrite the first, and the operator would see only the last. */
  it("sends every screen after the first as its own message", () =>
    withDb(async (backendDb: BackendDb) => {
      const chat = tapped(10);

      await executePublicationEffects(chat.ctx, backendDb, [screen("Scheduled"), screen("Here is the card")]);

      expect(chat.edits).toEqual(["Scheduled"]);
      expect(chat.replies).toEqual(["Here is the card"]);
    }));

  /** Media pushes the tapped message up the chat, so editing it after would
   * change something nobody is looking at any more. */
  it("stops writing over the tapped message once anything has been sent below it", () =>
    withDb(async (backendDb: BackendDb) => {
      const chat = tapped(10);

      await executePublicationEffects(chat.ctx, backendDb, [
        { type: "photo", path: "/tmp/story.png" },
        screen("Which cards do we publish?"),
      ]);

      expect(chat.edits).toEqual([]);
      expect(chat.replies).toEqual(["Which cards do we publish?"]);
    }));

  it("keeps the answer when Telegram refuses the edit", () =>
    withDb(async (backendDb: BackendDb) => {
      const chat = tapped(10, { editFails: true });

      await executePublicationEffects(chat.ctx, backendDb, [screen("The next question")]);

      expect(chat.replies).toEqual(["The next question"]);
    }));

  it("sends a message effect as its own message even when answering a tap", () =>
    withDb(async (backendDb: BackendDb) => {
      const chat = tapped(10);

      await executePublicationEffects(chat.ctx, backendDb, [{ type: "message", text: "That card is out of date" }]);

      expect(chat.edits).toEqual([]);
      expect(chat.replies).toEqual(["That card is out of date"]);
    }));
});
