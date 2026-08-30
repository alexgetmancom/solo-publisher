import type { Bot } from "grammy";
import { studioAnalyticsDashboard } from "../../analytics/reports/studio-dashboard.js";
import { claimSync, markSynced } from "../../analytics/snapshots/creator-store.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { log } from "../../foundation/logger.js";
import { settingsService } from "../../studio/services/settings.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Telegram-only weekly delivery of an already computed Analytics report. */
export async function sendWeeklyAnalyticsSummary(
  config: BackendConfig,
  backendDb: BackendDb,
  bot: Bot | null,
  now = new Date(),
): Promise<boolean> {
  if (!bot) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: config.TIMEZONE,
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  if (Number(parts.hour) < 21) return false;
  const weekday = WEEKDAYS.indexOf(parts.weekday as (typeof WEEKDAYS)[number]);
  if (weekday < 0) return false;
  const settings = settingsService(backendDb).weeklyDigest();
  if (!settings.enabled || settings.weekday !== weekday) return false;
  const key = `weekly_summary:${parts.year}-${parts.month}-${parts.day}`;
  const owner = "telegram:weekly-summary";
  if (!claimSync(backendDb, key, { intervalSeconds: 24 * 60 * 60, owner })) return false;
  // Claim this Studio before sending so one unreachable chat cannot cause
  // repeated delivery attempts to the other administrators on every worker tick.
  markSynced(backendDb, key, null, owner);
  const reports = new Map<string, string>();
  for (const actorId of config.CONTROLLER_ADMIN_IDS) {
    try {
      const locale = settingsService(backendDb).locale(actorId);
      let report = reports.get(locale);
      if (!report) {
        report = `📊 *${t(locale, "weekly.digest")}*\n${studioAnalyticsDashboard(backendDb, "overview", 7, locale).text}`;
        reports.set(locale, report);
      }
      await bot.api.sendMessage(actorId, report, { parse_mode: "Markdown" });
    } catch (error) {
      log("warn", "weekly analytics digest not delivered", { actorId, error: String(error) });
    }
  }
  return true;
}
