import { describe, expect, it } from "bun:test";
import { Bot, InlineKeyboard } from "grammy";
import { installUnchangedEditGuard } from "../src/bot/unchanged-edits.js";

/** A bot whose innermost transformer answers instead of the network, so the
 * guard can be asked the only question it exists to answer: which calls did it
 * let through? Installed first, it sits inside the guard exactly as the real
 * fetch does. */
function recordingBot(): { bot: Bot; calls: string[] } {
  const bot = new Bot("1:test");
  const calls: string[] = [];
  bot.api.config.use(async (_previous, method) => {
    calls.push(method);
    return { ok: true, result: method === "sendMessage" ? { message_id: 7, chat: { id: 100 } } : true } as never;
  });
  installUnchangedEditGuard(bot);
  return { bot, calls };
}

describe("unchanged screen edits", () => {
  it("sends a redraw once and refuses the identical one behind it", async () => {
    const { bot, calls } = recordingBot();
    const screen = { reply_markup: new InlineKeyboard().text("Menu", "menu_home") };

    await bot.api.editMessageText(100, 1, "Queue", screen);
    await bot.api.editMessageText(100, 1, "Queue", screen);

    expect(calls).toEqual(["editMessageText"]);
  });

  it("sends a redraw whose text or keyboard moved", async () => {
    const { bot, calls } = recordingBot();

    await bot.api.editMessageText(100, 2, "Queue", { reply_markup: new InlineKeyboard().text("Menu", "menu_home") });
    await bot.api.editMessageText(100, 2, "Queue · 3", { reply_markup: new InlineKeyboard().text("Menu", "menu_home") });
    await bot.api.editMessageText(100, 2, "Queue · 3", { reply_markup: new InlineKeyboard().text("Back", "queue_home") });

    expect(calls).toEqual(["editMessageText", "editMessageText", "editMessageText"]);
  });

  it("forgets a message another call wrote to", async () => {
    const { bot, calls } = recordingBot();

    await bot.api.editMessageText(100, 3, "Queue");
    await bot.api.editMessageReplyMarkup(100, 3, { reply_markup: new InlineKeyboard().text("Menu", "menu_home") });
    // The keyboard under it changed, so the same text is a different screen.
    await bot.api.editMessageText(100, 3, "Queue");

    expect(calls).toEqual(["editMessageText", "editMessageReplyMarkup", "editMessageText"]);
  });

  it("knows what a message it just sent already says", async () => {
    const { bot, calls } = recordingBot();

    await bot.api.sendMessage(100, "Queue", { reply_markup: new InlineKeyboard().text("Menu", "menu_home") });
    await bot.api.editMessageText(100, 7, "Queue", { reply_markup: new InlineKeyboard().text("Menu", "menu_home") });

    expect(calls).toEqual(["sendMessage"]);
  });

  it("leaves messages it has never written apart", async () => {
    const { bot, calls } = recordingBot();

    await bot.api.editMessageText(100, 4, "Queue");
    await bot.api.editMessageText(100, 5, "Queue");

    expect(calls).toEqual(["editMessageText", "editMessageText"]);
  });
});
