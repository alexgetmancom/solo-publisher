import { type Bot, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { log } from "../foundation/logger.js";
import { escapeMarkdown } from "../foundation/markdown.js";
import { truncateUnicode } from "../foundation/text.js";
import { telegramPostProgressCard } from "../interfaces/telegram/control-cards.js";

import { type PostProgressState, type PostProgressStatus, postProgressState } from "../studio/services/post-progress.js";
import { settingsService } from "../studio/services/settings.js";
import { screenCallback } from "./screen-callback.js";
import { isUnchangedMessageEdit } from "./telegram-errors.js";

/** Telegram renderer over the transport-free Studio progress state. */
export function postProgress(backendDb: BackendDb, draftId: number, details = false): { text: string; keyboard: InlineKeyboard } {
  const state = postProgressState(backendDb, draftId);
  return renderPostProgress(state, settingsService(backendDb).locale(state.actorId), details);
}

export function renderPostProgress(
  state: PostProgressState,
  locale: StudioLocale,
  details = false,
): { text: string; keyboard: InlineKeyboard } {
  const { counts } = state;
  const completed = counts.published + counts.failed + counts.verification_required + counts.cancelled;
  const total = state.targets.length;
  const title =
    counts.failed + counts.verification_required
      ? t(locale, "progress.issues-title")
      : completed === total && total > 0
        ? t(locale, "progress.complete-title")
        : t(locale, "progress.publishing-title");
  const lines = [
    `${title} · *Post #${state.draftId}*`,
    "",
    `${t(locale, "progress.progress")}: *${completed} / ${total}*`,
    `✅ ${t(locale, "progress.published")}: ${counts.published}`,
    `🔄 ${t(locale, "progress.publishing")}: ${counts.publishing}`,
    `⏳ ${t(locale, "progress.waiting")}: ${counts.waiting}`,
    `❌ ${t(locale, "progress.failed")}: ${counts.failed}`,
    `⚠️ ${t(locale, "progress.verification-required")}: ${counts.verification_required}`,
  ];
  if (details)
    for (const group of ["ru", "en"] as const) {
      const items = state.targets.filter((item) => item.locale === group);
      if (!items.length) continue;
      lines.push("", `*${group.toUpperCase()}*`);
      for (const item of items)
        lines.push(
          `${statusIcon(item.status)} ${item.label}${
            item.error && (item.status === "failed" || item.status === "verification_required") ? ` — ${shortError(item.error)}` : ""
          }`,
        );
    }
  const keyboard = new InlineKeyboard();
  keyboard.text(
    t(locale, details ? "progress.hide-details" : "progress.show-details"),
    details ? screenCallback("progress", [state.draftId]) : screenCallback("progress_details", [state.draftId]),
  );
  if (counts.waiting + counts.publishing > 0)
    keyboard.text(t(locale, "progress.cancel-remaining"), screenCallback("progress_cancel", [state.draftId]));
  keyboard.row().text(t(locale, "common.menu"), screenCallback("menu_home"));
  return { text: lines.join("\n"), keyboard };
}

export async function refreshPostControlCard(backendDb: BackendDb, bot: Bot | null, draftId: number): Promise<void> {
  if (!bot) return;
  const control = telegramPostProgressCard(backendDb, draftId);
  if (!control) return;
  const card = postProgress(backendDb, draftId, "details" in control && control.details === true);
  try {
    await bot.api.editMessageText(control.chatId, control.messageId, card.text, { parse_mode: "Markdown", reply_markup: card.keyboard });
  } catch (error) {
    // A card refreshed on every publish step is usually identical to what is
    // already on screen, which Telegram rejects; that is the normal path and
    // stays silent. Anything else means the card has quietly stopped tracking
    // the publish it is supposed to show, so it must not be swallowed.
    if (!isUnchangedMessageEdit(error)) log("warn", "post control card refresh failed", { draftId, error });
  }
}

function statusIcon(status: PostProgressStatus): string {
  return { published: "✅", publishing: "🔄", waiting: "⏳", failed: "❌", verification_required: "⚠️", cancelled: "⏹" }[status];
}

/** A platform error can be arbitrarily long; the card must stay under Telegram's
 * message limit. Truncation comes first: cutting escaped text can strip the
 * character a backslash was escaping and leave the card ending in a lone `\`,
 * which the Markdown parser rejects. */
function shortError(value: string): string {
  return escapeMarkdown(truncateUnicode(value, 180));
}
