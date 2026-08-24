import type { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { clearTelegramAnalyticsDashboard } from "../interfaces/telegram/control-cards.js";
import { sendThreadsPreviews } from "../interfaces/telegram/delivery-previews.js";
import { settingsService } from "../studio/services/settings.js";
import {
  analyticsPeriod,
  analyticsSection,
  sendPostArchiveMedia,
  showAnalyticsDashboard,
  showArchiveHome,
  showMilestones,
  showPostArchive,
  showPostMetrics,
  showVideoArchive,
  showVideoMetrics,
} from "./analytics-screen.js";
import { runCallbackAction } from "./callback-effects.js";
import { resultNavigationKeyboard } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import { applyIntakeKind, applyIntakeVideoLocale, cancelIntake, publishReviewedArticle } from "./intake.js";
import { mainMenuText, showMainMenu } from "./menu-render.js";
import { handleOperationsCallback } from "./operations-screen.js";
import { showPostProgress } from "./progress-screen.js";
import { showQueue, showQueueAttention } from "./queue.js";
import { type ScreenCallback, type ScreenId, screenNumber } from "./screen-callback.js";

/** What every screen handler is handed: the bot's own dependencies, plus the
 * arguments this button declared. */
type ScreenContext = {
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  mainMenu: Menu<Context>;
  args: Record<string, string>;
  callback: ScreenCallback;
};

/** A screen handler answers the tap itself and returns whether it acted on it.
 * `false` means the data was well-formed but meaningless (an id that is gone,
 * a revision that is not one), and the dispatcher says so instead of leaving
 * the button spinning. */
type ScreenHandler = (screen: ScreenContext) => Promise<boolean>;

/** Every non-publication button in the bot, beside the screen it opens.
 *
 * The table is exhaustive by type: declaring a button in SCREEN_ARGUMENTS and
 * forgetting to route it does not compile, and routing one that is not declared
 * does not compile either. */
export const SCREEN_ROUTES: Record<ScreenId, ScreenHandler> = {
  noop: async ({ ctx }) => {
    await ctx.answerCallbackQuery();
    return true;
  },
  menu_home: async ({ ctx, backendDb, config, mainMenu }) => {
    clearTelegramAnalyticsDashboard(backendDb, Number(ctx.from?.id));
    await ctx.answerCallbackQuery();
    await showMainMenu(ctx, backendDb, config, mainMenu, true);
    return true;
  },
  queue_home: async ({ ctx, backendDb, config }) => {
    await ctx.answerCallbackQuery();
    await showQueue(ctx, backendDb, config);
    return true;
  },
  queue_page: async ({ ctx, backendDb, config, args }) => {
    const page = screenNumber(args.page);
    if (page == null) return false;
    await ctx.answerCallbackQuery();
    await showQueue(ctx, backendDb, config, page);
    return true;
  },
  queue_attention: async ({ ctx, backendDb, config }) => {
    await ctx.answerCallbackQuery();
    await showQueueAttention(ctx, backendDb, config);
    return true;
  },
  queue_attention_page: async ({ ctx, backendDb, config, args }) => {
    const page = screenNumber(args.page);
    if (page == null) return false;
    await ctx.answerCallbackQuery();
    await showQueueAttention(ctx, backendDb, config, page);
    return true;
  },
  analytics_home: async ({ ctx, backendDb, config }) => {
    await ctx.answerCallbackQuery();
    await showAnalyticsDashboard(ctx, backendDb, config, "overview", 7);
    return true;
  },
  analytics_section: async ({ ctx, backendDb, config, args }) => {
    await ctx.answerCallbackQuery();
    await showAnalyticsDashboard(ctx, backendDb, config, analyticsSection(args.section), analyticsPeriod(args.days));
    return true;
  },
  analytics_milestones: async ({ ctx, backendDb, config, args }) => {
    const offset = screenNumber(args.offset);
    if (offset == null) return false;
    await ctx.answerCallbackQuery();
    await showMilestones(ctx, backendDb, config, offset);
    return true;
  },
  archive_home: async ({ ctx, backendDb, config }) => {
    await ctx.answerCallbackQuery();
    await showArchiveHome(ctx, backendDb, config);
    return true;
  },
  analytics_archive: async ({ ctx, backendDb, config, args }) => {
    const offset = screenNumber(args.offset);
    if (offset == null) return false;
    await ctx.answerCallbackQuery();
    await showVideoArchive(ctx, backendDb, config, offset);
    return true;
  },
  analytics_post_archive: async ({ ctx, backendDb, config, args }) => {
    const offset = screenNumber(args.offset);
    if (offset == null) return false;
    await ctx.answerCallbackQuery();
    await showPostArchive(ctx, backendDb, config, offset);
    return true;
  },
  analytics_video: async ({ ctx, backendDb, config, args }) => {
    const id = screenNumber(args.id, { min: 1 });
    if (id == null) return false;
    await ctx.answerCallbackQuery();
    await showVideoMetrics(ctx, backendDb, config, id);
    return true;
  },
  analytics_post: async ({ ctx, backendDb, config, args }) => {
    const id = screenNumber(args.id, { min: 1 });
    if (id == null) return false;
    await ctx.answerCallbackQuery();
    await showPostMetrics(ctx, backendDb, config, id);
    return true;
  },
  analytics_post_media: async ({ ctx, backendDb, config, args }) => {
    const id = screenNumber(args.id, { min: 1 });
    if (id == null) return false;
    await ctx.answerCallbackQuery();
    await sendPostArchiveMedia(ctx, backendDb, config, id);
    return true;
  },
  progress: async ({ ctx, backendDb, config, args }) => {
    const draftId = screenNumber(args.draft, { min: 1 });
    if (draftId == null) return false;
    await showPostProgress(ctx, backendDb, config, draftId, { details: false });
    return true;
  },
  progress_details: async ({ ctx, backendDb, config, args }) => {
    const draftId = screenNumber(args.draft, { min: 1 });
    if (draftId == null) return false;
    await showPostProgress(ctx, backendDb, config, draftId, { details: true });
    return true;
  },
  progress_cancel: async ({ ctx, backendDb, config, args }) => {
    const draftId = screenNumber(args.draft, { min: 1 });
    if (draftId == null) return false;
    await showPostProgress(ctx, backendDb, config, draftId, { details: false, cancelRemaining: true });
    return true;
  },
  delivery_preview_threads: (screen) => threadsPreview(screen),
  intake_kind: (screen) =>
    intakeAction(screen, async (actorId, locale) => {
      const choice = screen.args.choice;
      if (choice === "article_confirm") {
        const { title } = publishReviewedArticle(screen.backendDb, screen.config, actorId);
        return [
          {
            type: "screen",
            mode: "reply",
            text: t(locale, "intake.article-published", { title }),
            options: { reply_markup: resultNavigationKeyboard(locale) },
          },
        ];
      }
      if (choice !== "post" && choice !== "article" && choice !== "video") return [];
      return applyIntakeKind(screen.ctx, screen.backendDb, screen.config, choice);
    }),
  intake_locale: (screen) =>
    intakeAction(screen, async (actorId) => {
      const choice = screen.args.locale;
      if (choice !== "ru" && choice !== "en") return [];
      return applyIntakeVideoLocale(screen.ctx, screen.backendDb, screen.config, actorId, choice);
    }),
  intake_cancel: (screen) =>
    intakeAction(screen, async (actorId) => {
      cancelIntake(screen.backendDb, actorId);
      return [
        {
          type: "main-menu",
          menu: screen.mainMenu,
          text: mainMenuText(screen.backendDb, screen.config, actorId),
          edit: true,
        },
      ];
    }),
  deploy_menu: operations,
  deploy_rb_ask: operations,
  deploy_pr_ask: operations,
  deploy_rollback: operations,
  deploy_promote: operations,
};

function operations({ ctx, backendDb, config, callback }: ScreenContext): Promise<boolean> {
  return handleOperationsCallback(ctx, backendDb, config, callback);
}

async function threadsPreview({ ctx, backendDb, config, args }: ScreenContext): Promise<boolean> {
  const id = screenNumber(args.id, { min: 1 });
  if (id == null || !args.kind) return false;
  await sendThreadsPreviews(ctx, backendDb, config, { kind: args.kind, id });
  return true;
}

/** The intake's controls run the way every publication control does: one
 * acknowledgement, one tap at a time, and a failure the operator can read. The
 * whole intake shares a lock key, because two of its buttons pressed together
 * would otherwise both store a video and open two drafts. */
async function intakeAction(
  { ctx, backendDb }: ScreenContext,
  produce: (actorId: number, locale: ReturnType<ReturnType<typeof settingsService>["locale"]>) => Promise<readonly PublicationEffect[]>,
): Promise<boolean> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  await runCallbackAction(ctx, backendDb, { locale, lockKey: `${actorId}:intake`, describe: (error) => describeError(locale, error) }, () =>
    produce(actorId, locale),
  );
  return true;
}
