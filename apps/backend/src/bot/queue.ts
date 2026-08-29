import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { escapeMarkdown } from "../foundation/markdown.js";
import { truncateUnicode } from "../foundation/text.js";
import { zonedCalendarDay } from "../foundation/time.js";
import { createStudioServices } from "../studio/services/index.js";
import type { StudioQueueAttentionItem, StudioQueueItem, StudioQueueSnapshot } from "../studio/services/queue.js";
import { settingsService } from "../studio/services/settings.js";
import { showScreen } from "./effects.js";
import { publicationCallback } from "./publication-callback.js";
import { formatQueueTime } from "./queue-time.js";
import { screenCallback } from "./screen-callback.js";

const QUEUE_PAGE_SIZE = 10;
const ATTENTION_PAGE_SIZE = 10;

type QueuePage = { upcoming: StudioQueueItem[]; drafts: StudioQueueItem[] };
type QueueScreen = { text: string; items: QueuePage; currentPage: number; pages: number };

export async function showQueue(ctx: Context, backendDb: BackendDb, config: BackendConfig, page = 0): Promise<void> {
  const actorId = ctx.from?.id;
  if (actorId === undefined) return;
  const view = queueView(backendDb, config, actorId, page);
  await replaceQueueMessage(ctx, view.text, view.keyboard);
}

export async function showQueueAttention(ctx: Context, backendDb: BackendDb, config: BackendConfig, page = 0): Promise<void> {
  const actorId = ctx.from?.id;
  if (actorId === undefined) return;
  const view = attentionView(backendDb, config, actorId, page);
  await replaceQueueMessage(ctx, view.text, view.keyboard);
}

/** The queue as text and buttons, without a Telegram call. Sending it is the
 * screen's other half; keeping the two apart is what lets the whole surface be
 * written down and reviewed. */
export function queueView(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  page = 0,
): { text: string; keyboard: InlineKeyboard } {
  const locale = settingsService(backendDb).locale(actorId);
  const services = createStudioServices(backendDb, config);
  const timeConfig = services.settings.timeConfig(actorId, config);
  const snapshot = services.queue.snapshot(actorId);
  const now = backendDb.clock.now();
  const keyboard = new InlineKeyboard();
  const { text, items: pageItems, currentPage, pages } = queueScreen(snapshot, locale, timeConfig.TIMEZONE, page);

  for (const item of pageItems.upcoming) keyboard.text(itemButton(item, now, locale, timeConfig.TIMEZONE), itemCallback(item)).row();
  for (const item of pageItems.drafts) keyboard.text(`${kindIcon(item.kind)} ${item.label}`, itemCallback(item)).row();
  if (snapshot.attention.length)
    keyboard.text(t(locale, "queue.attention-btn", { count: snapshot.attention.length }), screenCallback("queue_attention")).row();
  if (pages > 1) {
    if (currentPage > 0) keyboard.text("←", screenCallback("queue_page", [currentPage - 1]));
    keyboard.text(`${currentPage + 1}/${pages}`, screenCallback("noop"));
    if (currentPage < pages - 1) keyboard.text("→", screenCallback("queue_page", [currentPage + 1]));
    keyboard.row();
  }
  // Every row above closes itself, so the footer opens no empty one: Telegram
  // renders a blank row as a gap the operator can tap into.
  keyboard.text(t(locale, "common.menu"), screenCallback("menu_home"));
  return { text, keyboard };
}

export function attentionView(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  page = 0,
): { text: string; keyboard: InlineKeyboard } {
  const locale = settingsService(backendDb).locale(actorId);
  const services = createStudioServices(backendDb, config);
  const timeConfig = services.settings.timeConfig(actorId, config);
  const snapshot = services.queue.snapshot(actorId);
  const now = backendDb.clock.now();
  const pages = attentionPageCount(snapshot);
  const currentPage = Math.max(0, Math.min(Math.trunc(page), pages - 1));
  const items = pageSlice(snapshot.attention, currentPage, ATTENTION_PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  for (const item of items) {
    keyboard.text(`${kindIcon(item.kind)} ${item.label}`, itemCallback(item)).row();
  }
  if (pages > 1) {
    if (currentPage > 0) keyboard.text("←", screenCallback("queue_attention_page", [currentPage - 1]));
    keyboard.text(`${currentPage + 1}/${pages}`, screenCallback("noop"));
    if (currentPage < pages - 1) keyboard.text("→", screenCallback("queue_attention_page", [currentPage + 1]));
    keyboard.row();
  }
  keyboard.text(t(locale, "common.back"), screenCallback("queue_home")).text(t(locale, "common.menu"), screenCallback("menu_home"));
  const lines = [`⚠️ *${t(locale, "queue.attention-title")}*`, ""];
  if (!items.length) lines.push(t(locale, "queue.no-attention"));
  else
    for (const item of items)
      lines.push(
        `• ${formatQueueTime(item.time, now, locale, timeConfig.TIMEZONE)} — ${kindIcon(item.kind)} ${escapeMarkdown(item.label)}`,
      );
  if (pages > 1) lines.push("", t(locale, "queue.page", { page: currentPage + 1, pages }));
  return { text: lines.join("\n"), keyboard };
}

export function queueScreen(snapshot: StudioQueueSnapshot, locale: StudioLocale, timeZone: string, page = 0): QueueScreen {
  const allPages = queuePages(snapshot, timeZone);
  const currentPage = Math.max(0, Math.min(Math.trunc(page), allPages.length - 1));
  const pages = allPages.length;
  const pageItems = allPages[currentPage] ?? { upcoming: [], drafts: [] };
  return { text: `📋 *${t(locale, "queue.title")}*`, items: pageItems, currentPage, pages };
}

function attentionPageCount(snapshot: StudioQueueSnapshot): number {
  return Math.max(1, Math.ceil(snapshot.attention.length / ATTENTION_PAGE_SIZE));
}

function queuePages(snapshot: StudioQueueSnapshot, timeZone: string): QueuePage[] {
  const pages: QueuePage[] = [];
  let current: QueuePage = { upcoming: [], drafts: [] };
  const flush = () => {
    if (current.upcoming.length || current.drafts.length) pages.push(current);
    current = { upcoming: [], drafts: [] };
  };
  const add = (section: "upcoming" | "drafts", item: StudioQueueItem) => {
    if (current.upcoming.length + current.drafts.length >= QUEUE_PAGE_SIZE) flush();
    current[section].push(item);
  };
  const groups = new Map<string, StudioQueueItem[]>();
  for (const item of snapshot.upcoming) {
    const key = zonedCalendarDay(item.time, timeZone);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const group of groups.values()) {
    if (group.length <= QUEUE_PAGE_SIZE && current.upcoming.length > 0 && current.upcoming.length + group.length > QUEUE_PAGE_SIZE) flush();
    for (const item of group) add("upcoming", item);
  }
  for (const item of snapshot.drafts) add("drafts", item);
  flush();
  return pages.length ? pages : [{ upcoming: [], drafts: [] }];
}

function pageSlice<T>(items: T[], page: number, size: number): T[] {
  return items.slice(page * size, (page + 1) * size);
}

function itemButton(item: StudioQueueItem, now: Date, locale: StudioLocale, timeZone: string): string {
  const targets = item.targets ? ` · ${item.targets} ${t(locale, "queue.platforms-suffix")}` : "";
  // A publication whose time has gone by is marked where the operator reads it,
  // not only sorted to the top where it looks like the next one due.
  const overdue = item.overdue ? "⏰ " : "";
  return truncateUnicode(
    `${overdue}${formatQueueTime(item.time, now, locale, timeZone)} · ${kindIcon(item.kind)} ${item.label}${targets}`,
    60,
  );
}

function kindIcon(kind: StudioQueueItem["kind"]): string {
  return kind === "post" ? "📝" : "🎬";
}

function itemCallback(item: Pick<StudioQueueItem | StudioQueueAttentionItem, "id" | "kind">): string {
  return item.kind === "post"
    ? publicationCallback("post", "view", [item.id, "overview"])
    : publicationCallback("video", "view", [item.id, "overview"]);
}

async function replaceQueueMessage(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  await showScreen(ctx, text, { parse_mode: "Markdown", reply_markup: keyboard });
}
