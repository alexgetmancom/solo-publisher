import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { showAnalyticsDashboard } from "./analytics-screen.js";
import { openIntake } from "./intake.js";
import { showQueue } from "./queue.js";
import { SETTINGS_MENU_ID } from "./settings/index.js";
import { showStreamScreen } from "./stream-screen.js";

const MAIN_MENU_ID = "main-menu";

export function buildMainMenu(config: BackendConfig, backendDb: BackendDb, settingsMenu: Menu<Context>): Menu<Context> {
  const menu = new Menu<Context>(MAIN_MENU_ID);
  // Three entities, three ways in: a text publication, a video publication and
  // the stream that is running right now. They share no step and no card, and
  // one entry point that asked which of them this was made the operator answer
  // a question they had already answered by choosing the button.
  menu
    .text(
      (ctx) => t(settingsService(backendDb).locale(Number(ctx.from?.id)), "menu.text"),
      (ctx) => openIntake(ctx, backendDb, "text", "edit"),
    )
    .text(
      (ctx) => t(settingsService(backendDb).locale(Number(ctx.from?.id)), "menu.video"),
      (ctx) => openIntake(ctx, backendDb, "video", "edit"),
    )
    .text(
      (ctx) => t(settingsService(backendDb).locale(Number(ctx.from?.id)), "menu.streams"),
      (ctx) => showStreamScreen(ctx, backendDb, config, "edit"),
    )
    .row();
  menu.text(
    (ctx) => {
      const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
      const { pending } = createStudioServices(backendDb, config).queue.headline(Number(ctx.from?.id));
      return pending ? t(locale, "menu.work-queue-count", { count: pending }) : t(locale, "menu.work-queue");
    },
    (ctx) => showQueue(ctx, backendDb, config),
  );
  menu.text(
    (ctx) => t(settingsService(backendDb).locale(Number(ctx.from?.id)), "menu.analytics"),
    (ctx) => showAnalyticsDashboard(ctx, backendDb, config, "overview", 1),
  );
  menu.submenu(
    (ctx) => t(settingsService(backendDb).locale(Number(ctx.from?.id)), "settings.title"),
    SETTINGS_MENU_ID,
    async (ctx) => {
      await ctx.editMessageText(t(settingsService(backendDb).locale(Number(ctx.from?.id)), "settings.title"));
    },
  );
  menu.register(settingsMenu);
  return menu;
}
