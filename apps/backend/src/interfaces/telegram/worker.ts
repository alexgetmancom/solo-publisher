import type { Bot } from "grammy";
import { finalizePendingAlbums } from "../../bot/albums.js";
import { refreshTelegramAnalyticsDashboards } from "../../bot/analytics-screen.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import { heartbeatLoop } from "../../foundation/runtime/worker-state.js";
import { type ScheduledLoop, startLoop } from "../../foundation/scheduler.js";
import { setWorkerWake } from "../../foundation/worker-signal.js";
import { deliverPendingAlerts } from "../../observability/alerts.js";
import { sendWeeklyAnalyticsSummary } from "./analytics-summary.js";
import { sendDailyBackup } from "./backup.js";
import { sendDailyEditorialInbox } from "./editorial-inbox.js";
import { consumeTelegramEvents } from "./event-consumer.js";
import { sendDailyNewsDigest } from "./news-digest.js";

const DAILY_INTERFACE_POLL_INTERVAL_SECONDS = 60;

/** Telegram is an event consumer and ingress adapter, never a domain worker dependency. */
export function startTelegramWorkers(config: BackendConfig, backendDb: BackendDb, bot: Bot | null): ScheduledLoop[] {
  if (!bot) return [];
  const interfacePollMs = config.IDLE_POLL_INTERVAL_SECONDS * 1000;
  const dailyPollMs = DAILY_INTERFACE_POLL_INTERVAL_SECONDS * 1000;
  const startInterfaceLoop = heartbeatLoop(backendDb, startLoop);
  // The card an operator is watching changes when this runs, so it is rung the
  // moment a domain event is written rather than waiting out the poll.
  const telegramEventLoop = startInterfaceLoop("telegram-events", interfacePollMs, async () => {
    const events = await consumeTelegramEvents(backendDb, bot, config);
    if (events) log("debug", "telegram event loop tick", { events });
  });
  setWorkerWake("telegram-events", telegramEventLoop.wake);
  return [
    startInterfaceLoop("telegram-albums", 1000, async () => {
      const completed = await finalizePendingAlbums(bot, backendDb, config);
      if (completed) log("info", "album drafts finalized", { completed });
    }),
    telegramEventLoop,
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
    startInterfaceLoop("telegram-editorial-inbox", dailyPollMs, async () => {
      const editorialInbox = await sendDailyEditorialInbox(config, backendDb, bot);
      if (editorialInbox) log("debug", "telegram editorial inbox delivered");
    }),
    startInterfaceLoop("telegram-news-digest", dailyPollMs, async () => {
      const newsDigest = await sendDailyNewsDigest(config, backendDb, bot);
      if (newsDigest.status !== "not_due" && newsDigest.status !== "disabled")
        log("debug", "telegram news digest loop tick", { status: newsDigest.status });
    }),
    startInterfaceLoop("telegram-analytics-dashboard", 60 * 60 * 1000, async () => {
      const refreshed = await refreshTelegramAnalyticsDashboards(bot, backendDb, config);
      if (refreshed) log("debug", "analytics dashboards refreshed", { refreshed });
    }),
  ];
}
