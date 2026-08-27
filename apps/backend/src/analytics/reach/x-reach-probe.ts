import type { BackendDb } from "../../db/client.js";
import { xActivityDashboardRange } from "../x-activity-dashboard.js";
import { calendarDays } from "./daily-reach.js";
import { textDailyReach, textOverviewOf } from "./text-overview.js";
import { xActivityReachSeries } from "./text-reach.js";

export type XReachProbe = {
  timeZone: string;
  from: string;
  to: string;
  items: number;
  snapshots: number;
  days: Array<{ day: string; views: number; freshViews: number }>;
  item?: { xPostId: string; publishedAt: string; readings: Array<{ sampledAt: string; views: number }> };
};

/**
 * The daily X bars the overview draws, asked of one database directly.
 *
 * The dashboard reaches the same numbers through the whole read model and an
 * HTML cache. When a chart and a CSV export disagree there is no way to tell
 * which of those steps is lying, and no way at all to see what a row actually
 * holds: every report prints dates through `Date`, so a `published_at` in the
 * wrong format reads back as a well-formed one while a `BETWEEN` over strings
 * quietly drops it.
 */
export function xReachProbe(backendDb: BackendDb, from: string, to: string, timeZone: string, xPostId?: string): XReachProbe {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("--from and --to must be ISO timestamps");
  const { items, samples } = xActivityDashboardRange(backendDb, start.toISOString(), end.toISOString());
  const series = xActivityReachSeries(items, samples, start, end);
  const daily = textDailyReach(textOverviewOf([], series, calendarDays(start, end, timeZone), timeZone), ["x"]);
  const probe: XReachProbe = {
    timeZone,
    from: start.toISOString(),
    to: end.toISOString(),
    items: items.length,
    snapshots: samples.length,
    days: Object.entries(daily)
      .map(([day, value]) => ({ day, views: value.views, freshViews: value.freshViews }))
      .sort((left, right) => left.day.localeCompare(right.day)),
  };
  if (!xPostId) return probe;
  const item = items.find((candidate) => candidate.xPostId === xPostId);
  if (item)
    probe.item = {
      xPostId,
      publishedAt: item.publishedAt,
      readings: samples
        .filter((sample) => sample.xPostId === xPostId && sample.metricName === "views")
        .map((sample) => ({ sampledAt: sample.sampledAt, views: Number(sample.value) })),
    };
  return probe;
}
