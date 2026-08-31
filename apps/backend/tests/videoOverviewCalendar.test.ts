import { describe, expect, test } from "bun:test";
import { calendarDays, calendarKey, dailyReach, latestAtOrBefore, periodReach } from "../src/analytics/reach/daily-reach.js";
import { isCurrentCalendarDay } from "../src/foundation/time.js";
import {
  periodSubscriberDelta,
  type VideoMetrics,
  type VideoSnapshot,
  videoReachSeries,
} from "../src/interfaces/web/dashboard/video-overview-calendar.js";

function metrics(overrides: Partial<VideoMetrics> = {}): VideoMetrics {
  return {
    views: 0,
    likes: 0,
    comments: 0,
    averageWatchTimeMs: null,
    totalWatchTimeMs: null,
    follows: null,
    completionRate: null,
    videoDurationMs: null,
    ...overrides,
  };
}

function snapshot(at: string, overrides: Partial<VideoMetrics> = {}): VideoSnapshot {
  return { at: new Date(at), metrics: metrics(overrides) };
}

describe("video overview calendar helpers", () => {
  test("keys and splits a range by the configured local calendar", () => {
    const start = new Date("2026-01-01T21:00:00.000Z");
    const end = new Date("2026-01-03T20:59:59.999Z");
    const days = calendarDays(start, end, "Europe/Moscow");

    expect(calendarKey(start, "Europe/Moscow")).toBe("2026-01-02");
    expect(days.map((day) => day.key)).toEqual(["2026-01-02", "2026-01-03"]);
    expect(days[0]?.start).toEqual(start);
    expect(days[0]?.end.toISOString()).toBe("2026-01-02T20:59:59.999Z");
    expect(days[1]?.start.toISOString()).toBe("2026-01-02T21:00:00.000Z");
    expect(days[1]?.end).toEqual(end);
  });

  test("returns no calendar days for an inverted range", () => {
    expect(calendarDays(new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"), "UTC")).toEqual([]);
  });

  test("finds the latest sample and folds period deltas", () => {
    const history = [
      snapshot("2026-01-01T00:00:00.000Z", { views: 10, likes: 2, comments: 1, follows: 100 }),
      snapshot("2026-01-01T12:00:00.000Z", { views: 15, likes: 4, comments: 4, follows: 103 }),
    ];
    const days = [{ key: "2026-01-01", start: new Date("2026-01-01T00:00:00.000Z"), end: new Date("2026-01-01T23:59:59.999Z") }];

    expect(latestAtOrBefore(history, new Date("2025-12-31T23:59:59.999Z"))).toBeUndefined();
    expect(latestAtOrBefore(history, new Date("2026-01-01T06:00:00.000Z"))).toBe(history[0]);
    expect(periodReach(videoReachSeries(null, "youtube_shorts", history), days, "UTC")).toEqual({
      views: 5,
      reactions: 2,
      replies: 3,
      reposts: 0,
      freshViews: 0,
    });
    expect(periodSubscriberDelta(history, days)).toBe(3);
  });

  test("recognises the current calendar day in a timezone", () => {
    const now = new Date();
    expect(isCurrentCalendarDay(now, "Europe/Moscow")).toBe(true);
    expect(isCurrentCalendarDay(new Date("2000-01-01T00:00:00.000Z"), "Europe/Moscow")).toBe(false);
  });
});

describe("daily reach is independent of the window it was asked in", () => {
  // The whole video read model rests on this: one pass over the full history
  // produces day figures that every comparison window can simply sum. It holds
  // because each interval between two readings is normalised by its own span
  // before being spread, never by the days that happened to be requested. If it
  // ever stopped holding, the periods on the dashboard would quietly disagree
  // with each other instead of failing.
  const history: VideoSnapshot[] = [
    { at: new Date("2026-08-01T00:00:00.000Z"), metrics: metrics({ views: 0 }) },
    { at: new Date("2026-08-04T00:00:00.000Z"), metrics: metrics({ views: 900 }) },
    { at: new Date("2026-08-09T00:00:00.000Z"), metrics: metrics({ views: 1400 }) },
  ];
  const series = videoReachSeries("2026-08-01T00:00:00.000Z", "youtube_shorts", history);

  test("gives one day the same figure inside a wide window and a narrow one", () => {
    const wide = dailyReach(
      [series],
      calendarDays(new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-10T23:59:59.999Z"), "UTC"),
      "UTC",
    );
    const narrow = dailyReach(
      [series],
      calendarDays(new Date("2026-08-03T00:00:00.000Z"), new Date("2026-08-05T23:59:59.999Z"), "UTC"),
      "UTC",
    );
    for (const key of ["2026-08-03", "2026-08-04", "2026-08-05"]) expect(narrow[key]).toEqual(wide[key]);
  });

  test("sums the same total whether a period is cut from history or measured directly", () => {
    const start = new Date("2026-08-03T00:00:00.000Z");
    const end = new Date("2026-08-05T23:59:59.999Z");
    const days = calendarDays(start, end, "UTC");
    const wide = dailyReach(
      [series],
      calendarDays(new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-10T23:59:59.999Z"), "UTC"),
      "UTC",
    );
    const sliced = days.reduce((total, day) => total + (wide[day.key]?.views ?? 0), 0);
    expect(sliced).toBe(periodReach(series, days, "UTC").views);
  });
});
