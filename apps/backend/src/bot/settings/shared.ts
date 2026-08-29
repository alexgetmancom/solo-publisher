import type { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { BackendDb } from "../../db/client.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { settingsService } from "../../studio/services/settings.js";
import { clearConversationState, saveConversationState } from "../conversation-state.js";

export const SETTINGS_MENU_ID = "settings-menu";
export const PUBLISHING_MENU_ID = "settings-publishing";
export const NOTIFICATIONS_MENU_ID = "settings-notifications-category";
export const SYSTEM_MENU_ID = "settings-system";
export const NOTIFICATION_SETTINGS_MENU_ID = "settings-notifications";
export const WEEKLY_DIGEST_MENU_ID = "settings-weekly-digest";
export const BACKUP_MENU_ID = "settings-backup";
export const MILESTONES_MENU_ID = "settings-milestones";
export const NEWS_DIGEST_MENU_ID = "settings-news-digest";
export const NEWS_DIGEST_TIME_MENU_ID = "settings-news-digest-time";
export const DEFAULT_TARGETS_MENU_ID = "settings-default-targets";
export const YOUTUBE_SIGNATURE_MENU_ID = "settings-youtube";
export const LANGUAGE_MENU_ID = "settings-language";
export const CHANNELS_MENU_ID = "settings-channels";
export const CHANNEL_MENU_ID = "settings-channel";
export const CHANNEL_DISABLE_MENU_ID = "settings-channel-disable";
export const CHANNEL_CONNECT_MENU_ID = "settings-channel-connect";
export const TIMEZONE_MENU_ID = "settings-timezone";
export const THREADS_FOLLOWERS_MENU_ID = "settings-threads-followers";
export const X_IMPORT_MENU_ID = "settings-x-import";

export type SettingsInputStep =
  | "timezone"
  | "news_digest_prompt"
  | "news_digest_time"
  | "milestone_threshold"
  | "threads_followers"
  | "x_import"
  | "youtube_signature";

export function beginSettingsInput(
  backendDb: BackendDb,
  actorId: number,
  step: SettingsInputStep,
  data: Record<string, unknown> = {},
): void {
  saveConversationState(backendDb, actorId, { kind: "settings", draftId: null, step, data, controlMessageId: null });
}

/** Asks for one typed settings value on the screen the question was tapped on,
 * keeping that screen's own menu under it.
 *
 * Every settings question used to arrive as a new message, leaving the screen
 * that asked it above -- the same split the publication flows had. */
export async function askSettingsInput(
  ctx: Context,
  backendDb: BackendDb,
  actorId: number,
  step: SettingsInputStep,
  menu: Menu<Context>,
  text: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  beginSettingsInput(backendDb, actorId, step, data);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, { reply_markup: menu });
}

/** Every category returns to the same root screen, and a `.back()` that leaves
 * the previous screen's body text on the message reads as a failed tap. */
export function backToSettings(backendDb: BackendDb) {
  return async (ctx: Context): Promise<void> => {
    clearConversationState(backendDb, Number(ctx.from?.id), "settings");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t(settingsService(backendDb).locale(Number(ctx.from?.id)), "settings.title"));
  };
}

/** One tapped settings control: apply the change, acknowledge the tap, and
 * re-render the screen it lives on. Every toggle, preset and picker in settings
 * does exactly this, and spelling it out per button is how one of them ends up
 * without its answerCallbackQuery -- these menus do not auto-answer. */
/** One vocabulary for the state of a control, because the screens had three.
 * A switch was ✅/◻️ here and ✓/□ there, a chosen option carried a leading ●
 * on one screen and nothing at all on another -- the reminder row printed bare
 * numbers, so the setting in force could not be read off the keyboard. */
export function switchLabel(on: boolean, label: string): string {
  return `${on ? "✅" : "⬜"} ${label}`;
}

export function choiceLabel(chosen: boolean, label: string): string {
  return `${chosen ? "●" : "○"} ${label}`;
}

export function settingsUpdate(options: {
  apply: () => void;
  body: () => string;
  toast?: string;
  /** Screens whose text is assembled from channel and account names, which are
   * not written as Markdown and must not be parsed as it. */
  plainText?: true;
}) {
  return async (ctx: Context): Promise<void> => {
    options.apply();
    await ctx.answerCallbackQuery(options.toast ? { text: options.toast } : undefined);
    await ctx.editMessageText(options.body(), options.plainText ? undefined : { parse_mode: "Markdown" });
  };
}

/** The same, for a control that only navigates: no change to apply. */
export function settingsScreen(body: () => string, plainText?: true) {
  return settingsUpdate({ apply: () => undefined, body, ...(plainText ? { plainText } : {}) });
}

export function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function weekdayLabel(locale: StudioLocale, weekday: number): string {
  const labels = locale === "ru" ? ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return labels[weekday] ?? labels[0] ?? "";
}

/** Settings input sits in front of the router and claims the next message.
 * Commands and persistent keyboard navigation must leave that input instead. */
export function isNavigationMessage(text: string): boolean {
  return text.startsWith("/") || text === t("en", "menu.button") || text === t("ru", "menu.button");
}
