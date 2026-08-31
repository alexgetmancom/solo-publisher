import { autoRetry } from "@grammyjs/auto-retry";
import { sequentialize } from "@grammyjs/runner";
import { Bot, type Context } from "grammy";
import { installApiTiming, withTapMeasurement } from "./bot/api-timing.js";
import { acknowledgeCallback, runCallbackBoundary } from "./bot/callback-boundary.js";
import { handlePublicationCallback, handlePublicationMessage } from "./bot/callback-router.js";
import { executePublicationEffects, showMessage } from "./bot/effects.js";
import { handleIntakeMessage, openIntake } from "./bot/intake.js";
import { persistentKeyboard, showMainMenu } from "./bot/menu-render.js";
import { buildMainMenu } from "./bot/navigation.js";
import { parseSessionCallback } from "./bot/publication-callback.js";
import { parseScreenCallback } from "./bot/screen-callback.js";
import { SCREEN_ROUTES } from "./bot/screen-routes.js";
import { buildSettingsMenu, handleSettingsMessage, showSettings } from "./bot/settings/index.js";
import { handleStreamMessage, showStreamScreen } from "./bot/stream-screen.js";
import type { BackendDb } from "./db/client.js";
import { actorFromTelegramUser } from "./foundation/actors.js";
import type { BackendConfig } from "./foundation/config.js";
import { type MessageKey, t } from "./foundation/i18n/index.js";
import type { StudioLocale } from "./foundation/locale.js";
import { log } from "./foundation/logger.js";
import { trackUsageAsync } from "./observability/usage.js";
import { settingsService } from "./studio/services/settings.js";

export function createBot(config: BackendConfig, backendDb: BackendDb): Bot | null {
  if (!config.controllerBotToken) {
    log("warn", "Telegram bot token is not configured; bot is disabled");
    return null;
  }
  const bot = new Bot(config.controllerBotToken, { client: { apiRoot: config.TELEGRAM_API_BASE_URL } });
  // Telegram answers 429 with a `retry_after` whenever the admin taps through
  // screens quickly or a media upload hits a flood limit. Without this the
  // rejected call lands in `bot.catch` below and the admin's action is simply
  // lost. Internal server errors are left alone: retrying a 500 blindly can
  // send the same message twice.
  installApiTiming(bot);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30, rethrowInternalServerErrors: true }));
  bindBotHandlers(bot, config, backendDb);
  void bot.api
    .setMyCommands([{ command: "start", description: t("en", "bot.command-start") }])
    .then(() => log("info", "Telegram commands menu configured"))
    .catch((error) => log("error", "Failed to configure Telegram commands menu", { error: String(error) }));
  bot.catch((error) => log("error", "grammY handler failed", { error: String(error.error) }));
  return bot;
}

function bindBotHandlers(bot: Bot, config: BackendConfig, backendDb: BackendDb): void {
  const settingsMenu = buildSettingsMenu(config, backendDb, bot);
  const mainMenu = buildMainMenu(config, backendDb, settingsMenu);
  bot.use(async (ctx, next) => {
    const startedAt = Date.now();
    const updateType = Object.keys(ctx.update).find((key) => key !== "update_id") ?? "unknown";
    let success = false;
    let failure: unknown;
    try {
      const { measurement } = await withTapMeasurement(async () => {
        await trackUsageAsync(backendDb, "telegram.update.handle", next);
      });
      success = true;
      logUpdate(measurement.apiMs, measurement.apiCalls);
    } catch (error) {
      failure = error;
      logUpdate(0, 0);
      throw error;
    }
    function logUpdate(apiMs: number, apiCalls: number): void {
      const totalMs = Date.now() - startedAt;
      log(success ? "info" : "warn", "operation timing", {
        operation: "telegram.update.handle",
        updateId: ctx.update.update_id,
        updateType,
        success,
        apiMs: Math.round(apiMs),
        apiCalls,
        localMs: Math.round(totalMs - apiMs),
        totalMs,
        ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
      });
    }
  });
  // One gate for the whole bot. It has to sit in front of the menu plugin's own
  // callback_query:data middleware, or a non-admin's tap on a menu button would
  // be processed before ever reaching it; commands, text and albums pass the
  // same check, so no handler below repeats it.
  bot.use(async (ctx, next) => {
    if (isAdmin(config, ctx.from?.id)) return next();
    if (ctx.callbackQuery?.data !== undefined) await ctx.answerCallbackQuery();
  });
  // Answering is what stops the spinner, and it is the one part of a tap that
  // does not need to wait its turn. It goes out here, before sequentialize, so a
  // burst of taps stops producing a row of buttons that visibly hang.
  bot.use(async (ctx, next) => {
    acknowledgeCallback(ctx);
    await next();
  });
  // Everything after this point is serialised per chat, which is what the screen
  // anchor has always depended on: one update writes over the tapped message,
  // and anything after it must arrive below. Concurrency across chats is of no
  // use to a single-operator Studio -- the ordering is the point, not throughput.
  bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));
  bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery?.data) return next();
    await runCallbackBoundary(ctx, backendDb, next);
  });
  bot.use(mainMenu);

  const showBotMenu = async (ctx: Context) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    await showMessage(ctx, t(locale, "start.menu-hint"), { reply_markup: persistentKeyboard(locale) });
    await showMainMenu(ctx, backendDb, config, mainMenu);
  };
  bot.command("start", showBotMenu);
  bot.hears(localizedTextVariants(["menu.button"]), async (ctx) => {
    await showMainMenu(ctx, backendDb, config, mainMenu);
  });
  bot.hears("⚙️", async (ctx) => {
    await showSettings(ctx, backendDb, settingsMenu);
  });
  bot.hears(localizedTextVariants(["menu.text"]), async (ctx) => {
    await openIntake(ctx, backendDb, "text");
  });
  bot.hears(localizedTextVariants(["menu.video"]), async (ctx) => {
    await openIntake(ctx, backendDb, "video");
  });
  bot.hears(localizedTextVariants(["menu.streams"]), async (ctx) => {
    await showStreamScreen(ctx, backendDb, config);
  });
  bot.on("message", async (ctx) => {
    if (await handleSettingsMessage(ctx, backendDb, config, settingsMenu)) return;
    // The stream screen asked for one value and is waiting for exactly it.
    const stream = await handleStreamMessage(ctx, backendDb, config);
    if (stream.effects.length) await executePublicationEffects(ctx, backendDb, stream.effects);
    if (stream.handled) return;
    // The intake owns the first message only while it is still deciding what
    // that message is; anything it declines falls through unchanged.
    const intake = await handleIntakeMessage(ctx, backendDb, config);
    if (intake.effects.length) await executePublicationEffects(ctx, backendDb, intake.effects);
    if (intake.handled) return;
    await handlePublicationMessage(ctx, backendDb, config);
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    // Publication controls carry their own namespace and registry; everything
    // else is a declared screen. Nothing is matched by prefix any more, so
    // "analytics_post" can no longer swallow "analytics_post_archive", and a
    // tap that fits neither table is answered instead of left spinning.
    if (parseSessionCallback(data).callback) {
      await handlePublicationCallback(ctx, backendDb, config, mainMenu);
      return;
    }
    const callback = parseScreenCallback(data);
    const handled = callback
      ? await SCREEN_ROUTES[callback.id]({ ctx, backendDb, config, mainMenu, args: callback.args, callback })
      : false;
    if (handled) return;
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    await ctx.answerCallbackQuery({ text: t(locale, "action.unknown") });
  });
}

function localizedTextVariants(keys: readonly MessageKey[]): string[] {
  return [...new Set((["en", "ru"] as StudioLocale[]).flatMap((locale) => keys.map((key) => t(locale, key))))].filter(
    (value) => value.length > 0,
  );
}

/** Telegram-side gate: does this chat's user resolve to a Studio actor? The bot
 * asks the resolver rather than reading CONTROLLER_ADMIN_IDS itself, so the credential
 * mapping stays in one place as other interfaces are added. */
export function isAdmin(config: BackendConfig, userId: number | undefined): boolean {
  return actorFromTelegramUser(config, userId) !== null;
}
