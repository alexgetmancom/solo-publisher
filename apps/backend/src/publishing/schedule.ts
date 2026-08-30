import { StudioError } from "../foundation/errors.js";
import { zonedDateParts, zonedSlot } from "../foundation/time.js";

const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/** Resolves a slot-button clock (`HH:MM` in the configured zone) to today's occurrence, or
 * tomorrow's if today's has already passed. Used by the RU/EN preset
 * scheduling buttons. */
export function publicationSlotTime(clock: string, timeZone: string, now = new Date()): Date {
  const today = zonedDateParts(now, timeZone);
  const value = zonedSlot(today.year, today.month, today.day, clock, timeZone);
  if (value > now) return value;
  const tomorrow = calendarDateAfter(today.year, today.month, today.day);
  return zonedSlot(tomorrow.year, tomorrow.month, tomorrow.day, clock, timeZone);
}

export function parseManualSchedule(value: string, timeZone: string, now = new Date()): Date {
  const input = value.trim().replace(/\s+/g, " ");
  const today = zonedDateParts(now, timeZone);
  let match = input.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) throw new StudioError("common.schedule-parse-error");
    const candidate = parseZonedSlot(today.year, today.month, today.day, `${match[1]?.padStart(2, "0")}:${match[2]}`, timeZone);
    if (candidate > now) return candidate;
    const tomorrow = calendarDateAfter(today.year, today.month, today.day);
    return parseZonedSlot(tomorrow.year, tomorrow.month, tomorrow.day, `${match[1]?.padStart(2, "0")}:${match[2]}`, timeZone);
  }
  match = input.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))? (\d{1,2}):(\d{2})$/);
  if (!match) throw new StudioError("common.schedule-parse-error");
  const year = Number(match[3] ?? today.year);
  const month = Number(match[2]);
  const day = Number(match[1]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) throw new StudioError("common.schedule-parse-error");
  const candidate = parseZonedSlot(year, month, day, `${match[4]?.padStart(2, "0")}:${match[5]}`, timeZone);
  const parts = zonedDateParts(candidate, timeZone);
  if (parts.year !== year || parts.month !== month || parts.day !== day) throw new StudioError("common.schedule-parse-error");
  if (!match[3] && candidate <= now) throw new StudioError("err.schedule-date-past");
  assertFutureSchedule(candidate, now);
  return candidate;
}

/** The soonest a publication can be given. Delivery runs off the schedule, so
 * "now" is a timestamp a minute out rather than a second path to publication:
 * the card's "publish now" and the schedule screen's "send now" both resolve
 * here, and the confirmation reads a schedule back as immediate through
 * `isImmediateSchedule`. */
const IMMEDIATE_SCHEDULE_LEAD_MS = 60_000;

export function immediateScheduleTime(now: Date): Date {
  return new Date(now.getTime() + IMMEDIATE_SCHEDULE_LEAD_MS);
}

export function isImmediateSchedule(value: Date, now: Date): boolean {
  return value.getTime() - now.getTime() <= IMMEDIATE_SCHEDULE_LEAD_MS;
}

/** Enforces the application-level contract shared by post and video scheduling. */
export function assertFutureSchedule(value: Date, now = new Date()): void {
  if (Number.isNaN(value.getTime()) || value.getTime() <= now.getTime()) throw new StudioError("err.schedule-time-past");
  if (value.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS) throw new StudioError("err.schedule-too-far");
}

/** Validates a persisted schedule while allowing an internal replan to retain a
 * timestamp that has become due between the original schedule and the replan. */
export function assertValidScheduleDate(value: Date): void {
  if (Number.isNaN(value.getTime())) throw new StudioError("err.schedule-time-past");
}

function parseZonedSlot(year: number, month: number, day: number, clock: string, timeZone: string): Date {
  try {
    return zonedSlot(year, month, day, clock, timeZone);
  } catch {
    throw new StudioError("common.schedule-parse-error");
  }
}

function calendarDateAfter(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}
