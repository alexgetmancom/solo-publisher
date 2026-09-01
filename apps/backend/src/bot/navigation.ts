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
import { showStreamScreen } from "./stream-screen.js";

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
    // a button that is not there. The shape depends on the streams button and
    // nothing else; the locale is in for the same reason it is in every label.
    fingerprint: (ctx) =>
      `${settingsService(backendDb).locale(Number(ctx.from?.id))}:${createStudioServices(backendDb, config).streams.connected()}`,
  });
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
      .text(t(locale, "menu.text"), (ctx) => openIntake(ctx, backendDb, "text"))
      .text(t(locale, "menu.video"), (ctx) => openIntake(ctx, backendDb, "video"));
    if (createStudioServices(backendDb, config).streams.connected())
      range.text(t(locale, "menu.streams"), (ctx) => showStreamScreen(ctx, backendDb, config));
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
