import { and, desc, eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { audienceActivity } from "../db/schema.js";

/** How old a capture may be before a report stops treating it as current.
 * Platforms redraw these over a trailing month, so a quarter-old picture is a
 * different audience. */
const STALE_AFTER_DAYS = 45;

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];

type HeatmapSlot = { weekday: Weekday; hour: number; value: number };

export type HeatmapImport = {
  platform: string;
  account: string;
  metric: string;
  timeZone: string;
  capturedAt: string;
  periodStart?: string;
  periodEnd?: string;
  source?: string;
  slots: HeatmapSlot[];
};

/** Stores one capture whole. A re-read of the same dashboard at the same
 * moment replaces its slots rather than piling a second copy beside them,
 * which is what makes a browser safe to re-run. */
export function importAudienceHeatmap(backendDb: BackendDb, input: HeatmapImport): Record<string, unknown> {
  const rows = input.slots.map((slot) => ({
    platform: input.platform,
    account: input.account,
    metric: input.metric,
    weekday: slot.weekday,
    hourLocal: slot.hour,
    value: slot.value,
    timeZone: input.timeZone,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    capturedAt: input.capturedAt,
    source: input.source ?? null,
  }));
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const row of rows)
      tx.insert(audienceActivity)
        .values(row)
        .onConflictDoUpdate({
          target: [
            audienceActivity.platform,
            audienceActivity.account,
            audienceActivity.metric,
            audienceActivity.capturedAt,
            audienceActivity.weekday,
            audienceActivity.hourLocal,
          ],
          set: { value: row.value, timeZone: row.timeZone, periodStart: row.periodStart, periodEnd: row.periodEnd, source: row.source },
        })
        .run();
  });
  return { stored: rows.length, platform: input.platform, account: input.account, metric: input.metric, capturedAt: input.capturedAt };
}

/** The newest capture of each platform/account/metric, with how old it is and
 * the hours it says are busiest. */
export function audienceHeatmapReport(backendDb: BackendDb, now = new Date()): Record<string, unknown> {
  const captures = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT platform, account, metric, MAX(captured_at) AS capturedAt FROM audience_activity GROUP BY platform, account, metric`,
    )
    .all() as Array<{ platform: string; account: string; metric: string; capturedAt: string }>;
  return {
    captures: captures.map((capture) => {
      const slots = unsafeDb(backendDb)
        .db.select()
        .from(audienceActivity)
        .where(
          and(
            eq(audienceActivity.platform, capture.platform),
            eq(audienceActivity.account, capture.account),
            eq(audienceActivity.metric, capture.metric),
            eq(audienceActivity.capturedAt, capture.capturedAt),
          ),
        )
        .orderBy(audienceActivity.weekday, audienceActivity.hourLocal)
        .all();
      const ageDays = Math.round((now.getTime() - new Date(capture.capturedAt).getTime()) / 86_400_000);
      return {
        ...capture,
        ageDays,
        stale: ageDays > STALE_AFTER_DAYS,
        timeZone: slots[0]?.timeZone ?? null,
        period: { start: slots[0]?.periodStart ?? null, end: slots[0]?.periodEnd ?? null },
        source: slots[0]?.source ?? null,
        slots: slots.length,
        busiestHours: busiest(slots),
        byWeekday: Object.fromEntries(
          WEEKDAYS.map((weekday) => [
            weekday,
            slots.filter((slot) => slot.weekday === weekday).map((slot) => ({ hour: slot.hourLocal, value: slot.value })),
          ]).filter(([, hours]) => (hours as unknown[]).length > 0),
        ),
      };
    }),
    reading: [
      "This is what a platform's own dashboard drew, not a result of anything published: it says when followers are around, and on Reels most views come from people who follow nothing.",
      `A capture older than ${STALE_AFTER_DAYS} days is marked stale — say so rather than quoting it as current.`,
      "Compare it against `video-report` publishHours before recommending an hour: the heatmap is a hypothesis, the publications are the evidence.",
    ],
  };
}

function busiest(slots: Array<{ weekday: string; hourLocal: number; value: number }>): Array<Record<string, unknown>> {
  const byWeekday = new Map<string, Array<{ hour: number; value: number }>>();
  for (const slot of slots)
    byWeekday.set(slot.weekday, [...(byWeekday.get(slot.weekday) ?? []), { hour: slot.hourLocal, value: slot.value }]);
  return [...byWeekday.entries()].map(([weekday, hours]) => ({
    weekday,
    hours: hours
      .sort((left, right) => right.value - left.value)
      .slice(0, 2)
      .map((hour) => hour.hour),
  }));
}

/** The captures a report should mention it is standing on. */
export function heatmapCoverage(backendDb: BackendDb, now = new Date()): Array<Record<string, unknown>> {
  return unsafeDb(backendDb)
    .db.select({
      platform: audienceActivity.platform,
      account: audienceActivity.account,
      metric: audienceActivity.metric,
      capturedAt: audienceActivity.capturedAt,
    })
    .from(audienceActivity)
    .orderBy(desc(audienceActivity.capturedAt))
    .limit(200)
    .all()
    .reduce<Array<Record<string, unknown>>>((unique, row) => {
      const key = `${row.platform}/${row.account}/${row.metric}`;
      if (unique.some((entry) => entry.key === key)) return unique;
      const ageDays = Math.round((now.getTime() - new Date(row.capturedAt).getTime()) / 86_400_000);
      unique.push({ key, ...row, ageDays, stale: ageDays > STALE_AFTER_DAYS });
      return unique;
    }, []);
}
