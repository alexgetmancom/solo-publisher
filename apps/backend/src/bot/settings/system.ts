import { Menu, type MenuFlavor } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { STUDIO_LOCALE_NAMES, STUDIO_LOCALES, type StudioLocale } from "../../foundation/locale.js";
import { createStudioServices } from "../../studio/services/index.js";
import { settingsService } from "../../studio/services/settings.js";
import { clearConversationState } from "../conversation-state.js";
import { persistentKeyboard } from "../menu-render.js";
import { buildAnalyticsMenus, threadsFollowersText } from "./analytics.js";
import { backupText, buildBackupMenu } from "./notifications.js";
import {
  BACKUP_MENU_ID,
  backToSettings,
  beginSettingsInput,
  choiceLabel,
  LANGUAGE_MENU_ID,
  SETTINGS_MENU_ID,
  SYSTEM_MENU_ID,
  settingsScreen,
  settingsUpdate,
  THREADS_FOLLOWERS_MENU_ID,
  TIMEZONE_MENU_ID,
  X_IMPORT_MENU_ID,
} from "./shared.js";

const TIMEZONE_OPTIONS = [
  ["UTC", "UTC"],
  ["Europe/London", "Europe/London"],
  ["Europe/Berlin", "Europe/Berlin"],
  ["Europe/Moscow", "Europe/Moscow"],
  ["Asia/Dubai", "Asia/Dubai"],
  ["Asia/Tashkent", "Asia/Tashkent"],
  ["Asia/Kolkata", "Asia/Kolkata"],
  ["Asia/Bangkok", "Asia/Bangkok"],
  ["Asia/Singapore", "Asia/Singapore"],
  ["Asia/Tokyo", "Asia/Tokyo"],
  ["Australia/Sydney", "Australia/Sydney"],
  ["America/New_York", "America/New_York"],
  ["America/Chicago", "America/Chicago"],
  ["America/Denver", "America/Denver"],
  ["America/Los_Angeles", "America/Los_Angeles"],
] as const;

/** Everything that is about this machine rather than about a publication: the
 * clock it keeps, the language it speaks, the copy it takes of itself, and the
 * numbers no platform API will give us. Time zone and language used to be a
 * category of two, and the analytics pair a category of two more. */
export function buildSystemMenu(config: BackendConfig, backendDb: BackendDb): Menu<Context> {
  const language = new Menu<Context>(LANGUAGE_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    for (const target of STUDIO_LOCALES) range.text(STUDIO_LOCALE_NAMES[target], (ctx) => switchLanguage(ctx, target));
    range.row().back(
      t(locale, "settings.back-to-system"),
      settingsScreen(() => t(locale, "settings.category-system-body"), true),
    );
  });

  const timezone = new Menu<Context>(TIMEZONE_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    const service = createStudioServices(backendDb, config).settings;
    const current = service.timezone(actorId, config.TIMEZONE);
    const options = TIMEZONE_OPTIONS.some(([zone]) => zone === current) ? TIMEZONE_OPTIONS : [[current, current], ...TIMEZONE_OPTIONS];
    for (let index = 0; index < options.length; index += 2) {
      for (const [zone, label] of options.slice(index, index + 2))
        range.text(
          choiceLabel(zone === current, label),
          settingsUpdate({
            apply: () => service.setTimezone(actorId, zone),
            body: () => timezoneText(backendDb, config, actorId, locale),
            toast: t(locale, "settings.timezone-set", { timezone: zone }),
          }),
        );
      if (index + 2 < options.length) range.row();
    }
    range.row().text(t(locale, "settings.timezone-custom"), async (ctx) => {
      beginSettingsInput(backendDb, actorId, "timezone");
      await ctx.answerCallbackQuery();
      await ctx.reply(t(locale, "settings.timezone-input-prompt"));
    });
    range.row().back(
      t(locale, "settings.back-to-system"),
      settingsUpdate({
        apply: () => clearConversationState(backendDb, actorId, "settings"),
        body: () => t(locale, "settings.category-system-body"),
        plainText: true,
      }),
    );
  });

  const system = new Menu<Context>(SYSTEM_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .submenu(
        t(locale, "settings.timezone"),
        TIMEZONE_MENU_ID,
        settingsScreen(() => timezoneText(backendDb, config, actorId, locale)),
      )
      .submenu(
        t(locale, "settings.language"),
        LANGUAGE_MENU_ID,
        settingsScreen(() => t(locale, "settings.language-title"), true),
      )
      .row()
      .submenu(
        t(locale, "settings.backup"),
        BACKUP_MENU_ID,
        settingsScreen(() => backupText(backendDb, config, locale)),
      )
      .submenu(
        t(locale, "settings.threads-followers"),
        THREADS_FOLLOWERS_MENU_ID,
        settingsScreen(() => threadsFollowersText(backendDb, locale)),
      )
      .row()
      .submenu(
        t(locale, "settings.x-import"),
        X_IMPORT_MENU_ID,
        settingsScreen(() => t(locale, "settings.x-import-body")),
      )
      .row()
      .back(t(locale, "settings.back-to-settings"), backToSettings(backendDb));
  });
  system.register(language);
  system.register(timezone);
  system.register(buildBackupMenu(config, backendDb));
  for (const menu of buildAnalyticsMenus(backendDb, (actorLocale) => t(actorLocale, "settings.category-system-body")))
    system.register(menu);
  return system;

  async function switchLanguage(ctx: Context & MenuFlavor, locale: StudioLocale): Promise<void> {
    const actorId = Number(ctx.from?.id);
    createStudioServices(backendDb, config).settings.setLocale(actorId, locale);
    await ctx.answerCallbackQuery({ text: t(locale, "settings.language-set") });
    ctx.menu.nav(SETTINGS_MENU_ID);
    await ctx.editMessageText(t(locale, "settings.title"));
    await ctx.reply(t(locale, "settings.keyboard-updated"), { reply_markup: persistentKeyboard(locale) });
  }
}

export async function collectTimezone(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  try {
    createStudioServices(backendDb, config).settings.setTimezone(actorId, text);
    await ctx.reply(t(locale, "settings.timezone-set", { timezone: text }));
    await ctx.reply(timezoneText(backendDb, config, actorId, locale), {
      parse_mode: "Markdown",
      reply_markup: settingsMenu.at(TIMEZONE_MENU_ID),
    });
  } catch {
    await ctx.reply(t(locale, "err.timezone-invalid"));
  }
  return true;
}

function timezoneText(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: StudioLocale): string {
  const current = createStudioServices(backendDb, config).settings.timezone(actorId, config.TIMEZONE);
  return t(locale, "settings.timezone-body", { timezone: current });
}
