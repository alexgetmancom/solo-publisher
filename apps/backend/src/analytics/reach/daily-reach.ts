import { zonedDateParts, zonedSlot } from "../../foundation/time.js";

/**
 * One vocabulary for "what did a day earn", shared by both halves of the
 * overview.
 *
 * Text, video and X all store the same thing: a cumulative counter per
 * publication, sampled over time. What differs is only where the samples come
 * from — `metric_samples`, `video_metric_snapshots`, `x_activity_metric_snapshots`.
 * Each feed adapts its rows into `ReachSeries` and everything downstream — the
 * daily bars, the hero figure, the norm, the platform split — is computed here,
 * once, identically.
 *
 * The rule that makes the numbers comparable: a day is credited with the views
 * that arrived *on that day*, never with the lifetime of what was published on
 * it. A clip's later growth belongs to the days it actually happened, so the
 * bars of one chart can be summed, compared, and averaged.
 *
 * Readings are too sparse to say that directly. X analytics arrive as a CSV
 * export once a week or two, so most posts are read exactly once, long after
 * they stopped moving; crediting each reading's growth to the day it was taken
 * would put a fortnight of the whole catalogue onto whichever day the export
 * happened. What a reading proves is how much arrived, not when — so the growth
 * between two readings is laid out across the days between them along the curve
 * a publication is known to follow, which is `lifetimeShareByAge` below.
 */

export type ReachCounters = { views: number; reactions: number; replies: number; reposts: number };
export type ReachSample = { at: Date } & ReachCounters;

/** One publication on one destination: when it went out, and how it grew. */
export type ReachSeries = { publishedAt: string | null; target: string; samples: ReachSample[] };

/** A day's earnings, plus the share of them produced by that day's own output. */
export type DailyReach = ReachCounters & { freshViews: number };

export type PeriodDay = { key: string; start: Date; end: Date };

export function emptyReachCounters(): ReachCounters {
  return { views: 0, reactions: 0, replies: 0, reposts: 0 };
}

export function emptyDailyReach(): DailyReach {
  return { ...emptyReachCounters(), freshViews: 0 };
}

export function latestAtOrBefore<T extends { at: Date }>(samples: readonly T[], cutoff: Date): T | undefined {
  let low = 0;
  let high = samples.length - 1;
  let latest: T | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const sample = samples[middle];
    if (!sample) break;
    if (sample.at <= cutoff) {
      latest = sample;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return latest;
}

export function calendarDays(start: Date, end: Date, timeZone: string): PeriodDay[] {
  if (end < start) return [];
  const days: PeriodDay[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const parts = zonedDateParts(cursor, timeZone);
    const nextDay = zonedSlot(parts.year, parts.month, parts.day + 1, "00:00", timeZone);
    const dayEnd = new Date(Math.min(end.getTime(), nextDay.getTime() - 1));
    days.push({ key: calendarKey(cursor, timeZone), start: new Date(cursor), end: dayEnd });
    if (dayEnd >= end) break;
    cursor = nextDay;
  }
  return days;
}

export function calendarKey(value: Date, timeZone: string): string {
  const parts = zonedDateParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/**
 * The share of a publication's lifetime views that arrives while it is between
 * `from` and `to` hours old, as a fraction of everything it will ever earn.
 *
 * Views do not arrive at a constant rate and they do not simply decay: a post
 * starts slowly, peaks within its first day, and is finished as a live thing
 * after about two days. A log-normal in the age of the publication is that
 * shape — zero at the moment of publication, a hump, then a thin tail that
 * never quite reaches zero. Fitted to what the account actually does: 55% of a
 * post's views land on the calendar day it goes out, 85% within 48 hours, 94%
 * within 72, and the remainder trickles in over the following weeks.
 *
 * The tail matters more than its size suggests. Analytics arrive as a CSV export
 * once a week or two, so a reading covers a long stretch at once; without a tail
 * there would be nowhere to put the growth of everything already published, and
 * it would pile onto the day the export happened.
 */
const AGE_LOG_MEAN = 3.08;
const AGE_LOG_SIGMA = 0.76;

function lifetimeShareByAge(hours: number): number {
  if (hours <= 0) return 0;
  return normalCdf((Math.log(hours) - AGE_LOG_MEAN) / AGE_LOG_SIGMA);
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Abramowitz & Stegun 7.1.26 — accurate to 1.5e-7, far beyond what view counts need. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const value = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * value);
  const series = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - series * Math.exp(-value * value));
}

const HOUR = 3_600_000;

/**
 * How one interval between two readings divides between the days it spans.
 *
 * Everything gained between two readings is real and measured; when inside the
 * interval it arrived is not observed, and the growth curve is the only evidence
 * about it. Each day gets the share of the curve that falls inside it, so a post
 * published two days before the export is credited on those two days rather than
 * on the day the operator ran it, and an old post — sitting on the flat part of
 * the tail — spreads out almost evenly, which is the truth for it.
 *
 * Without a publication time there is no age to place on the curve, and an even
 * split across the interval is the only defensible reading.
 */
function intervalWeights(days: readonly PeriodDay[], from: Date, to: Date, published: Date | null): Map<string, number> {
  const weights = new Map<string, number>();
  const span = to.getTime() - from.getTime();
  // A publication read at the very instant it went out — the pipeline stores a
  // lifetime figure with no sampling history — spans no time to spread over, so
  // it belongs whole to the day it was read.
  if (span <= 0) {
    const day = days.find((candidate) => candidate.start <= to && to <= candidate.end);
    if (day) weights.set(day.key, 1);
    return weights;
  }
  const ageHours = (at: Date): number => (published ? (at.getTime() - published.getTime()) / HOUR : 0);
  const curved = published !== null;
  const total = curved ? lifetimeShareByAge(ageHours(to)) - lifetimeShareByAge(ageHours(from)) : span;
  for (const day of days) {
    const overlapStart = Math.max(day.start.getTime(), from.getTime());
    const overlapEnd = Math.min(day.end.getTime() + 1, to.getTime());
    if (overlapEnd <= overlapStart) continue;
    const share = curved
      ? lifetimeShareByAge(ageHours(new Date(overlapEnd))) - lifetimeShareByAge(ageHours(new Date(overlapStart)))
      : overlapEnd - overlapStart;
    if (share > 0) weights.set(day.key, share);
  }
  // Every reachable day sits on a stretch of curve too flat to measure — the
  // publication is old enough that the model says "nothing more arrives" while
  // the counter says otherwise. Believe the counter and spread it evenly.
  if (total <= 0 || [...weights.values()].every((share) => share === 0)) {
    weights.clear();
    for (const day of days) {
      const overlapStart = Math.max(day.start.getTime(), from.getTime());
      const overlapEnd = Math.min(day.end.getTime() + 1, to.getTime());
      if (overlapEnd > overlapStart) weights.set(day.key, (overlapEnd - overlapStart) / span);
    }
    return weights;
  }
  for (const [key, share] of weights) weights.set(key, share / total);
  return weights;
}

/** The stretches over which a publication was observed to grow, and by how much. */
function growthIntervals(entry: ReachSeries): { from: Date; to: Date; gained: ReachCounters }[] {
  const published = publicationDate(entry);
  const intervals: { from: Date; to: Date; gained: ReachCounters }[] = [];
  let previous: ReachSample | undefined;
  for (const sample of entry.samples) {
    if (!previous) {
      // A publication's first reading is everything it had earned by the time we
      // first looked, and it was earned between going out and being read. With
      // no publication time there is no stretch to lay it over and no claim that
      // any of it arrived in the window — the reading is a baseline, nothing more.
      if (published) intervals.push({ from: published, to: sample.at, gained: { ...counters(sample) } });
    } else {
      intervals.push({ from: previous.at, to: sample.at, gained: difference(sample, previous) });
    }
    previous = sample;
  }
  return intervals;
}

function counters(sample: ReachSample): ReachCounters {
  return { views: sample.views, reactions: sample.reactions, replies: sample.replies, reposts: sample.reposts };
}

function difference(sample: ReachSample, previous: ReachSample): ReachCounters {
  return {
    views: Math.max(0, sample.views - previous.views),
    reactions: Math.max(0, sample.reactions - previous.reactions),
    replies: Math.max(0, sample.replies - previous.replies),
    reposts: Math.max(0, sample.reposts - previous.reposts),
  };
}

function publicationDate(entry: ReachSeries): Date | null {
  if (!entry.publishedAt) return null;
  const published = new Date(entry.publishedAt);
  return Number.isNaN(published.getTime()) ? null : published;
}

/** Daily increments for every series, split into the day's own output and its back catalogue. */
export function dailyReach(series: readonly ReachSeries[], days: readonly PeriodDay[], timeZone: string): Record<string, DailyReach> {
  const result: Record<string, DailyReach> = {};
  for (const day of days) result[day.key] = emptyDailyReach();
  for (const entry of series) {
    const published = publicationDate(entry);
    const publishedKey = published ? calendarKey(published, timeZone) : null;
    for (const interval of growthIntervals(entry)) {
      const weights = intervalWeights(days, interval.from, interval.to, published);
      for (const [key, weight] of weights) {
        const bucket = result[key];
        if (!bucket) continue;
        const views = interval.gained.views * weight;
        bucket.views += views;
        if (publishedKey === key) bucket.freshViews += views;
        bucket.reactions += interval.gained.reactions * weight;
        bucket.replies += interval.gained.replies * weight;
        bucket.reposts += interval.gained.reposts * weight;
      }
    }
  }
  for (const day of days) {
    const bucket = result[day.key];
    if (bucket) result[day.key] = roundReach(bucket);
  }
  return result;
}

/** What one publication earned over a whole period — the daily bars, summed. */
export function periodReach(series: ReachSeries, days: readonly PeriodDay[], timeZone: string): DailyReach {
  const daily = dailyReach([series], days, timeZone);
  const totals = emptyDailyReach();
  for (const day of days) {
    const bucket = daily[day.key];
    if (!bucket) continue;
    totals.views += bucket.views;
    totals.freshViews += bucket.freshViews;
    totals.reactions += bucket.reactions;
    totals.replies += bucket.replies;
    totals.reposts += bucket.reposts;
  }
  return totals;
}

/** Spreading produces fractions of a view; nothing downstream wants them. */
function roundReach(bucket: DailyReach): DailyReach {
  return {
    views: Math.round(bucket.views),
    freshViews: Math.round(bucket.freshViews),
    reactions: Math.round(bucket.reactions),
    replies: Math.round(bucket.replies),
    reposts: Math.round(bucket.reposts),
  };
}
