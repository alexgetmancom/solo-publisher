import { type BackendDb, unsafeDb } from "../db/client.js";
import { log } from "../foundation/logger.js";

/** Curated operation boundaries that are useful when deciding what to simplify.
 * Dynamic providers and channels are intentionally represented by one stable
 * operation key so provider names cannot create unbounded metric cardinality. */
const TRACKED_FEATURES = [
  "publishing.plan.create",
  "publishing.social.job",
  "publishing.video.job",
  "publishing.site.materialize",
  "content.story_card.render",
  "analytics.metrics.collect",
  "analytics.creator_profile.sync",
  "analytics.video_metrics.collect",
  "engagement.pageview.record",
  // The dashboard is three operations with three cost profiles: a full HTML
  // render, the JSON payload behind it, and a fingerprint the open tab polls
  // every 60 seconds. One shared key buried the render's cost under the poll's
  // call count and made the average answer no question at all.
  "command_center.dashboard.render",
  "command_center.publication_details.render",
  "command_center.fingerprint.poll",
  "studio.queue.read",
  "studio.post.create",
  "studio.post.edit",
  "studio.post.publish",
  "studio.post.publish-article",
  "studio.post.schedule",
  "studio.post.cancel",
  "studio.post.retry",
  "studio.post.skip",
  "studio.video.create",
  "studio.video.edit",
  "studio.video.publish",
  "studio.video.schedule",
  "studio.video.cancel",
  "studio.video.retry",
  "studio.video.settle",
  "studio.media.import",
  "studio.channel.list",
  "studio.channel.connect",
  "studio.channel.disable",
  "studio.channel.discover",
  "studio.analytics.dashboard.read",
  "studio.analytics.milestones.read",
  "studio.analytics.post.read",
  "studio.analytics.video.read",
  "studio.analytics.audience.read",
  "studio.mcp.request",
  "telegram.update.handle",
] as const;

export type UsageFeatureKey = (typeof TRACKED_FEATURES)[number];

const featureKeyPattern = /^[a-z][a-z0-9_.-]{0,127}$/;
const millisecondsPerDay = 24 * 60 * 60 * 1000;

type UsageAggregate = {
  featureKey: string;
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  daysWithCalls: number;
};

/** The day of the window that failed most, and how much of the window's
 * failures it holds. A month's failure rate is an average, and an average is
 * exactly the wrong shape for the question it gets asked: metrics collection
 * read as half broken for a month when in truth it broke for two days and had
 * been clean since. */
type UsageWorstDay = { day: string; calls: number; failures: number };

/** The window says how much; this says whether it is still happening. */
type UsageRecent = { days: number; calls: number; failures: number };

type UsageReport = {
  generatedAt: string;
  windowDays: number;
  unusedDays: number;
  since: string;
  features: Array<
    UsageAggregate & {
      averageDurationMs: number;
      unused: boolean;
      daysSinceLastSeen: number | null;
      recent: UsageRecent;
      worstDay: UsageWorstDay | null;
    }
  >;
};

type BufferedUsage = {
  featureKey: string;
  bucketDay: string;
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

type UsageBuffer = {
  pending: Map<string, BufferedUsage>;
  lastFlushedAt: number;
};

/** Short enough that an ongoing failure cannot hide behind a quiet month, long
 * enough that one bad afternoon does not become the whole answer. */
const RECENT_WINDOW_DAYS = 7;

const USAGE_FLUSH_INTERVAL_MS = 60_000;
const usageBuffers = new WeakMap<BackendDb, UsageBuffer>();

function usageBufferFor(backendDb: BackendDb): UsageBuffer {
  const existing = usageBuffers.get(backendDb);
  if (existing) return existing;
  const created = { pending: new Map(), lastFlushedAt: Date.now() } satisfies UsageBuffer;
  usageBuffers.set(backendDb, created);
  return created;
}

/** Buffers one operation, so all but one request a minute costs nothing but a
 * map write. The exception is the request that crosses the flush interval: it
 * pays for the whole batch, synchronously and on its own thread. */
export function recordUsage(backendDb: BackendDb, featureKey: string, success: boolean, durationMs: number, now = new Date()): void {
  if (!featureKeyPattern.test(featureKey)) {
    log("warn", "invalid runtime usage feature key", { featureKey });
    return;
  }
  const timestamp = now.toISOString();
  const bucketDay = timestamp.slice(0, 10);
  const buffer = usageBufferFor(backendDb);
  const key = `${featureKey}\u0000${bucketDay}`;
  const current = buffer.pending.get(key);
  if (current) {
    current.calls += 1;
    current.successes += success ? 1 : 0;
    current.failures += success ? 0 : 1;
    current.totalDurationMs += Math.max(0, Math.round(durationMs));
    if (timestamp < current.firstSeenAt) current.firstSeenAt = timestamp;
    if (timestamp > current.lastSeenAt) current.lastSeenAt = timestamp;
  } else {
    buffer.pending.set(key, {
      featureKey,
      bucketDay,
      calls: 1,
      successes: success ? 1 : 0,
      failures: success ? 0 : 1,
      totalDurationMs: Math.max(0, Math.round(durationMs)),
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
    });
  }
  if (Date.now() - buffer.lastFlushedAt >= USAGE_FLUSH_INTERVAL_MS) flushUsage(backendDb);
}

/** Persists the accumulated telemetry in one transaction. Runtime usage is
 * diagnostic data, so a failed flush is retained for the next attempt. */
export function flushUsage(backendDb: BackendDb): void {
  const buffer = usageBuffers.get(backendDb);
  if (!buffer || buffer.pending.size === 0) return;
  const entries = [...buffer.pending.values()];
  try {
    unsafeDb(backendDb).sqlite.transaction(() => {
      const upsert = unsafeDb(backendDb).sqlite.prepare(
        `INSERT INTO runtime_usage
          (feature_key, bucket_day, calls, successes, failures, total_duration_ms, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(feature_key, bucket_day) DO UPDATE SET
           calls = runtime_usage.calls + excluded.calls,
           successes = runtime_usage.successes + excluded.successes,
           failures = runtime_usage.failures + excluded.failures,
           total_duration_ms = runtime_usage.total_duration_ms + excluded.total_duration_ms,
           last_seen_at = excluded.last_seen_at`,
      );
      for (const entry of entries)
        upsert.run(
          entry.featureKey,
          entry.bucketDay,
          entry.calls,
          entry.successes,
          entry.failures,
          entry.totalDurationMs,
          entry.firstSeenAt,
          entry.lastSeenAt,
        );
    })();
    for (const entry of entries) buffer.pending.delete(`${entry.featureKey}\u0000${entry.bucketDay}`);
    buffer.lastFlushedAt = Date.now();
  } catch (error) {
    log("warn", "runtime usage flush failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Synchronous wrapper for a domain operation. */
export function trackUsageSync<T>(backendDb: BackendDb, featureKey: UsageFeatureKey, operation: () => T): T {
  const startedAt = Date.now();
  try {
    const result = operation();
    recordUsage(backendDb, featureKey, true, Date.now() - startedAt);
    return result;
  } catch (error) {
    recordUsage(backendDb, featureKey, false, Date.now() - startedAt);
    throw error;
  }
}

/** Async counterpart used around provider calls and other long-running work. */
export async function trackUsageAsync<T>(backendDb: BackendDb, featureKey: UsageFeatureKey, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    recordUsage(backendDb, featureKey, true, Date.now() - startedAt);
    return result;
  } catch (error) {
    recordUsage(backendDb, featureKey, false, Date.now() - startedAt);
    throw error;
  }
}

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function positiveDays(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 3660) throw new Error("usage day window must be an integer between 1 and 3660");
  return value;
}

/** Returns a windowed report and includes known operations with zero calls. */
export function usageReport(backendDb: BackendDb, options: { days?: number; unusedDays?: number; now?: Date } = {}): UsageReport {
  flushUsage(backendDb);
  const now = options.now ?? new Date();
  const windowDays = positiveDays(options.days, 30);
  const unusedDays = positiveDays(options.unusedDays, 90);
  const recentDays = Math.min(windowDays, RECENT_WINDOW_DAYS);
  const today = utcDayStart(now);
  const sinceDate = new Date(today.getTime() - (windowDays - 1) * millisecondsPerDay);
  const unusedSinceDate = new Date(today.getTime() - (unusedDays - 1) * millisecondsPerDay);
  const recentSince = dayString(new Date(today.getTime() - (recentDays - 1) * millisecondsPerDay));
  // Lifetime bounds answer "has this ever run", which is a different question
  // from the window and must not be trimmed to it.
  const lifetimeRows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT feature_key AS featureKey, MIN(first_seen_at) AS firstSeenAt, MAX(last_seen_at) AS lastSeenAt
       FROM runtime_usage
       GROUP BY feature_key`,
    )
    .all() as Array<{ featureKey: string; firstSeenAt: string | null; lastSeenAt: string | null }>;
  // The window's own numbers are summed from its days rather than in SQL, so
  // the totals, the last week and the worst day are all read off one set of
  // rows and cannot disagree about what the window contained.
  const dailyRows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT feature_key AS featureKey, bucket_day AS bucketDay, calls, successes, failures, total_duration_ms AS totalDurationMs
       FROM runtime_usage
       WHERE bucket_day >= ?
       ORDER BY bucket_day`,
    )
    .all(dayString(sinceDate)) as Array<{
    featureKey: string;
    bucketDay: string;
    calls: number;
    successes: number;
    failures: number;
    totalDurationMs: number;
  }>;
  const daysByFeature = new Map<string, typeof dailyRows>();
  for (const row of dailyRows) {
    const existing = daysByFeature.get(row.featureKey);
    if (existing) existing.push(row);
    else daysByFeature.set(row.featureKey, [row]);
  }
  const lifetimeByFeature = new Map(lifetimeRows.map((row) => [row.featureKey, row]));
  const featureKeys = new Set<string>([...TRACKED_FEATURES, ...lifetimeByFeature.keys()]);
  const unusedSince = dayString(unusedSinceDate);
  const features = [...featureKeys].map((featureKey) => {
    const days = daysByFeature.get(featureKey) ?? [];
    const lifetime = lifetimeByFeature.get(featureKey);
    const aggregate: UsageAggregate = {
      featureKey,
      calls: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      firstSeenAt: lifetime?.firstSeenAt ?? null,
      lastSeenAt: lifetime?.lastSeenAt ?? null,
      daysWithCalls: days.length,
    };
    const recent: UsageRecent = { days: recentDays, calls: 0, failures: 0 };
    let worstDay: UsageWorstDay | null = null;
    for (const day of days) {
      aggregate.calls += Number(day.calls);
      aggregate.successes += Number(day.successes);
      aggregate.failures += Number(day.failures);
      aggregate.totalDurationMs += Number(day.totalDurationMs);
      if (day.bucketDay >= recentSince) {
        recent.calls += Number(day.calls);
        recent.failures += Number(day.failures);
      }
      // Rows arrive oldest first, so `>=` keeps the most recent of equally bad
      // days: the one an operator still has to do something about.
      if (Number(day.failures) > 0 && (!worstDay || Number(day.failures) >= worstDay.failures))
        worstDay = { day: day.bucketDay, calls: Number(day.calls), failures: Number(day.failures) };
    }
    const lastSeenDay = aggregate.lastSeenAt?.slice(0, 10);
    const unused = !lastSeenDay || lastSeenDay < unusedSince;
    const daysSinceLastSeen = aggregate.lastSeenAt
      ? Math.max(0, Math.floor((now.getTime() - new Date(aggregate.lastSeenAt).getTime()) / millisecondsPerDay))
      : null;
    return {
      ...aggregate,
      averageDurationMs: aggregate.calls ? Math.round(aggregate.totalDurationMs / aggregate.calls) : 0,
      unused,
      daysSinceLastSeen,
      recent,
      worstDay,
    };
  });
  features.sort((left, right) => right.calls - left.calls || left.featureKey.localeCompare(right.featureKey));
  return {
    generatedAt: now.toISOString(),
    windowDays,
    unusedDays,
    since: sinceDate.toISOString(),
    features,
  };
}
