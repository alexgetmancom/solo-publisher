import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What one update spent waiting on somebody else, split by who.
 *
 * `handlerMs` says how long the work took but not what the work was, and two
 * rounds of production measurement were already spent guessing. Telegram was
 * the first half of the answer and it settled the button screens: their whole
 * cost is the round trip, and nothing local is worth optimising there.
 *
 * The second half is every other provider, and it was missing. A message that
 * starts a draft waits on a translation, and that wait landed nowhere: it was
 * not Telegram, so it showed up only as the gap between `totalMs` and
 * `apiSumMs`, which is a residual and not a measurement. A 1.1 s message could
 * be attributed to the translator only by reading what happened to be logged
 * next to it.
 *
 * Both halves are collected at a chokepoint every call already goes through --
 * the Bot API transformer and `externalFetch` -- so no screen has to be
 * instrumented and none can be forgotten. Concurrent requests overlap, so each
 * duration is deliberately a sum of request cost, not a partition of wall time.
 *
 * Updates are handled concurrently, so the measurement is carried by async
 * context rather than by a module-level counter: two taps in flight must not
 * bill their calls to each other. Work outside a tap -- every worker cycle --
 * runs with no store and is counted by nobody.
 */
export type TapMeasurement = { apiSumMs: number; apiCalls: number; providerMs: number; providerCalls: number };

const measurements = new AsyncLocalStorage<TapMeasurement>();

/** Runs one update with its own account of what it spent waiting. The account
 * is read back with `currentTapMeasurement` from inside the run, so a tap that
 * throws can still report before it rethrows. */
export function withTapMeasurement<T>(run: () => Promise<T>): Promise<T> {
  return measurements.run({ apiSumMs: 0, apiCalls: 0, providerMs: 0, providerCalls: 0 }, run);
}

/** The account of the update currently being handled, for a caller that wants to
 * report before its own work has finished. */
export function currentTapMeasurement(): TapMeasurement {
  return measurements.getStore() ?? { apiSumMs: 0, apiCalls: 0, providerMs: 0, providerCalls: 0 };
}

/** One finished Telegram Bot API call. */
export function recordTapTelegramCall(durationMs: number): void {
  const measurement = measurements.getStore();
  if (!measurement) return;
  measurement.apiSumMs += durationMs;
  measurement.apiCalls += 1;
}

/** One finished call to any other provider: translation, a platform API, media. */
export function recordTapProviderCall(durationMs: number): void {
  const measurement = measurements.getStore();
  if (!measurement) return;
  measurement.providerMs += durationMs;
  measurement.providerCalls += 1;
}
