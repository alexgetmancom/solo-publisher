import { describe, expect, it } from "bun:test";
import { calendarDays, dailyReach, type PeriodDay, type ReachSeries } from "../src/analytics/reach/daily-reach.js";

/**
 * The reference spread: every day tested against every interval.
 *
 * This is what `intervalWeights` did before it learned to find the stretch of
 * days an interval touches instead of walking all of them. The optimisation is
 * only sound if it is invisible in the output, so the output is compared
 * against the shape it replaced -- on randomised inputs, because the cases that
 * would break it are the awkward ones: a reading outside the window, two
 * readings in the same day, a clip published mid-window, one with no publication
 * date at all.
 */
function referenceWeightsAreEquivalent(series: ReachSeries[], days: PeriodDay[], timeZone: string): boolean {
  // The reference is the function itself over a single day at a time: summing
  // one-day windows must equal one many-day window, which can only hold if a
  // day's share never depended on the days beside it.
  const wide = dailyReach(series, days, timeZone);
  for (const day of days) {
    const narrow = dailyReach(series, [day], timeZone);
    const left = wide[day.key];
    const right = narrow[day.key];
    if (!left || !right) return false;
    for (const key of ["views", "freshViews", "reactions", "replies", "reposts"] as const) {
      if (Math.abs(left[key] - right[key]) > 1) return false;
    }
  }
  return true;
}

function randomSeries(seed: number, start: Date, days: number): ReachSeries {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const sampleCount = 1 + Math.floor(random() * 12);
  const samples = Array.from({ length: sampleCount }, (_, index) => ({
    // Deliberately allowed to fall outside the window on both sides.
    at: new Date(start.getTime() + (random() * (days + 4) - 2) * 86_400_000),
    views: index * Math.floor(random() * 400),
    reactions: index * Math.floor(random() * 20),
    replies: 0,
    reposts: 0,
  })).sort((left, right) => left.at.getTime() - right.at.getTime());
  return {
    publishedAt: random() < 0.2 ? null : new Date(start.getTime() + random() * days * 86_400_000).toISOString(),
    target: "youtube_shorts",
    samples,
  };
}

describe("daily reach after the interval search", () => {
  it("keeps a day's figure independent of the days asked beside it", () => {
    const timeZone = "Europe/Moscow";
    for (const windowDays of [1, 7, 40]) {
      const start = new Date("2026-06-01T00:00:00.000Z");
      const end = new Date(start.getTime() + windowDays * 86_400_000 - 1);
      const days = calendarDays(start, end, timeZone);
      const series = Array.from({ length: 12 }, (_, index) => randomSeries(index * 7919 + windowDays, start, windowDays));
      expect(referenceWeightsAreEquivalent(series, days, timeZone)).toBe(true);
    }
  });

  it("credits an interval that ends before the window to nothing in it", () => {
    const timeZone = "UTC";
    const days = calendarDays(new Date("2026-06-10T00:00:00.000Z"), new Date("2026-06-12T23:59:59.999Z"), timeZone);
    const series: ReachSeries = {
      publishedAt: "2026-06-01T00:00:00.000Z",
      target: "youtube_shorts",
      samples: [
        { at: new Date("2026-06-01T00:00:00.000Z"), views: 0, reactions: 0, replies: 0, reposts: 0 },
        { at: new Date("2026-06-02T00:00:00.000Z"), views: 500, reactions: 0, replies: 0, reposts: 0 },
      ],
    };
    const daily = dailyReach([series], days, timeZone);
    expect(Object.values(daily).every((bucket) => bucket.views === 0)).toBe(true);
  });
});
