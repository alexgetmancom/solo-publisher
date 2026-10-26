import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { showAnalyticsDashboard } from "./analytics-screen.js";
import { showScreen } from "./effects.js";
import { openIntake } from "./intake.js";
import { showQueue } from "./queue.js";
import { SETTINGS_MENU_ID } from "./settings/index.js";

const MAIN_MENU_ID = "main-menu";

export function buildMainMenu(config: BackendConfig, backendDb: BackendDb, settingsMenu: Menu<Context>): Menu<Context> {
  const menu = new Menu<Context>(MAIN_MENU_ID, {
    // The plugin hashes each button's own label into its callback data, and the
    // queue button here carries a live count: every publication that went out in
    // the background turned the operator's next tap on it into "Menu was
    // outdated, try again" -- two Bot API calls, no handler, and a tap to make
    // over. A fingerprint replaces that hash, so a label that moved on its own
    // no longer counts as a menu that moved.
    //
    // With a fingerprint the plugin stops range-checking the tapped position, so
    // this has to name everything the *shape* depends on or a stale tap reaches
    // a button that is not there. Only the locale changes this menu's labels.
    fingerprint: (ctx) => settingsService(backendDb).locale(Number(ctx.from?.id)),
  });
  // Text and video drafts can be prepared before their channels are connected.
  menu.dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    range
      .text(t(locale, "menu.text"), (ctx) => openIntake(ctx, backendDb, "text"))
      .text(t(locale, "menu.video"), (ctx) => openIntake(ctx, backendDb, "video"));
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
      await showScreen(ctx, t(settingsService(backendDb).locale(Number(ctx.from?.id)), "settings.title"));
    },
  );
  menu.register(settingsMenu);
  return menu;
}
