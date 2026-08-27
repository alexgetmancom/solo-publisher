import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { log } from "../foundation/logger.js";
import {
  clearTelegramAnalyticsDashboard,
  setTelegramAnalyticsDashboard,
  telegramAnalyticsDashboards,
} from "../interfaces/telegram/control-cards.js";
import { sendTelegramArchiveMedia } from "../interfaces/telegram/delivery-previews.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { screenCallback } from "./screen-callback.js";
import { choiceLabel } from "./settings/shared.js";
import { ignoringUnchangedEdit, isUnchangedMessageEdit } from "./telegram-errors.js";

/** The sections this screen offers. The analytics read model also renders an
 * "audience" section, which only MCP asks for — no button here produces it. */
type AnalyticsSection = "overview" | "posts" | "video";

/** The Analytics screens, one function per button the registry declares. The
 * read model itself stays transport-neutral; only the markup lives here. */
export async function showArchiveHome(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const summary = createStudioServices(backendDb, config).analytics.archiveSummary(locale);
  clearTelegramAnalyticsDashboard(backendDb, actorId);
  const keyboard = new InlineKeyboard().text(
    t(locale, "analytics.posts-btn", { count: summary.posts }),
    screenCallback("analytics_post_archive", [0]),
  );
  keyboard.row().text(t(locale, "analytics.videos-btn", { count: summary.videos }), screenCallback("analytics_archive", [0]));
  keyboard.row().text(t(locale, "common.menu"), screenCallback("menu_home"));
  await editScreen(ctx, summary.text, { parse_mode: "Markdown", reply_markup: keyboard });
}

export async function showMilestones(ctx: Context, backendDb: BackendDb, config: BackendConfig, offset: number): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const history = createStudioServices(backendDb, config).analytics.milestoneHistory(offset, locale);
  const keyboard = new InlineKeyboard();
  archivePagination(keyboard, locale, (page) => screenCallback("analytics_milestones", [page]), offset, history);
  keyboard
    .text(t(locale, "analytics.back-analytics"), screenCallback("analytics_home"))
    .row()
    .text(t(locale, "common.menu"), screenCallback("menu_home"));
  clearTelegramAnalyticsDashboard(backendDb, actorId);
  await editScreen(ctx, history.text, { reply_markup: keyboard });
}

export async function showVideoArchive(ctx: Context, backendDb: BackendDb, config: BackendConfig, offset: number): Promise<void> {
  const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
  const archive = createStudioServices(backendDb, config).analytics.videoArchive(offset, locale);
  const keyboard = new InlineKeyboard();
  for (const item of archive.items) keyboard.text(item.label, screenCallback("analytics_video", [item.id])).row();
  archivePagination(keyboard, locale, (page) => screenCallback("analytics_archive", [page]), offset, archive);
  keyboard
    .text(t(locale, "analytics.back-archive"), screenCallback("archive_home"))
    .row()
    .text(t(locale, "common.menu"), screenCallback("menu_home"));
  await editScreen(ctx, archive.text, { reply_markup: keyboard });
}

export async function showPostArchive(ctx: Context, backendDb: BackendDb, config: BackendConfig, offset: number): Promise<void> {
  const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
  const archive = createStudioServices(backendDb, config).analytics.postArchive(offset, locale);
  const keyboard = new InlineKeyboard();
  for (const item of archive.items) keyboard.text(item.label, screenCallback("analytics_post", [item.id])).row();
  archivePagination(keyboard, locale, (page) => screenCallback("analytics_post_archive", [page]), offset, archive);
  keyboard
    .text(t(locale, "analytics.back-archive"), screenCallback("archive_home"))
    .row()
    .text(t(locale, "common.menu"), screenCallback("menu_home"));
  await editScreen(ctx, archive.text, { reply_markup: keyboard });
}

export async function showVideoMetrics(ctx: Context, backendDb: BackendDb, config: BackendConfig, id: number): Promise<void> {
  const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
  await editScreen(ctx, createStudioServices(backendDb, config).analytics.videoMetrics(id, locale), {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text(t(locale, "analytics.back-archive"), screenCallback("analytics_archive", [0]))
      .row()
      .text(t(locale, "common.menu"), screenCallback("menu_home")),
  });
}

export async function showPostMetrics(ctx: Context, backendDb: BackendDb, config: BackendConfig, id: number): Promise<void> {
  const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
  const analytics = createStudioServices(backendDb, config).analytics;
  const keyboard = new InlineKeyboard();
  if (analytics.postMedia(id, locale).length)
    keyboard.text(t(locale, "analytics.show-media"), screenCallback("analytics_post_media", [id])).row();
  keyboard
    .text(t(locale, "analytics.back-archive"), screenCallback("analytics_post_archive", [0]))
    .row()
    .text(t(locale, "common.menu"), screenCallback("menu_home"));
  await editScreen(ctx, analytics.postMetrics(id, locale), { parse_mode: "Markdown", reply_markup: keyboard });
}

export async function sendPostArchiveMedia(ctx: Context, backendDb: BackendDb, config: BackendConfig, id: number): Promise<void> {
  const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
  await sendTelegramArchiveMedia(ctx, createStudioServices(backendDb, config).analytics.postMedia(id, locale));
}

async function editScreen(ctx: Context, ...args: Parameters<Context["editMessageText"]>): Promise<void> {
  await ignoringUnchangedEdit(() => ctx.editMessageText(...args));
}

/** The period and section a tap asked for, narrowed to what this screen has.
 * Callback data is attacker-controlled text: anything else reads as the default. */
export function analyticsPeriod(value: string | number | undefined): 1 | 7 | 30 {
  const days = Number(value);
  return days === 1 || days === 30 ? days : 7;
}

export function analyticsSection(value: string | undefined): AnalyticsSection {
  return value === "posts" || value === "video" ? value : "overview";
}

export async function showAnalyticsDashboard(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  section: AnalyticsSection,
  days: 1 | 7 | 30,
): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const dashboard = createStudioServices(backendDb, config).analytics.dashboard(section, days, locale);
  const keyboard = analyticsKeyboard(locale, section, days);
  await editScreen(ctx, { html: dashboard.richHtml }, { reply_markup: keyboard });
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (Number.isSafeInteger(actorId) && messageId && ctx.chat?.id)
    setTelegramAnalyticsDashboard(backendDb, actorId, Number(ctx.chat.id), messageId, section, days);
}

/** Refreshes only the currently open dashboard for each owner. The interface
 * binding prevents hourly analytics collection from creating chat noise. */
export async function refreshTelegramAnalyticsDashboards(bot: Bot, backendDb: BackendDb, config: BackendConfig): Promise<number> {
  const analytics = createStudioServices(backendDb, config).analytics;
  const results = await Promise.all(
    telegramAnalyticsDashboards(backendDb).map(async (card) => {
      const section = card.section;
      const locale = settingsService(backendDb).locale(card.actorId);
      const dashboard = analytics.dashboard(section, card.days, locale);
      try {
        await bot.api.editMessageText(
          card.chatId,
          card.messageId,
          { html: dashboard.richHtml },
          {
            reply_markup: analyticsKeyboard(locale, section, card.days),
          },
        );
        return true;
      } catch (error) {
        // The screen may have been superseded or deleted. It is harmless: the
        // next explicit Analytics click records a new binding.
        if (!isUnchangedMessageEdit(error)) log("warn", "analytics dashboard refresh failed", { actorId: card.actorId, section, error });
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

export function analyticsKeyboard(locale: StudioLocale, section: AnalyticsSection, days: 1 | 7 | 30): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  // Three rows of buttons used to look alike while doing three different jobs:
  // filtering, switching section, and leaving for another screen. The period is
  // one control now, the section keeps its three, and everything that navigates
  // away sits on the last row with the way out.
  keyboard
    .text(
      t(locale, "analytics.period", { period: t(locale, `analytics.period-${days}`) }),
      screenCallback("analytics_section", [section, nextPeriod(days)]),
    )
    .row();
  for (const [name, key] of [
    ["overview", "analytics.overview"],
    ["posts", "analytics.posts-section"],
    ["video", "analytics.video-section"],
  ] as const)
    keyboard.text(choiceLabel(section === name, t(locale, key)), screenCallback("analytics_section", [name, days]));
  // The archive is reached from here or from nowhere: every screen under it
  // links back to screenCallback("archive_home"), and nothing linked in.
  keyboard
    .row()
    .text(t(locale, "analytics.milestones-btn"), screenCallback("analytics_milestones", [0]))
    .text(t(locale, "analytics.archive-btn"), screenCallback("archive_home"))
    .text(t(locale, "common.menu"), screenCallback("menu_home"));
  return keyboard;
}

/** The periods in the order the button walks them. */
function nextPeriod(days: 1 | 7 | 30): 1 | 7 | 30 {
  return days === 1 ? 7 : days === 7 ? 30 : 1;
}

/** Page arithmetic follows the page size the archive itself used, so the
 * numbers under a listing cannot disagree with the listing above them. */
function archivePagination(
  keyboard: InlineKeyboard,
  locale: StudioLocale,
  page: (offset: number) => string,
  offset: number,
  archive: { items: Array<unknown>; total: number; pageSize: number },
): void {
  if (!archive.total) return;
  const current = Math.floor(offset / archive.pageSize) + 1;
  const pages = Math.max(1, Math.ceil(archive.total / archive.pageSize));
  if (offset > 0) keyboard.text(t(locale, "analytics.prev"), page(Math.max(0, offset - archive.pageSize)));
  keyboard.text(`${current}/${pages}`, screenCallback("noop"));
  if (offset + archive.items.length < archive.total) keyboard.text(t(locale, "analytics.next"), page(offset + archive.items.length));
  keyboard.row();
}
