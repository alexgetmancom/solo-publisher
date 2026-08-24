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
  //
  // Text and video are unconditional, as they have been: a draft is written
  // before its channels are connected, and the targets inside are what a
  // connection turns on. A stream is not like that. It is not a draft this
  // Studio holds, it is a thing happening on a YouTube account right now, so a
  // Studio with no YouTube account has no screen to open -- only credentials to
  // fail to refresh, which is what this button did on Alex.
  menu.dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    range
      .text(t(locale, "menu.text"), (ctx) => openIntake(ctx, backendDb, "text", "edit"))
      .text(t(locale, "menu.video"), (ctx) => openIntake(ctx, backendDb, "video", "edit"));
    if (createStudioServices(backendDb, config).streams.channels().length)
      range.text(t(locale, "menu.streams"), (ctx) => showStreamScreen(ctx, backendDb, config, "edit"));
  });
  menu.row();
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
