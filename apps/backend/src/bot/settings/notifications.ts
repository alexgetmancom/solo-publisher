import { Menu } from "@grammyjs/menu";
import type { Bot, Context } from "grammy";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { describeError, t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { sendDailyNewsDigest } from "../../interfaces/telegram/news-digest.js";
import { createStudioServices } from "../../studio/services/index.js";
import { NEWS_DIGEST_EFFORTS, settingsService } from "../../studio/services/settings.js";
import { clearConversationState } from "../conversation-state.js";
import {
  BACKUP_MENU_ID,
  backToSettings,
  beginSettingsInput,
  formatTime,
  NEWS_DIGEST_MENU_ID,
  NEWS_DIGEST_TIME_MENU_ID,
  NOTIFICATION_SETTINGS_MENU_ID,
  NOTIFICATIONS_MENU_ID,
  settingsScreen,
  settingsUpdate,
  WEEKLY_DIGEST_MENU_ID,
  weekdayLabel,
} from "./shared.js";

export function buildNotificationsMenu(config: BackendConfig, backendDb: BackendDb, bot: Bot | null): Menu<Context> {
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
        `${settings.videoRemindersEnabled ? "✅" : "◻️"} ${t(locale, "settings.video-reminder-label")}`,
        settingsUpdate({ apply: () => setNotifications({ videoRemindersEnabled: !settings.videoRemindersEnabled }), body }),
      )
      .text(
        `${settings.postRemindersEnabled ? "✅" : "◻️"} ${t(locale, "settings.post-reminder-label")}`,
        settingsUpdate({ apply: () => setNotifications({ postRemindersEnabled: !settings.postRemindersEnabled }), body }),
      )
      .row()
      .text(
        `${settings.completionEnabled ? "✅" : "◻️"} ${t(locale, "settings.completion-label")}`,
        settingsUpdate({ apply: () => setNotifications({ completionEnabled: !settings.completionEnabled }), body }),
      )
      .row();
    for (const minutes of [1, 5, 10, 15, 30] as const)
      range.text(
        String(minutes),
        settingsUpdate({
          apply: () => setNotifications({ reminderMinutes: minutes }),
          body,
          toast: t(locale, "settings.minutes-toast", { minutes }),
        }),
      );
    range.row().back(
      t(locale, "settings.back-to-notifications"),
      settingsScreen(() => t(locale, "settings.category-notifications-body"), true),
    );
  });

  const weeklyDigest = new Menu<Context>(WEEKLY_DIGEST_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const settings = createStudioServices(backendDb, config).settings.weeklyDigest();
    const locale = settingsService(backendDb).locale(actorId);
    range;
    const body = () => weeklyDigestText(backendDb, config, locale);
    range
      .text(
        `${settings.enabled ? "✅" : "◻️"} ${t(locale, "settings.weekly-digest-enabled")}`,
        settingsUpdate({
          apply: () => createStudioServices(backendDb, config).settings.setWeeklyDigest({ enabled: !settings.enabled }),
          body,
        }),
      )
      .row();
    for (const weekday of [1, 2, 3, 4, 5, 6, 0] as const) {
      range.text(
        `${settings.weekday === weekday ? "● " : ""}${weekdayLabel(locale, weekday)}`,
        settingsUpdate({
          apply: () => createStudioServices(backendDb, config).settings.setWeeklyDigest({ weekday }),
          body,
          toast: t(locale, "settings.weekly-digest-day-set", { day: weekdayLabel(locale, weekday) }),
        }),
      );
      if (weekday === 4) range.row();
    }
    range.row().back(
      t(locale, "settings.back-to-notifications"),
      settingsScreen(() => t(locale, "settings.category-notifications-body"), true),
    );
  });

  const backup = new Menu<Context>(BACKUP_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));

    const settings = createStudioServices(backendDb, config).settings.backup();
    range
      .text(
        `${settings.enabled ? "✅" : "◻️"} ${t(locale, "settings.backup-enabled")}`,
        settingsUpdate({
          apply: () => createStudioServices(backendDb, config).settings.setBackup({ enabled: !settings.enabled }),
          body: () => backupText(backendDb, config, locale),
        }),
      )
      .row()
      .back(
        t(locale, "settings.back-to-notifications"),
        settingsScreen(() => t(locale, "settings.category-notifications-body"), true),
      );
  });

  const newsDigestTime = new Menu<Context>(NEWS_DIGEST_TIME_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    const settings = createStudioServices(backendDb, config).settings.newsDigest();
    for (let hour = 0; hour < 24; hour += 1) {
      range.text(
        `${settings.hour === hour && settings.minute === 0 ? "● " : ""}${formatTime(hour, 0)}`,
        settingsUpdate({
          apply: () => createStudioServices(backendDb, config).settings.setNewsDigest({ hour, minute: 0 }),
          body: () => newsDigestTimeText(backendDb, config, actorId, locale),
          toast: t(locale, "settings.news-digest-time-set", { time: formatTime(hour, 0) }),
        }),
      );
      if (hour % 4 === 3) range.row();
    }
    range
      .text(t(locale, "settings.news-digest-time-custom"), async (ctx) => {
        beginSettingsInput(backendDb, actorId, "news_digest_time");
        await ctx.answerCallbackQuery();
        await ctx.reply(t(locale, "settings.news-digest-time-input-prompt"));
      })
      .row()
      .back(
        t(locale, "settings.back-to-news-digest"),
        settingsUpdate({
          apply: () => clearConversationState(backendDb, actorId, "settings"),
          body: () => newsDigestText(backendDb, config, locale),
        }),
      );
  });

  const newsDigest = new Menu<Context>(NEWS_DIGEST_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    const settings = createStudioServices(backendDb, config).settings.newsDigest();
    range
      .text(
        `${settings.enabled ? "✅" : "◻️"} ${t(locale, "settings.news-digest-enabled")}`,
        settingsUpdate({
          apply: () => createStudioServices(backendDb, config).settings.setNewsDigest({ enabled: !settings.enabled }),
          body: () => newsDigestText(backendDb, config, locale),
        }),
      )
      .row()
      .submenu(
        `${t(locale, "settings.news-digest-time")}: ${formatTime(settings.hour, settings.minute)}`,
        NEWS_DIGEST_TIME_MENU_ID,
        settingsScreen(() => newsDigestTimeText(backendDb, config, actorId, locale)),
      )
      .row();
    for (const effort of NEWS_DIGEST_EFFORTS)
      range.text(
        `${settings.effort === effort ? "● " : ""}${effort}`,
        settingsUpdate({
          apply: () => createStudioServices(backendDb, config).settings.setNewsDigest({ effort }),
          body: () => newsDigestText(backendDb, config, locale),
          toast: t(locale, "settings.news-digest-effort-set", { effort }),
        }),
      );
    range
      .row()
      .text(t(locale, "settings.news-digest-prompt-edit"), async (ctx) => {
        beginSettingsInput(backendDb, actorId, "news_digest_prompt");
        await ctx.answerCallbackQuery();
        await ctx.reply(t(locale, "settings.news-digest-prompt-input"));
      })
      .row()
      .text(t(locale, "settings.news-digest-send-now"), async (ctx) => {
        if (!bot) {
          await ctx.answerCallbackQuery({ text: t(locale, "settings.news-digest-unavailable"), show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({ text: t(locale, "settings.news-digest-send-started") });
        const result = await sendDailyNewsDigest(config, backendDb, bot, new Date(), { force: true });
        if (result.status === "failed") await ctx.reply(t(locale, "settings.news-digest-send-failed", { error: result.error }));
        else if (result.status === "missing_prompt") await ctx.reply(t(locale, "settings.news-digest-prompt-missing"));
        else if (result.status === "already_sent") await ctx.reply(t(locale, "settings.news-digest-already-sent"));
      })
      .row()
      .back(
        t(locale, "settings.back-to-notifications"),
        settingsUpdate({
          apply: () => clearConversationState(backendDb, actorId, "settings"),
          body: () => t(locale, "settings.category-notifications-body"),
          plainText: true,
        }),
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
      .submenu(
        t(locale, "settings.weekly-digest"),
        WEEKLY_DIGEST_MENU_ID,
        settingsScreen(() => weeklyDigestText(backendDb, config, locale)),
      )
      .row()
      .submenu(
        t(locale, "settings.news-digest"),
        NEWS_DIGEST_MENU_ID,
        settingsScreen(() => newsDigestText(backendDb, config, locale)),
      )
      .row()
      .submenu(
        t(locale, "settings.backup"),
        BACKUP_MENU_ID,
        settingsScreen(() => backupText(backendDb, config, locale)),
      )
      .row()
      .back(t(locale, "settings.back-to-settings"), backToSettings(backendDb));
  });
  notifications.register(notificationSettings);
  notifications.register(weeklyDigest);
  notifications.register(backup);
  notifications.register(newsDigest);
  newsDigest.register(newsDigestTime);
  return notifications;
}

export async function collectNewsDigestPrompt(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  try {
    createStudioServices(backendDb, config).settings.setNewsDigest({ prompt: text === "-" ? "" : text });
    await ctx.reply(t(locale, "settings.news-digest-prompt-saved"));
    await ctx.reply(newsDigestText(backendDb, config, locale), {
      parse_mode: "Markdown",
      reply_markup: settingsMenu.at(NEWS_DIGEST_MENU_ID),
    });
  } catch (error) {
    await ctx.reply(describeError(locale, error));
  }
  return true;
}

export async function collectNewsDigestTime(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  const match = /^(\d{1,2}):(\d{2})$/u.exec(text);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    await ctx.reply(t(locale, "err.news-digest-time-invalid"));
    return true;
  }
  createStudioServices(backendDb, config).settings.setNewsDigest({ hour, minute });
  await ctx.reply(t(locale, "settings.news-digest-time-set", { time: formatTime(hour, minute) }));
  await ctx.reply(newsDigestTimeText(backendDb, config, actorId, locale), {
    parse_mode: "Markdown",
    reply_markup: settingsMenu.at(NEWS_DIGEST_TIME_MENU_ID),
  });
  return true;
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

function weeklyDigestText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  const settings = createStudioServices(backendDb, config).settings.weeklyDigest();
  return t(locale, "settings.weekly-digest-body", {
    status: settings.enabled ? t(locale, "settings.on") : t(locale, "settings.off"),
    day: weekdayLabel(locale, settings.weekday),
  });
}

function backupText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  return t(locale, "settings.backup-body", {
    status: createStudioServices(backendDb, config).settings.backup().enabled ? t(locale, "settings.on") : t(locale, "settings.off"),
  });
}

function newsDigestText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  const services = createStudioServices(backendDb, config);
  const settings = services.settings.newsDigest();
  return t(locale, "settings.news-digest-body", {
    status: settings.enabled ? t(locale, "settings.on") : t(locale, "settings.off"),
    time: formatTime(settings.hour, settings.minute),
    // The Studio's zone, because that is the one the digest fires in. Printing
    // this operator's personal zone made the screen promise a different hour
    // than the schedule keeps.
    timezone: config.TIMEZONE_LABEL,
    effort: settings.effort,
    prompt: settings.prompt ? t(locale, "settings.news-digest-prompt-set") : t(locale, "settings.news-digest-prompt-missing"),
  });
}

function newsDigestTimeText(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: StudioLocale): string {
  const services = createStudioServices(backendDb, config);
  const settings = services.settings.newsDigest();
  return t(locale, "settings.news-digest-time-body", {
    time: formatTime(settings.hour, settings.minute),
    timezone: services.settings.timeConfig(actorId, config).TIMEZONE_LABEL,
  });
}
