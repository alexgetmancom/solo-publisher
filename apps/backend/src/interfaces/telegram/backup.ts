import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import { InputFile } from "grammy";
import { claimSync, markSynced } from "../../analytics/snapshots/creator-store.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { log } from "../../foundation/logger.js";
import { backupDatabase } from "../../operations/maintenance.js";
import { settingsService } from "../../studio/services/settings.js";

/** Hour of this Studio's day at which the copy is sent. Late enough that the
 * day's publications are in it. */
const BACKUP_HOUR = 4;

export type BackupDeliveryStatus = "not_due" | "disabled" | "no_admins" | "sent" | "failed";

/**
 * A daily copy of the database, delivered to the operator's own Telegram.
 *
 * The database is the part that cannot be recreated: schedules, external ids,
 * delivery state and analytics. Media is not included — it is far past what
 * Telegram accepts and belongs to a volume backup, which the README says.
 *
 * The file is written with SQLite's own backup, never copied: a live database
 * has a write-ahead log beside it, and a plain copy of one is a corrupt
 * database that only announces itself when someone tries to restore it.
 */
export async function sendDailyBackup(
  config: BackendConfig,
  backendDb: BackendDb,
  bot: Bot | null,
  now = new Date(),
): Promise<BackupDeliveryStatus> {
  if (!bot) return "not_due";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: config.TIMEZONE,
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
  if (Number(parts.hour) < BACKUP_HOUR) return "not_due";
  if (!settingsService(backendDb).backup().enabled) return "disabled";
  if (config.CONTROLLER_ADMIN_IDS.length === 0) return "no_admins";

  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const owner = "telegram:daily-backup";
  if (!claimSync(backendDb, `daily_backup:${day}`, { intervalSeconds: 24 * 60 * 60, owner })) return "not_due";
  // Claimed before the snapshot: a failure must not retry on the next tick and
  // write a fresh copy of a multi-megabyte database every few seconds.
  markSynced(backendDb, `daily_backup:${day}`, null, owner);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-publisher-backup-"));
  try {
    const file = await backupDatabase(backendDb, config.PIPELINE_DB, directory);
    const caption = `🗄 ${day} · ${(fs.statSync(file).size / 1_000_000).toFixed(1)} MB`;
    for (const actorId of config.CONTROLLER_ADMIN_IDS) {
      // Silent: this arrives every day and is worth having, not worth waking up
      // for. A failure to deliver is worth knowing about, so it is logged.
      await bot.api.sendDocument(actorId, new InputFile(file, path.basename(file)), {
        caption,
        disable_notification: true,
      });
    }
    return "sent";
  } catch (error) {
    log("warn", "daily backup not delivered", { error: String(error) });
    // The day is already claimed, so nothing retries this until tomorrow. An
    // operator who is never told has no way to know the copies stopped coming.
    for (const actorId of config.CONTROLLER_ADMIN_IDS) {
      const locale = settingsService(backendDb).locale(actorId);
      try {
        await bot.api.sendMessage(actorId, t(locale, "settings.backup-failed-notice", { error: String(error).slice(0, 1_000) }));
      } catch (notifyError) {
        log("warn", "backup failure notice was not delivered", { actorId, error: String(notifyError) });
      }
    }
    return "failed";
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
