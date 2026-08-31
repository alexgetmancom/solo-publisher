import { AsyncLocalStorage } from "node:async_hooks";
import type { Bot } from "grammy";

/**
 * The aggregate duration of every Telegram request made for one update.
 *
 * `handlerMs` says how long the work took but not what the work was, and two
 * rounds of production measurement were already spent guessing. The split that
 * One transformer sees every outgoing call, so no screen has to be instrumented
 * and none can be forgotten. Concurrent requests overlap, so their durations
 * are deliberately a sum of request cost, not a partition of wall time.
 *
 * Updates are handled concurrently, so the measurement is carried by async
 * context rather than by a module-level counter: two taps in flight must not
 * bill their calls to each other.
 */
export type TapMeasurement = { apiSumMs: number; apiCalls: number };

const measurements = new AsyncLocalStorage<TapMeasurement>();

/** Runs one update with its own account of what it spent on Telegram. */
export async function withTapMeasurement<T>(run: () => Promise<T>): Promise<{ result: T; measurement: TapMeasurement }> {
  const measurement: TapMeasurement = { apiSumMs: 0, apiCalls: 0 };
  const result = await measurements.run(measurement, run);
  return { result, measurement };
}

/** The account of the update currently being handled, for a caller that wants to
 * report before its own work has finished. */
export function currentTapMeasurement(): TapMeasurement {
  return measurements.getStore() ?? { apiSumMs: 0, apiCalls: 0 };
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
        measurement.apiSumMs += performance.now() - startedAt;
        measurement.apiCalls += 1;
      }
    }
  });
}
