import type { Bot } from "grammy";
import { finalizePendingAlbums } from "../../bot/albums.js";
import { refreshPostPreviewCard } from "../../bot/progress.js";
import { runTranslationCycle } from "../../content/translation-worker.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import { heartbeatLoop } from "../../foundation/runtime/worker-state.js";
import { type ScheduledLoop, startLoop } from "../../foundation/scheduler.js";
import { setWorkerWake } from "../../foundation/worker-signal.js";
import { deliverPendingAlerts } from "../../observability/alerts.js";
import { sendDailyBackup } from "./backup.js";
import { consumeTelegramEvents } from "./event-consumer.js";

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
    // A draft's English is made here rather than in the tap that created it: the
    // card is already on screen, and this puts the translation into it.
    startInterfaceLoop("telegram-translations", 1000, async () => {
      const translated = await runTranslationCycle(backendDb, config);
      for (const draftId of translated) await refreshPostPreviewCard(backendDb, bot, config, draftId);
      if (translated.length) log("info", "draft translations settled", { drafts: translated });
    }),
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
    startInterfaceLoop("telegram-daily-backup", dailyPollMs, async () => {
      const backup = await sendDailyBackup(config, backendDb, bot);
      if (backup !== "not_due" && backup !== "disabled") log("debug", "telegram daily backup tick", { status: backup });
    }),
  ];
}
