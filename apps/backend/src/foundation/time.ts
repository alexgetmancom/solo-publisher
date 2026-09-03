/** Single source for zone-aware date math and display, driven by the
 * `timezone`/`timezoneLabel` on this Studio's profile row (see studio.ts).
 * Every Studio surface that shows or slots a schedule time reads from here. */
import { STUDIO_LOCALE_TAGS, type StudioLocale } from "./locale.js";

const FULL_ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Machine timestamps name an instant with an explicit offset. JavaScript also
 * accepts host-local and RFC-like dates whose meaning changes by timezone. */
export function parseIsoInstant(value: string): Date {
  if (!FULL_ISO_INSTANT.test(value)) throw new RangeError("must be a full ISO timestamp, for example 2026-08-27T14:01:34Z");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("must be a full ISO timestamp, for example 2026-08-27T14:01:34Z");
  return date;
}

export function isIsoInstant(value: string): boolean {
  try {
    parseIsoInstant(value);
    return true;
  } catch {
    return false;
  }
}

/** UTC-minus-local offset in ms for `date` in `timeZone`, read from the actual
 * civil-time offset rather than a fixed constant so it holds for zones that
 * observe daylight saving too. Computed by reading the zone's wall-clock digits
 * and comparing them to the instant directly, rather than parsing Intl's
 * locale-formatted offset string (ICU renders e.g. "UTC" inconsistently
 * across platforms, which broke a string-parsing version of this in CI). */
export function timezoneOffsetMs(date: Date, timeZone: string): number {
  return zonedWallClockMs(date, timeZone) - date.getTime();
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

/** Abbreviated month name, from ICU rather than a hand-kept array: the array
 * needed a new row per language, this needs nothing. The trailing dot some
 * locales add ("янв.") is dropped so the label sits inside a compact chip. */
export function monthShortName(locale: StudioLocale, month: number, upper = false): string {
  const name = new Intl.DateTimeFormat(STUDIO_LOCALE_TAGS[locale], { month: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(2001, month - 1, 1)))
    .replace(/\.$/, "");
  return upper ? name.toUpperCase() : name;
}

export function timeZoneOffsetLabel(timeZone: string, locale: StudioLocale = "en"): string {
  return (
    new Intl.DateTimeFormat(STUDIO_LOCALE_TAGS[locale], {
      timeZone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone
  );
}

/** Constructing an Intl.DateTimeFormat costs far more than formatting with one,
 * and this module runs per queue row, per calendar day and per offset probe.
 * Formatters are immutable and depend only on (locale, zone, shape), so one
 * instance per combination is reused for the process lifetime. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(cacheKey: string, locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cached = formatterCache.get(cacheKey);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat(locale, options);
  formatterCache.set(cacheKey, created);
  return created;
}

/** Calendar date `date` reads as in `timeZone`. */
export function zonedDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = formatter(`parts:${timeZone}`, "en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(value.year), month: Number(value.month), day: Number(value.day) };
}

export function zonedCalendarDay(date: Date, timeZone: string): string {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Whole days from `now` to `date`, both read as calendar dates in `timeZone`.
 * Negative is in the past. This is what "today", "tomorrow" and "yesterday"
 * mean to an operator, and it cannot be done in milliseconds: a day is not
 * 86,400,000 ms across a DST change. */
export function zonedDayDistance(date: Date, now: Date, timeZone: string): number {
  return Math.round((zonedDayNumber(date, timeZone) - zonedDayNumber(now, timeZone)) / 86_400_000);
}

function zonedDayNumber(date: Date, timeZone: string): number {
  const parts = zonedDateParts(date, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

/** "18:30" as the operator's locale and zone read it. */
export function formatZonedClock(date: Date, locale: StudioLocale, timeZone: string): string {
  return formatter(`clock:${locale}:${timeZone}`, STUDIO_LOCALE_TAGS[locale], {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** "5 Aug" / "5 авг." — a date close enough that the year is noise. */
export function formatZonedDayMonth(date: Date, locale: StudioLocale, timeZone: string): string {
  return formatter(`day-month:${locale}:${timeZone}`, STUDIO_LOCALE_TAGS[locale], { timeZone, day: "numeric", month: "short" }).format(
    date,
  );
}

export function zonedDateTimeParts(date: Date, timeZone: string): { day: string; hour: number; minute: number } {
  const parts = formatter(`date-time:${timeZone}`, "en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { day: `${value.year}-${value.month}-${value.day}`, hour: Number(value.hour), minute: Number(value.minute) };
}

export function manualScheduleExample(timeZone: string, now = new Date()): string {
  const date = zonedDateParts(now, timeZone);
  return `${String(date.day).padStart(2, "0")}.${String(date.month).padStart(2, "0")} HH:MM`;
}

/** The instant at which the wall clock in `timeZone` reads `clock` (HH:MM) on the given date. */
export function zonedSlot(year: number, month: number, day: number, clock: string, timeZone: string): Date {
  const [hour, minute] = clock.split(":").map(Number) as [number, number];
  const wallClockMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsets = new Set<number>();
  // Sample both sides of the requested wall clock. A single offset lookup at
  // the UTC-shaped wall clock is wrong around DST changes: it can select the
  // offset before the transition for a time after it, or vice versa. A day on
  // each side is enough — no zone's offset differs from the instant it labels
  // by more than that — and the round-trip filter below rejects a wrong guess.
  for (const probeMs of [wallClockMs - 86_400_000, wallClockMs, wallClockMs + 86_400_000]) {
    offsets.add(timezoneOffsetMs(new Date(probeMs), timeZone));
  }
  const candidates = [...offsets]
    .map((offset) => wallClockMs - offset)
    .filter((candidateMs) => zonedWallClockMs(new Date(candidateMs), timeZone) === wallClockMs)
    .sort((left, right) => left - right);
  const candidateMs = candidates[0];
  if (candidateMs == null) throw new RangeError(`Wall-clock time does not exist in ${timeZone}`);
  return new Date(candidateMs);
}

function zonedWallClockMs(date: Date, timeZone: string): number {
  const parts = formatter(`wall:${timeZone}`, "en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    Number(value.hour),
    Number(value.minute),
    Number(value.second),
  );
}

/** Telegram/dashboard display, e.g. "15.07.2026 18:30 MSK". */
export function formatZonedDateTime(value: string | Date | null, timeZone: string, label: string): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  return `${formatter(`display:${timeZone}`, "ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)} ${label}`;
}

/** Sortable "YYYY-MM-DD HH:MM" reading in `timeZone`, for machine-friendly summaries. */
export function formatZonedSortable(value: string, timeZone: string): string {
  const date = new Date(value);
  return formatter(`sortable:${timeZone}`, "sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Inclusive ISO `[start, end]` bounds of the Monday-start week `offset` weeks
 * from `now`, in `timeZone`. `end` is the last millisecond of the week, matching
 * zonedRollingPeriodBounds — both feed `BETWEEN`-style range queries. */
export function zonedWeekBounds(offset: number, timeZone: string, now = new Date()): [string, string] {
  const offsetMs = timezoneOffsetMs(now, timeZone);
  const zonedNow = new Date(now.getTime() + offsetMs);
  const weekday = (zonedNow.getUTCDay() + 6) % 7;
  const startWallUtc = Date.UTC(zonedNow.getUTCFullYear(), zonedNow.getUTCMonth(), zonedNow.getUTCDate() - weekday - offset * 7);
  const start = startWallUtc - offsetMs;
  return [new Date(start).toISOString(), new Date(start + 7 * 86_400_000 - 1).toISOString()];
}

/** Inclusive ISO `[start, end]` bounds for a rolling calendar period ending today in `timeZone`.
 * `offset` moves back by whole periods, so a 7-day dashboard always compares
 * like-for-like trailing windows instead of calendar weeks. */
export function zonedRollingPeriodBounds(offset: number, days: number, timeZone: string, now = new Date()): [string, string] {
  const shiftedNow = new Date(now.getTime() - offset * days * 86_400_000);
  const offsetMs = timezoneOffsetMs(shiftedNow, timeZone);
  const zoned = new Date(shiftedNow.getTime() + offsetMs);
  const endWallUtc = Date.UTC(zoned.getUTCFullYear(), zoned.getUTCMonth(), zoned.getUTCDate() + 1);
  const startWallUtc = endWallUtc - days * 86_400_000;
  return [new Date(startWallUtc - offsetMs).toISOString(), new Date(endWallUtc - offsetMs - 1).toISOString()];
}

/** "Today" in the configured zone, not the server's. Lived in two dashboard
 * modules as identical copies before it moved next to zonedDateParts. */
export function isCurrentCalendarDay(value: Date, timeZone: string): boolean {
  const current = zonedDateParts(new Date(), timeZone);
  const target = zonedDateParts(value, timeZone);
  return current.year === target.year && current.month === target.month && current.day === target.day;
}
