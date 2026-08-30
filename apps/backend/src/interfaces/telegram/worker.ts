import type { Bot } from "grammy";
import { finalizePendingAlbums } from "../../bot/albums.js";
import { refreshTelegramAnalyticsDashboards } from "../../bot/analytics-screen.js";
import type { BackendDb } from "../../db/client.js";
import { captureOutcomes } from "../../editorial/outcomes.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import { heartbeatLoop } from "../../foundation/runtime/worker-state.js";
import { type ScheduledLoop, startLoop } from "../../foundation/scheduler.js";
import { deliverPendingAlerts } from "../../observability/alerts.js";
import { sendWeeklyAnalyticsSummary } from "./analytics-summary.js";
import { sendDailyBackup } from "./backup.js";
import { consumeTelegramEvents } from "./event-consumer.js";
import { sendDailyRadar } from "./radar.js";

const DAILY_INTERFACE_POLL_INTERVAL_SECONDS = 60;

/** Telegram is an event consumer and ingress adapter, never a domain worker dependency. */
export function startTelegramWorkers(config: BackendConfig, backendDb: BackendDb, bot: Bot | null): ScheduledLoop[] {
  if (!bot) return [];
  const interfacePollMs = config.IDLE_POLL_INTERVAL_SECONDS * 1000;
  const dailyPollMs = DAILY_INTERFACE_POLL_INTERVAL_SECONDS * 1000;
  const startInterfaceLoop = heartbeatLoop(backendDb, startLoop);
  return [
    startInterfaceLoop("telegram-albums", 1000, async () => {
      const completed = await finalizePendingAlbums(bot, backendDb, config);
      if (completed) log("info", "album drafts finalized", { completed });
    }),
    startInterfaceLoop("telegram-events", interfacePollMs, async () => {
      const events = await consumeTelegramEvents(backendDb, bot, config);
      if (events) log("debug", "telegram event loop tick", { events });
    }),
    startInterfaceLoop("telegram-alerts", interfacePollMs, async () => {
      const actorId = config.CONTROLLER_ADMIN_IDS[0];
      const alerts = await deliverPendingAlerts(backendDb, {
        ...(actorId === undefined ? {} : { sendAlert: async (text) => void (await bot.api.sendMessage(actorId, text)) }),
      });
      if (alerts) log("debug", "telegram alert loop tick", { alerts });
    }),
    startInterfaceLoop("telegram-weekly-summary", dailyPollMs, async () => {
      const weeklySummary = await sendWeeklyAnalyticsSummary(config, backendDb, bot);
      if (weeklySummary) log("debug", "telegram weekly summary delivered");
    }),
    startInterfaceLoop("telegram-daily-backup", dailyPollMs, async () => {
      const backup = await sendDailyBackup(config, backendDb, bot);
      if (backup !== "not_due" && backup !== "disabled") log("debug", "telegram daily backup tick", { status: backup });
    }),
    startInterfaceLoop("telegram-radar", dailyPollMs, async () => {
      const radar = await sendDailyRadar(config, backendDb, bot);
      const ran = radar.runs.some((run) => !["not_due", "disabled", "already_ran"].includes(run.status));
      if (ran || radar.delivered)
        log("debug", "telegram radar loop tick", { runs: radar.runs.map((run) => run.status), delivered: radar.delivered });
      const outcomes = captureOutcomes(backendDb);
      if (outcomes) log("debug", "radar outcomes captured", { outcomes });
    }),
    startInterfaceLoop("telegram-analytics-dashboard", 60 * 60 * 1000, async () => {
      const refreshed = await refreshTelegramAnalyticsDashboards(bot, backendDb, config);
      if (refreshed) log("debug", "analytics dashboards refreshed", { refreshed });
    }),
  ];
}
