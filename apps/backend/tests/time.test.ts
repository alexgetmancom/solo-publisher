import { describe, expect, it } from "bun:test";
import {
  formatZonedDateTime,
  formatZonedSortable,
  parseIsoInstant,
  timezoneOffsetMs,
  zonedDateParts,
  zonedSlot,
  zonedWeekBounds,
} from "../src/foundation/time.js";

describe("foundation/time", () => {
  it("accepts only timestamps that identify the same instant on every host", () => {
    expect(parseIsoInstant("2026-08-20T00:00:00+03:00").toISOString()).toBe("2026-08-19T21:00:00.000Z");
    expect(() => parseIsoInstant("Thu, Aug 20, 2026")).toThrow("must be a full ISO timestamp");
    expect(() => parseIsoInstant("2026-08-20")).toThrow("must be a full ISO timestamp");
  });

  it("resolves the configured IANA zone's offset from the actual civil time", () => {
    expect(timezoneOffsetMs(new Date("2026-07-18T12:00:00Z"), "Europe/Moscow")).toBe(3 * 3_600_000);
    expect(timezoneOffsetMs(new Date("2026-07-18T12:00:00Z"), "UTC")).toBe(0);
  });

  it("reads the calendar date as it appears in the configured zone", () => {
    // 23:30 UTC on the 17th is already the 18th in Moscow (+3).
    expect(zonedDateParts(new Date("2026-07-17T23:30:00Z"), "Europe/Moscow")).toEqual({ year: 2026, month: 7, day: 18 });
  });

  it("builds the instant at which the zone's wall clock reads a given time", () => {
    const slot = zonedSlot(2026, 7, 18, "18:30", "Europe/Moscow");
    expect(slot.toISOString()).toBe("2026-07-18T15:30:00.000Z");
  });

  it("formats a display string with the configured label, default Moscow behavior unchanged", () => {
    expect(formatZonedDateTime("2026-07-18T15:30:00.000Z", "Europe/Moscow", "MSK")).toBe("18.07.2026, 18:30 MSK");
    expect(formatZonedDateTime(null, "Europe/Moscow", "MSK")).toBe("-");
  });

  it("supports a non-Moscow configured zone end to end", () => {
    const slot = zonedSlot(2026, 7, 18, "09:00", "America/New_York");
    expect(formatZonedDateTime(slot, "America/New_York", "ET")).toBe("18.07.2026, 09:00 ET");
  });

  it("formats a sortable reading in the configured zone", () => {
    expect(formatZonedSortable("2026-07-18T15:30:00.000Z", "Europe/Moscow")).toBe("2026-07-18 18:30");
  });

  // zonedSlot probes only one day either side of the requested wall clock. That
  // is what makes it cheap, and this is the property that makes it correct: the
  // instant it returns must read back as exactly the wall clock asked for.
  it("round-trips every half hour across DST transitions, including half-hour and gap zones", () => {
    const zones = ["Europe/Moscow", "Europe/Berlin", "America/New_York", "Australia/Lord_Howe", "Pacific/Chatham", "America/Santiago"];
    const months: Array<[number, number]> = [
      [2026, 3],
      [2026, 10],
      [2026, 11],
      [2027, 4],
    ];
    let resolved = 0;
    let gaps = 0;
    for (const timeZone of zones) {
      for (const [year, month] of months) {
        for (let day = 1; day <= 28; day++) {
          for (let hour = 0; hour < 24; hour++) {
            for (const minute of [0, 30]) {
              const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
              let slot: Date;
              try {
                slot = zonedSlot(year, month, day, clock, timeZone);
              } catch {
                // A wall clock skipped by a spring-forward transition has no instant.
                gaps += 1;
                continue;
              }
              const parts = zonedDateParts(slot, timeZone);
              expect([parts.year, parts.month, parts.day]).toEqual([year, month, day]);
              expect(formatZonedSortable(slot.toISOString(), timeZone)).toBe(
                `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${clock}`,
              );
              resolved += 1;
            }
          }
        }
      }
    }
    expect(resolved).toBeGreaterThan(30_000);
    // Spring-forward gaps must actually be exercised, or the throw path is untested.
    expect(gaps).toBeGreaterThan(0);
  });

  it("computes Monday-start week bounds in the configured zone", () => {
    const [start, end] = zonedWeekBounds(0, "Europe/Moscow", new Date("2026-07-18T12:00:00Z"));
    expect(start).toBe("2026-07-12T21:00:00.000Z");
    expect(end).toBe("2026-07-19T20:59:59.999Z");
  });
});
