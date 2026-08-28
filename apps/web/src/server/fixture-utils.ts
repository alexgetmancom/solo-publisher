import { zonedDateParts, zonedSlot } from "../../../backend/src/foundation/time.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function iso(date: Date): string {
  return date.toISOString();
}

export function hoursAgo(hours: number, now = new Date()): Date {
  return new Date(now.getTime() - hours * HOUR_MS);
}

/** How long a fixture publication has been live, in hours. */
export function hoursSince(publishedAt: string): number {
  return (Date.now() - new Date(publishedAt).getTime()) / HOUR_MS;
}

export function daysAgo(days: number, now = new Date()): Date {
  return hoursAgo(days * 24, now);
}

function fixtureDayStart(dayOffset: number, timeZone = "Europe/Moscow", now = new Date()): Date {
  const current = zonedDateParts(now, timeZone);
  const calendar = new Date(Date.UTC(current.year, current.month - 1, current.day - Math.max(0, Math.floor(dayOffset))));
  return zonedSlot(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), "00:00", timeZone);
}

export function fixtureDayWindow(dayOffset: number, now = new Date(), timeZone = "Europe/Moscow"): [Date, Date] {
  const start = fixtureDayStart(dayOffset, timeZone, now);
  const end =
    dayOffset === 0 ? new Date(Math.max(start.getTime() + 60_000, now.getTime() - 60_000)) : new Date(start.getTime() + DAY_MS - 60_000);
  return [start, end];
}

export function fixtureSampleSlots(publishedAt: string, now: Date, historyDays: number, hoursPerSample = 2): number {
  const ageHours = Math.max(hoursPerSample, (now.getTime() - new Date(publishedAt).getTime()) / HOUR_MS);
  return Math.max(1, Math.min(historyDays * (24 / hoursPerSample), Math.ceil(ageHours / hoursPerSample)));
}

export function fixtureSampleAt(publishedAt: string, now: Date, slot: number, hoursPerSample = 2): string {
  const publishedTime = new Date(publishedAt).getTime();
  const candidate = now.getTime() - slot * hoursPerSample * HOUR_MS;
  return new Date(Math.max(publishedTime, candidate)).toISOString();
}
