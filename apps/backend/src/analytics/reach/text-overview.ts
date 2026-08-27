import type { PipelinePost } from "../pipeline-payload.js";
import { type DailyReach, dailyReach, emptyDailyReach, type PeriodDay } from "./daily-reach.js";
import { textReachSeries, type XActivitySeries } from "./text-reach.js";
import { ORDERED_TEXT_TARGET_IDS } from "./text-targets.js";

/**
 * Read model behind the text half of the unified overview — the twin of
 * videoOverview's reach half, and deliberately the same shape.
 *
 * It answers "what did text earn on each day", per destination, over one window
 * wide enough to cover the chart, the period, its comparison and the norm. That
 * window is what makes the numbers agree: a post published three weeks ago is
 * still earning views today, and it can only be counted on today's bar if it is
 * loaded when today is drawn.
 */

export type TextOverview = {
  /** Every destination's daily reach, keyed by target then by calendar date. */
  byTarget: Record<string, Record<string, DailyReach>>;
  days: PeriodDay[];
};

/** The read model proper, once the rows have been fetched. */
export function textOverviewOf(
  posts: readonly PipelinePost[],
  xSeries: readonly XActivitySeries[],
  days: PeriodDay[],
  timeZone: string,
): TextOverview {
  const covered = new Set(xSeries.map((entry) => entry.linkedPublicationKey).filter((key): key is string => Boolean(key)));
  const series = [...textReachSeries(posts, [...ORDERED_TEXT_TARGET_IDS], covered), ...xSeries];
  const byTarget: Record<string, Record<string, DailyReach>> = {};
  for (const target of new Set(series.map((entry) => entry.target))) {
    byTarget[target] = dailyReach(
      series.filter((entry) => entry.target === target),
      days,
      timeZone,
    );
  }
  return { byTarget, days };
}

/** Daily totals across the selected destinations, summed from the per-target maps. */
export function textDailyReach(overview: TextOverview, targetIds: readonly string[]): Record<string, DailyReach> {
  const daily: Record<string, DailyReach> = {};
  for (const target of targetIds) {
    for (const [day, values] of Object.entries(overview.byTarget[target] ?? {})) {
      const bucket = daily[day] ?? emptyDailyReach();
      bucket.views += values.views;
      bucket.freshViews += values.freshViews;
      bucket.reactions += values.reactions;
      bucket.replies += values.replies;
      bucket.reposts += values.reposts;
      daily[day] = bucket;
    }
  }
  return daily;
}
