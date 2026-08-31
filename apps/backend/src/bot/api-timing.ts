import { AsyncLocalStorage } from "node:async_hooks";
import type { Bot } from "grammy";

/**
 * How much of a tap was spent talking to Telegram.
 *
 * `handlerMs` says how long the work took but not what the work was, and two
 * rounds of production measurement were already spent guessing. The split that
 * matters is between waiting on Telegram and doing anything ourselves: the first
 * is a network floor -- 11 ms of wire to the nearest datacentre and roughly
 * thirty more of Telegram's own processing -- and the second is code we can
 * change. One transformer sees every outgoing call, so no screen has to be
 * instrumented and none can be forgotten.
 *
 * Updates are handled concurrently, so the measurement is carried by async
 * context rather than by a module-level counter: two taps in flight must not
 * bill their calls to each other.
 */
export type TapMeasurement = { apiMs: number; apiCalls: number };

const measurements = new AsyncLocalStorage<TapMeasurement>();

/** Runs one update with its own account of what it spent on Telegram. */
export async function withTapMeasurement<T>(run: () => Promise<T>): Promise<{ result: T; measurement: TapMeasurement }> {
  const measurement: TapMeasurement = { apiMs: 0, apiCalls: 0 };
  const result = await measurements.run(measurement, run);
  return { result, measurement };
}

/** The account of the update currently being handled, for a caller that wants to
 * report before its own work has finished. */
export function currentTapMeasurement(): TapMeasurement {
  return measurements.getStore() ?? { apiMs: 0, apiCalls: 0 };
}

/** Times every Bot API call, whoever makes it. */
export function installApiTiming(bot: Bot): void {
  bot.api.config.use(async (previous, method, payload, signal) => {
    const startedAt = performance.now();
    try {
      return await previous(method, payload, signal);
    } finally {
      const measurement = measurements.getStore();
      if (measurement) {
        measurement.apiMs += performance.now() - startedAt;
        measurement.apiCalls += 1;
      }
    }
  });
}
