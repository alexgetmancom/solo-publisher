import { describe, expect, it } from "bun:test";
import { nextVideoMetricCheckAt, videoMetricCheckpointAt } from "../src/analytics/collection/metric-checkpoints.js";

const published = "2026-09-05T12:00:00.000Z";

/** Walks the cadence the way the collector does -- first checkpoint, then each
 * next one from the moment the previous reading was taken -- and returns the
 * age in minutes of every reading inside the window. */
function readingAgesMinutes(throughHours: number): number[] {
  const base = new Date(published).getTime();
  const ages: number[] = [];
  let at = videoMetricCheckpointAt(published);
  while (at.getTime() - base <= throughHours * 3_600_000) {
    ages.push(Math.round((at.getTime() - base) / 60_000));
    at = nextVideoMetricCheckAt(published, at);
  }
  return ages;
}

describe("video metric cadence", () => {
  it("reads the first hour four times before the hourly rhythm starts", () => {
    // The steepest part of a Short's curve, and a single reading at one hour
    // used to be all of it. The grid is asserted rather than described because
    // nothing else would notice the first checkpoint drifting back to an hour.
    expect(readingAgesMinutes(3)).toEqual([10, 20, 30, 45, 60, 120, 180]);
  });

  it("keeps the later rhythm the storage budget was sized for", () => {
    const ages = readingAgesMinutes(24 * 10);
    // Hourly for two days, then six-hourly to a week, then daily.
    expect(ages.filter((age) => age > 60 && age <= 48 * 60).every((age) => age % 60 === 0)).toBe(true);
    expect(ages.at(-1)).toBe(10 * 24 * 60);
  });
});
