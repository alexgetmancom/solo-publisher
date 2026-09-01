import type { Bot } from "grammy";
import { recordTapTelegramCall } from "../foundation/tap-measurement.js";

/** Times every Bot API call, whoever makes it. One transformer sees every
 * outgoing call, so no screen has to be instrumented and none can be
 * forgotten. */
export function installApiTiming(bot: Bot): void {
  bot.api.config.use(async (previous, method, payload, signal) => {
    const startedAt = performance.now();
    try {
      return await previous(method, payload, signal);
    } finally {
      recordTapTelegramCall(performance.now() - startedAt);
    }
  });
}
