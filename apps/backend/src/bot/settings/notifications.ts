import { Menu } from "@grammyjs/menu";
import type { Bot, Context } from "grammy";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { createStudioServices } from "../../studio/services/index.js";
import { settingsService } from "../../studio/services/settings.js";
import {
  BACKUP_MENU_ID,
  backToSettings,
  choiceLabel,
  NOTIFICATION_SETTINGS_MENU_ID,
  NOTIFICATIONS_MENU_ID,
  settingsScreen,
  settingsUpdate,
  switchLabel,
} from "./shared.js";

export function buildNotificationsMenu(config: BackendConfig, backendDb: BackendDb, _bot: Bot | null): Menu<Context> {
  const notificationSettings = new Menu<Context>(NOTIFICATION_SETTINGS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const settings = createStudioServices(backendDb, config).settings.notifications(actorId);
    const locale = settingsService(backendDb).locale(actorId);
    range;
    const body = () => notificationSettingsText(backendDb, config, actorId, locale);
    const setNotifications = (input: Parameters<ReturnType<typeof settingsService>["setNotifications"]>[1]) =>
      createStudioServices(backendDb, config).settings.setNotifications(actorId, input);
    range
      .text(
        switchLabel(settings.videoRemindersEnabled, t(locale, "settings.video-reminder-label")),
        settingsUpdate({ apply: () => setNotifications({ videoRemindersEnabled: !settings.videoRemindersEnabled }), body }),
      )
      .text(
        switchLabel(settings.postRemindersEnabled, t(locale, "settings.post-reminder-label")),
        settingsUpdate({ apply: () => setNotifications({ postRemindersEnabled: !settings.postRemindersEnabled }), body }),
      )
      .row()
      .text(
        switchLabel(settings.completionEnabled, t(locale, "settings.completion-label")),
        settingsUpdate({ apply: () => setNotifications({ completionEnabled: !settings.completionEnabled }), body }),
      )
      .row();
    // Three to a row: the markers made every label wider, and five of them
    // squeezed the digits on a phone.
    for (const [index, minutes] of ([1, 5, 10, 15, 30] as const).entries()) {
      range.text(
        choiceLabel(settings.reminderMinutes === minutes, t(locale, "settings.minutes-option", { minutes })),
        settingsUpdate({
          apply: () => setNotifications({ reminderMinutes: minutes }),
          body,
          toast: t(locale, "settings.minutes-toast", { minutes }),
        }),
      );
      if (index % 3 === 2) range.row();
    }
    range.row().back(
      t(locale, "settings.back-to-notifications"),
      settingsScreen(() => t(locale, "settings.category-notifications-body"), true),
    );
  });

  const notifications = new Menu<Context>(NOTIFICATIONS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .submenu(
        t(locale, "settings.publication-notifications"),
        NOTIFICATION_SETTINGS_MENU_ID,
        settingsScreen(() => notificationSettingsText(backendDb, config, actorId, locale)),
      )
      .row()
      .back(t(locale, "settings.back-to-settings"), backToSettings(backendDb));
  });
  notifications.register(notificationSettings);
  return notifications;
}

/** A database copy is not something the bot tells you about, it is something
 * the machine does; it sat under Notifications only because nothing else here
 * held maintenance. */
export function buildBackupMenu(config: BackendConfig, backendDb: BackendDb): Menu<Context> {
  return new Menu<Context>(BACKUP_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    const settings = createStudioServices(backendDb, config).settings.backup();
    range
      .text(
        switchLabel(settings.enabled, t(locale, "settings.backup-enabled")),
        settingsUpdate({
          apply: () => createStudioServices(backendDb, config).settings.setBackup({ enabled: !settings.enabled }),
          body: () => backupText(backendDb, config, locale),
        }),
      )
      .row()
      .back(
        t(locale, "settings.back-to-system"),
        settingsScreen(() => t(locale, "settings.category-system-body"), true),
      );
  });
}

function notificationSettingsText(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: StudioLocale): string {
  const settings = createStudioServices(backendDb, config).settings.notifications(actorId);
  const on = (value: boolean) => (value ? t(locale, "settings.on") : t(locale, "settings.off"));
  return t(locale, "settings.notif-body", {
    videoReminders: on(settings.videoRemindersEnabled),
    postReminders: on(settings.postRemindersEnabled),
    minutes: settings.reminderMinutes,
    completion: on(settings.completionEnabled),
  });
}

export function backupText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  return t(locale, "settings.backup-body", {
    status: createStudioServices(backendDb, config).settings.backup().enabled ? t(locale, "settings.on") : t(locale, "settings.off"),
  });
}
