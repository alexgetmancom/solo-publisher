import { describe, expect, it } from "bun:test";
import type { Bot } from "grammy";
import { startTelegramWorkers } from "../src/interfaces/telegram/worker.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("Telegram interface workers", () => {
  it("runs event delivery, alerts and slow daily jobs in independent loops", async () => {
    await withDb(async (backendDb) => {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
      const bot = { api: {} } as Bot;
      const workers = startTelegramWorkers(config, backendDb, bot);
      try {
        expect(workers.map((worker) => worker.name)).toEqual([
          "telegram-albums",
          "telegram-events",
          "telegram-alerts",
          "telegram-weekly-summary",
          "telegram-daily-backup",
          "telegram-radar",
          "telegram-analytics-dashboard",
        ]);
        await Bun.sleep(10);
      } finally {
        for (const worker of workers) worker.stop();
      }
    });
  });
});
