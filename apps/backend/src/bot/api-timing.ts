import type { Bot } from "grammy";

/**
 * How much of a tap was spent talking to Telegram.
 *
 * `handlerMs` says how long the work took but not what the work was, and two
 * rounds of this were already spent guessing. The split that matters is the one
 * between waiting on Telegram and doing anything ourselves: the first is a
 * network floor we cannot go below, the second is code we can change. One
 * transformer sees every outgoing call, so no screen has to be instrumented for
 * this and none can be forgotten.
 *
 * The accumulator is module-level because grammY's built-in polling processes
 * updates one at a time -- the bot serves a single operator, and the screen
 * anchor depends on that ordering. Concurrent updates would need this carried on
 * the context instead.
 */
type Measurement = { apiMs: number; apiCalls: number };

let current: Measurement | null = null;

export function beginTapMeasurement(): void {
  current = { apiMs: 0, apiCalls: 0 };
}

export function endTapMeasurement(): Measurement {
  const measurement = current ?? { apiMs: 0, apiCalls: 0 };
  current = null;
  return measurement;
}

/** Times every Bot API call, whoever makes it. */
export function installApiTiming(bot: Bot): void {
  bot.api.config.use(async (previous, method, payload, signal) => {
    const startedAt = performance.now();
    try {
      return await previous(method, payload, signal);
    } finally {
      if (current) {
        current.apiMs += performance.now() - startedAt;
        current.apiCalls += 1;
      }
    }
  });
}
