import { run } from "@grammyjs/runner";
import type { Bot } from "grammy";
import { log } from "../foundation/logger.js";

/** A running bot, in the only two terms its owner needs. */
export type BotRunner = { isRunning: () => boolean; stop: () => Promise<void> };

/**
 * Drives the bot with the concurrent runner rather than `bot.start()`.
 *
 * The built-in poller handles one update at a time, so a tap's acknowledgement
 * sat behind the previous tap's screen edit and a burst of taps produced buttons
 * that visibly hang. Ordering that actually matters is kept by `sequentialize()`
 * inside the handler chain, which every screen edit passes through; only the
 * acknowledgement runs ahead of it.
 *
 * How the bot is driven belongs next to the bot, not in the process that happens
 * to own its lifetime.
 */
export function startBotRunner(bot: Bot): BotRunner {
  const handle = run(bot);
  log("info", "grammY runner started", { username: bot.botInfo.username });
  return {
    isRunning: () => handle.isRunning(),
    stop: async () => {
      await handle.stop();
    },
  };
}
