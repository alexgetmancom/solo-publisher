import type { Bot } from "grammy";
import { recordTapTelegramCall } from "../foundation/tap-measurement.js";

/** Times every Bot API call, whoever makes it, and names the method it timed.
 * One transformer sees every outgoing call, so no screen has to be
 * instrumented and none can be forgotten.
 *
 * The method is what turns a sum into an answer: a tap costing two round trips
 * -- a screen edit plus the keyboard the menu plugin decided was outdated --
 * and a tap costing one slow one are the same `apiSumMs` and are not the same
 * problem. */
export function installApiTiming(bot: Bot): void {
  bot.api.config.use(async (previous, method, payload, signal) => {
    const startedAt = performance.now();
    try {
      return await previous(method, payload, signal);
    } finally {
      recordTapTelegramCall(method, performance.now() - startedAt);
    }
  });
}
