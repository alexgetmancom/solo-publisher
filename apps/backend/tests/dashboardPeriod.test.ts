import { describe, expect, it, setSystemTime } from "bun:test";
import { renderPeriodControls, rollingPeriodDates } from "../src/interfaces/web/dashboard/period-controls.js";

describe("command center period controls", () => {
  it("offers one day first and keeps a selected platform when changing periods", () => {
    const html = String(renderPeriodControls("ru", 0, 1, "Europe/Moscow", "threads_en", "instagram_reels:ru", "&metric=followers"));

    expect(html).toContain(">1д<");
    expect(html).toContain("view=threads_en");
    expect(html).toContain("video_view=instagram_reels%3Aru");
    expect(html).toContain("metric=followers");
    expect(html).toContain(">30д<");
  });

  it("derives the calendar range from the configured timezone", () => {
    setSystemTime(new Date("2026-08-09T22:30:00.000Z"));
    try {
      expect(rollingPeriodDates(0, 1, "Europe/Moscow").map((date) => date.toISOString())).toEqual([
        "2026-08-10T00:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
      ]);
      expect(rollingPeriodDates(0, 1, "America/Los_Angeles").map((date) => date.toISOString())).toEqual([
        "2026-08-09T00:00:00.000Z",
        "2026-08-09T00:00:00.000Z",
      ]);
      expect(rollingPeriodDates(1, 7, "Europe/Moscow").map((date) => date.toISOString())).toEqual([
        "2026-07-28T00:00:00.000Z",
        "2026-08-03T00:00:00.000Z",
      ]);
    } finally {
      setSystemTime();
    }
  });
});
