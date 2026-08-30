import { describe, expect, it } from "bun:test";
import type { Bot } from "grammy";
import { sendWeeklyAnalyticsSummary } from "../src/interfaces/telegram/analytics-summary.js";
import { settingsService } from "../src/studio/services/settings.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig, MSK_STUDIO_PROFILE } from "./helpers/studio-config.js";

describe("weekly analytics summary", () => {
  it("uses one Studio-wide setting and sends to every administrator", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42,7" }, MSK_STUDIO_PROFILE);
      settingsService(backendDb).setWeeklyDigest({ enabled: true, weekday: 1 });
      const sent: Array<{ actorId: number; text: string }> = [];
      const bot = {
        api: {
          sendMessage: async (actorId: number, text: string) => {
            sent.push({ actorId, text });
          },
        },
      } as unknown as Bot;
      const mondayAfterNine = new Date("2026-07-27T18:05:00.000Z");

      expect(await sendWeeklyAnalyticsSummary(config, backendDb, bot, mondayAfterNine)).toBe(true);
      expect(sent.map(({ actorId }) => actorId)).toEqual([42, 7]);
      expect(sent[0]?.text).toContain("Weekly digest");
      expect(sent[0]?.text).toContain("| Platform | 👥 | 📈 | 👁 | ♥ | 💬 | ↗ | 🔖 |");
      expect(await sendWeeklyAnalyticsSummary(config, backendDb, bot, mondayAfterNine)).toBe(false);
      expect(sent).toHaveLength(2);
    }));

  it("waits until 21:00 in the Studio timezone", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }, MSK_STUDIO_PROFILE);
      settingsService(backendDb).setWeeklyDigest({ weekday: 1 });
      const bot = { api: { sendMessage: async () => undefined } } as unknown as Bot;

      expect(await sendWeeklyAnalyticsSummary(config, backendDb, bot, new Date("2026-07-27T17:59:00.000Z"))).toBe(false);
    }));
});
