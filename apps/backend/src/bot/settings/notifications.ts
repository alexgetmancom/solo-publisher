import { Menu } from "@grammyjs/menu";
import type { Bot, Context } from "grammy";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { describeError, t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { sendDailyNewsDigest } from "../../interfaces/telegram/news-digest.js";
import { createStudioServices } from "../../studio/services/index.js";
import { NEWS_DIGEST_EFFORTS, settingsService } from "../../studio/services/settings.js";
import { DEFAULT_MILESTONE_THRESHOLDS } from "../../studio.js";
import { clearConversationState } from "../conversation-state.js";
import { showMessage, showScreen } from "../effects.js";
import {
  askSettingsInput,
  BACKUP_MENU_ID,
  backToSettings,
  choiceLabel,
  formatTime,
  MILESTONES_MENU_ID,
  NEWS_DIGEST_MENU_ID,
  NEWS_DIGEST_TIME_MENU_ID,
  NOTIFICATION_SETTINGS_MENU_ID,
  NOTIFICATIONS_MENU_ID,
  settingsScreen,
  settingsUpdate,
  switchLabel,
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

  const weeklyDigest = new Menu<Context>(WEEKLY_DIGEST_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const settings = createStudioServices(backendDb, config).settings.weeklyDigest();
    const locale = settingsService(backendDb).locale(actorId);
    range;
    const body = () => weeklyDigestText(backendDb, config, locale);
    range
      .text(
        switchLabel(settings.enabled, t(locale, "settings.weekly-digest-enabled")),
        settingsUpdate({
          apply: () => createStudioServices(backendDb, config).settings.setWeeklyDigest({ enabled: !settings.enabled }),
          body,
        }),
      )
      .row();
    for (const weekday of [1, 2, 3, 4, 5, 6, 0] as const) {
      range.text(
        choiceLabel(settings.weekday === weekday, weekdayLabel(locale, weekday)),
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

  const newsDigestTime = new Menu<Context>(NEWS_DIGEST_TIME_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    const settings = createStudioServices(backendDb, config).settings.newsDigest();
    for (let hour = 0; hour < 24; hour += 1) {
      range.text(
        choiceLabel(settings.hour === hour && settings.minute === 0, formatTime(hour, 0)),
        settingsUpdate({
          apply: () => createStudioServices(backendDb, config).settings.setNewsDigest({ hour, minute: 0 }),
          body: () => newsDigestTimeText(backendDb, config, actorId, locale),
          toast: t(locale, "settings.news-digest-time-set", { time: formatTime(hour, 0) }),
        }),
      );
      if (hour % 4 === 3) range.row();
    }
    range
      .text(t(locale, "settings.news-digest-time-custom"), (ctx) =>
        askSettingsInput(ctx, backendDb, actorId, "news_digest_time", newsDigestTime, t(locale, "settings.news-digest-time-input-prompt")),
      )
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
        switchLabel(settings.enabled, t(locale, "settings.news-digest-enabled")),
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
        choiceLabel(settings.effort === effort, effort),
        settingsUpdate({
          apply: () => createStudioServices(backendDb, config).settings.setNewsDigest({ effort }),
          body: () => newsDigestText(backendDb, config, locale),
          toast: t(locale, "settings.news-digest-effort-set", { effort }),
        }),
      );
    range
      .row()
      .text(t(locale, "settings.news-digest-prompt-edit"), (ctx) =>
        askSettingsInput(ctx, backendDb, actorId, "news_digest_prompt", newsDigest, t(locale, "settings.news-digest-prompt-input")),
      )
      .row()
      .text(t(locale, "settings.news-digest-send-now"), async (ctx) => {
        if (!bot) {
          await ctx.answerCallbackQuery({ text: t(locale, "settings.news-digest-unavailable"), show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({ text: t(locale, "settings.news-digest-send-started") });
        const result = await sendDailyNewsDigest(config, backendDb, bot, new Date(), { force: true });
        if (result.status === "failed") await showMessage(ctx, t(locale, "settings.news-digest-send-failed", { error: result.error }));
        else if (result.status === "missing_prompt") await showMessage(ctx, t(locale, "settings.news-digest-prompt-missing"));
        else if (result.status === "already_sent") await showMessage(ctx, t(locale, "settings.news-digest-already-sent"));
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

  const milestones = new Menu<Context>(MILESTONES_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    const settings = createStudioServices(backendDb, config).settings.milestones();
    const body = () => milestonesText(backendDb, config, locale);
    const setMilestones = (input: Parameters<ReturnType<typeof settingsService>["setMilestones"]>[0]) =>
      createStudioServices(backendDb, config).settings.setMilestones(input);
    range
      .text(
        switchLabel(settings.channelEnabled, t(locale, "settings.milestones-channel")),
        settingsUpdate({ apply: () => setMilestones({ channelEnabled: !settings.channelEnabled }), body }),
      )
      .row()
      .text(
        switchLabel(settings.groupLocaleEnabled, t(locale, "settings.milestones-group-locale")),
        settingsUpdate({ apply: () => setMilestones({ groupLocaleEnabled: !settings.groupLocaleEnabled }), body }),
      )
      .row()
      .text(
        switchLabel(settings.localeEnabled, t(locale, "settings.milestones-locale")),
        settingsUpdate({ apply: () => setMilestones({ localeEnabled: !settings.localeEnabled }), body }),
      )
      .row()
      .text(
        switchLabel(settings.projectEnabled, t(locale, "settings.milestones-project")),
        settingsUpdate({ apply: () => setMilestones({ projectEnabled: !settings.projectEnabled }), body }),
      )
      .row();
    // The ladder plus whatever this Studio added itself: one list, so a custom
    // count is switched off exactly where a default one is.
    for (const [index, threshold] of thresholdCatalogue(settings.thresholds).entries()) {
      const on = settings.thresholds.includes(threshold);
      range.text(
        switchLabel(on, formatThreshold(threshold)),
        settingsUpdate({
          apply: () => setMilestones({ thresholds: toggleThreshold(settings.thresholds, threshold) }),
          body,
          toast: t(locale, "settings.milestones-threshold-toast", {
            threshold: formatThreshold(threshold),
            status: on ? t(locale, "settings.off") : t(locale, "settings.on"),
          }),
        }),
      );
      if (index % 3 === 2) range.row();
    }
    range
      .row()
      .text(t(locale, "settings.milestones-custom"), (ctx) =>
        askSettingsInput(ctx, backendDb, actorId, "milestone_threshold", milestones, t(locale, "settings.milestones-custom-input")),
      )
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
      .submenu(
        t(locale, "settings.milestones"),
        MILESTONES_MENU_ID,
        settingsScreen(() => milestonesText(backendDb, config, locale)),
      )
      .row()
      .back(t(locale, "settings.back-to-settings"), backToSettings(backendDb));
  });
  notifications.register(notificationSettings);
  notifications.register(weeklyDigest);
  notifications.register(newsDigest);
  notifications.register(milestones);
  newsDigest.register(newsDigestTime);
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
    await showScreen(ctx, t(locale, "settings.news-digest-prompt-saved"));
    await showScreen(ctx, newsDigestText(backendDb, config, locale), {
      parse_mode: "Markdown",
      reply_markup: settingsMenu.at(NEWS_DIGEST_MENU_ID),
    });
  } catch (error) {
    await showScreen(ctx, describeError(locale, error));
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
    await showScreen(ctx, t(locale, "err.news-digest-time-invalid"));
    return true;
  }
  createStudioServices(backendDb, config).settings.setNewsDigest({ hour, minute });
  await showScreen(ctx, t(locale, "settings.news-digest-time-set", { time: formatTime(hour, minute) }));
  await showScreen(ctx, newsDigestTimeText(backendDb, config, actorId, locale), {
    parse_mode: "Markdown",
    reply_markup: settingsMenu.at(NEWS_DIGEST_TIME_MENU_ID),
  });
  return true;
}

/** The default ladder plus every count this Studio added, ascending. A count
 * switched off has to stay on the screen, or there is no way to switch it on. */
function thresholdCatalogue(selected: readonly number[]): number[] {
  return [...new Set([...DEFAULT_MILESTONE_THRESHOLDS, ...selected])].sort((left, right) => left - right);
}

function toggleThreshold(selected: readonly number[], threshold: number): number[] {
  return selected.includes(threshold) ? selected.filter((value) => value !== threshold) : [...selected, threshold];
}

function formatThreshold(threshold: number): string {
  return threshold >= 1000 && threshold % 1000 === 0 ? `${threshold / 1000}k` : String(threshold);
}

function milestonesText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  const settings = createStudioServices(backendDb, config).settings.milestones();
  const on = (value: boolean) => (value ? t(locale, "settings.on") : t(locale, "settings.off"));
  return t(locale, "settings.milestones-body", {
    channel: on(settings.channelEnabled),
    groupLocale: on(settings.groupLocaleEnabled),
    locale: on(settings.localeEnabled),
    project: on(settings.projectEnabled),
    thresholds: settings.thresholds.length ? settings.thresholds.map(formatThreshold).join(" · ") : t(locale, "settings.milestones-none"),
  });
}

/** One count, added or removed: the same message does both, because a list the
 * operator edits by hand needs no second command to undo a typo. */
export async function collectMilestoneThreshold(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  const threshold = Number(text.replace(/[\s_,]/gu, ""));
  const services = createStudioServices(backendDb, config);
  const current = services.settings.milestones().thresholds;
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    await showScreen(ctx, describeError(locale, new StudioError("err.milestone-threshold-range")));
    return true;
  }
  const removing = current.includes(threshold);
  services.settings.setMilestones({ thresholds: toggleThreshold(current, threshold) });
  await showScreen(ctx, t(locale, removing ? "settings.milestones-custom-removed" : "settings.milestones-custom-added", { threshold }));
  await showScreen(ctx, milestonesText(backendDb, config, locale), {
    parse_mode: "Markdown",
    reply_markup: settingsMenu.at(MILESTONES_MENU_ID),
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

export function backupText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
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
