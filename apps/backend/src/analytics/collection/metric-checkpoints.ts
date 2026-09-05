/** Fixed metric checkpoints from the actual publication time. */
const POST_METRIC_CHECKPOINTS_MS = [1, 3, 6, 12, 24, 7 * 24, 30 * 24].map((hours) => hours * 3_600_000);
const HOUR = 3_600_000;

/** Fixed analytics collection checkpoints after publication. */
export function metricCheckpointAt(publishedAt: string | null, checkpointIndex: number, fallback = new Date()): Date | null {
  const offset = POST_METRIC_CHECKPOINTS_MS[checkpointIndex];
  if (offset == null) return null;
  const published = publishedAt ? new Date(publishedAt) : fallback;
  return new Date((Number.isNaN(published.getTime()) ? fallback : published).getTime() + offset);
}

const MINUTE = 60_000;

/** The first check happens ten minutes after publication. Subsequent checks use
 * the adaptive cadence below so early video performance stays live. */
export function videoMetricCheckpointAt(publishedAt: string | null, fallback = new Date()): Date {
  const published = publishedAt ? new Date(publishedAt) : fallback;
  const base = Number.isNaN(published.getTime()) ? fallback : published;
  return new Date(base.getTime() + 10 * MINUTE);
}

/**
 * Video-only polling cadence. Text-post schedules are deliberately separate and
 * remain untouched to avoid extra calls to their social providers.
 *
 * The first hour is read at 10, 20, 30 and 45 minutes because it is the
 * steepest part of a Short's curve and used to be a single point: a median
 * Short already holds 18% of its views at one hour and gains only seven more
 * points in the second, so whatever happened inside that hour was the whole
 * question and none of it was recorded. Reels sit near zero for the same hour,
 * and those readings are the measurement that says so rather than wasted calls.
 *
 * The collector runs every five minutes, so this asks for nothing the loop
 * cannot already deliver, and a reading costs one unit of a ten-thousand-a-day
 * quota.
 */
export function nextVideoMetricCheckAt(publishedAt: string | null, checkedAt = new Date()): Date {
  const published = publishedAt ? new Date(publishedAt) : checkedAt;
  const age = Math.max(0, checkedAt.getTime() - (Number.isNaN(published.getTime()) ? checkedAt : published).getTime());
  const delay =
    age < 30 * MINUTE
      ? 10 * MINUTE
      : age < HOUR
        ? 15 * MINUTE
        : age < 48 * HOUR
          ? HOUR
          : age < 7 * 24 * HOUR
            ? 6 * HOUR
            : age < 30 * 24 * HOUR
              ? 24 * HOUR
              : 7 * 24 * HOUR;
  return new Date(checkedAt.getTime() + delay);
}
