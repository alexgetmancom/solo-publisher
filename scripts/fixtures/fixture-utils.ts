import { zonedDateParts, zonedSlot } from "../../apps/backend/src/foundation/time.js";

const DAY_MS = 86_400_000;

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
