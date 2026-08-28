import { Menu } from "@grammyjs/menu";
import type { Bot, Context } from "grammy";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { settingsService } from "../../studio/services/settings.js";
import { clearConversationState, getConversationState } from "../conversation-state.js";
import { mainMenuText } from "../menu-render.js";
import { collectThreadsFollowers, collectXAnalyticsCsv } from "./analytics.js";

import { buildNotificationsMenu, collectMilestoneThreshold, collectNewsDigestPrompt, collectNewsDigestTime } from "./notifications.js";
import { buildPublishingMenu, collectYoutubeSignature } from "./publishing.js";
import { isNavigationMessage, NOTIFICATIONS_MENU_ID, PUBLISHING_MENU_ID, SETTINGS_MENU_ID, SYSTEM_MENU_ID } from "./shared.js";
import { buildSystemMenu, collectTimezone } from "./system.js";

export { SETTINGS_MENU_ID } from "./shared.js";

/** Settings is an interface screen: it owns its callbacks while the shared
 * durable conversation store owns which input the actor is answering. */
export async function handleSettingsMessage(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const actorId = Number(ctx.from?.id);
  const state = getConversationState(backendDb, actorId, "settings");
  if (!state) return false;
  const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
  if (isNavigationMessage(text)) {
    clearConversationState(backendDb, actorId, "settings");
    return false;
  }
  if (state.step === "x_import") return collectXAnalyticsCsv(ctx, backendDb, config, actorId, settingsMenu);
  clearConversationState(backendDb, actorId, "settings");
  if (state.step === "threads_followers")
    return collectThreadsFollowers(ctx, backendDb, actorId, text, settingsMenu, state.data.account === "en" ? "en" : "ru");
  if (state.step === "timezone") return collectTimezone(ctx, backendDb, config, actorId, text, settingsMenu);
  if (state.step === "news_digest_time") return collectNewsDigestTime(ctx, backendDb, config, actorId, text, settingsMenu);
  if (state.step === "news_digest_prompt") return collectNewsDigestPrompt(ctx, backendDb, config, actorId, text, settingsMenu);
  if (state.step === "milestone_threshold") return collectMilestoneThreshold(ctx, backendDb, config, actorId, text, settingsMenu);
  if (state.step !== "youtube_signature") return false;
  return collectYoutubeSignature(ctx, backendDb, config, actorId, text, settingsMenu);
}

export function buildSettingsMenu(config: BackendConfig, backendDb: BackendDb, bot: Bot | null = null): Menu<Context> {
  const publishing = buildPublishingMenu(config, backendDb);
  const notifications = buildNotificationsMenu(config, backendDb, bot);
  const system = buildSystemMenu(config, backendDb);

  const settings = new Menu<Context>(SETTINGS_MENU_ID, { autoAnswer: false });
  settings.dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    range
      .submenu(t(locale, "settings.category-publishing"), PUBLISHING_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.category-publishing-body"));
      })
      .submenu(t(locale, "settings.category-notifications"), NOTIFICATIONS_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.category-notifications-body"));
      })
      .row()
      .submenu(t(locale, "settings.category-system"), SYSTEM_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.category-system-body"));
      })
      .row()
      .back(t(locale, "common.menu"), async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(mainMenuText(backendDb, config, Number(ctx.from?.id)));
      });
  });
  settings.register(publishing);
  settings.register(notifications);
  settings.register(system);
  return settings;
}

export async function showSettings(ctx: Context, backendDb: BackendDb, settingsMenu: Menu<Context>, edit = false): Promise<void> {
  const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
  const text = t(locale, "settings.title");
  const options = { reply_markup: settingsMenu };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}
