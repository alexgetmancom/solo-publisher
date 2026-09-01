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
 * `apiSumMs` is in turn a sum over methods, and the sum cannot say whether a
 * tap paid for one screen edit or for an edit plus a menu the plugin decided
 * was outdated. The methods are named, so a tap that costs two round trips is
 * visible as two round trips rather than as one slow one.
 *
 * All of it is collected at chokepoints every call already goes through -- the
 * Bot API transformer and `externalFetch` -- so no screen has to be
 * instrumented and none can be forgotten. Concurrent requests overlap, so each
 * duration is deliberately a sum of request cost, not a partition of wall time.
 *
 * Updates are handled concurrently, so the measurement is carried by async
 * context rather than by a module-level counter: two taps in flight must not
 * bill their calls to each other. Work outside a tap -- every worker cycle --
 * runs with no store and is counted by nobody.
 */
export type TapMeasurement = {
  apiSumMs: number;
  apiCalls: number;
  providerMs: number;
  providerCalls: number;
  /** Bot API cost by method name, in call order. */
  apiMethods: Map<string, { ms: number; calls: number }>;
  /** When the operator had their answer, on the `performance.now()` clock, or
   * null while the update is still producing one.
   *
   * The number an update is judged by has to be the wait the operator actually
   * sits through, and that ends when the screen is drawn. It was being measured
   * past that point: the callback boundary awaits the acknowledgement before it
   * reports, and the acknowledgement is deliberately not on the operator's path
   * -- it goes out ahead of the queue and settles whenever the event loop gets
   * back to it. Production has it settling at 950 ms in a tap whose screen edit
   * took 68 ms, so every average was carrying hundreds of milliseconds of a wait
   * nobody had. */
  answeredAt: number | null;
  /** Screen edits the guard did not send, because the screen already showed
   * exactly that. They are round trips this tap did not pay for, and without a
   * count of their own they are indistinguishable from a tap that had nothing
   * to draw. */
  unchangedEdits: number;
};

const measurements = new AsyncLocalStorage<TapMeasurement>();

function emptyMeasurement(): TapMeasurement {
  return { apiSumMs: 0, apiCalls: 0, providerMs: 0, providerCalls: 0, apiMethods: new Map(), answeredAt: null, unchangedEdits: 0 };
}

/** Runs one update with its own account of what it spent waiting. The account
 * is read back with `currentTapMeasurement` from inside the run, so a tap that
 * throws can still report before it rethrows. */
export function withTapMeasurement<T>(run: () => Promise<T>): Promise<T> {
  return measurements.run(emptyMeasurement(), run);
}

/** The account of the update currently being handled, for a caller that wants to
 * report before its own work has finished. */
export function currentTapMeasurement(): TapMeasurement {
  return measurements.getStore() ?? emptyMeasurement();
}

/** The Bot API cost by method, as a log line carries it: rounded, and omitted
 * entirely when the tap made no call, so an update that only read the database
 * does not log an empty object. */
export function tapApiMethods(measurement: TapMeasurement): Record<string, { ms: number; calls: number }> | undefined {
  if (measurement.apiMethods.size === 0) return undefined;
  return Object.fromEntries([...measurement.apiMethods].map(([method, cost]) => [method, { ms: Math.round(cost.ms), calls: cost.calls }]));
}

/** One finished Telegram Bot API call. */
export function recordTapTelegramCall(method: string, durationMs: number): void {
  const measurement = measurements.getStore();
  if (!measurement) return;
  measurement.apiSumMs += durationMs;
  measurement.apiCalls += 1;
  const cost = measurement.apiMethods.get(method);
  if (cost) {
    cost.ms += durationMs;
    cost.calls += 1;
  } else {
    measurement.apiMethods.set(method, { ms: durationMs, calls: 1 });
  }
}

/** The operator has their answer. Recorded by whoever produced it; the first
 * caller wins, because an update answers once. An update that never says so --
 * every plain message handler -- is answered when its handling ends. */
export function recordTapAnswered(): void {
  const measurement = measurements.getStore();
  if (measurement && measurement.answeredAt === null) measurement.answeredAt = performance.now();
}

/** One screen edit the guard answered from what the message already shows. */
export function recordTapUnchangedEdit(): void {
  const measurement = measurements.getStore();
  if (measurement) measurement.unchangedEdits += 1;
}

/** One finished call to any other provider: translation, a platform API, media. */
export function recordTapProviderCall(durationMs: number): void {
  const measurement = measurements.getStore();
  if (!measurement) return;
  measurement.providerMs += durationMs;
  measurement.providerCalls += 1;
}
