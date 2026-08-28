import { describe, expect, it } from "bun:test";
import { creatorMilestoneHistory } from "../src/analytics/reports/milestone-history.js";
import { withDb } from "./helpers/db.js";

describe("milestone history", () => {
  it("lists reached milestones newest first with local achievement times", () =>
    withDb(async (backendDb) => {
      backendDb.sqlite
        .prepare("INSERT INTO publication_events(event_type,severity,message,created_at) VALUES (?, 'info', ?, ?), (?, 'info', ?, ?)")
        .run(
          "analytics.milestone.reached",
          "🎉 Telegram RU: 250 подписчиков!",
          "2026-01-02T09:00:00.000Z",
          "analytics.milestone.reached",
          "🎉 X EN: 500 подписчиков!",
          "2026-01-03T10:30:00.000Z",
        );

      const history = creatorMilestoneHistory(backendDb, 0, "ru", "Europe/Moscow");

      expect(history.total).toBe(2);
      expect(history.items.map((item) => item.message)).toEqual(["🎉 X EN: 500 подписчиков!", "🎉 Telegram RU: 250 подписчиков!"]);
      expect(history.text).toContain("03.01.2026, 13:30 — 🎉 X EN: 500 подписчиков!");
    }));
});
