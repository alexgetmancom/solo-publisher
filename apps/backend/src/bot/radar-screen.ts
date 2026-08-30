import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { acceptCandidate, runRadar } from "../editorial/radar.js";
import {
  candidateCounts,
  decideCandidate,
  type EditorialCandidate,
  getCandidate,
  lastRun,
  listCandidates,
  SKIP_REASONS,
  type SkipReason,
} from "../editorial/store.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { escapeMarkdown } from "../foundation/markdown.js";
import { truncateUnicode } from "../foundation/text.js";
import { formatZonedDateTime } from "../foundation/time.js";
import { settingsService } from "../studio/services/settings.js";
import { showMessage, showScreen } from "./effects.js";
import { postPreviewCard } from "./publication-renderers.js";
import { screenCallback } from "./screen-callback.js";

/** The radar, as the operator works it.
 *
 * Not a conversation: findings are answered in any order, over days, and half
 * of them are never answered at all. So there is a screen with a state, not a
 * flow with steps -- and the one step that is a flow, writing the post, is the
 * one this hands over to unchanged. */

/** One at a time. A list of ten headlines is read as a list; a card with three
 * buttons is read as a question, which is what this is. */
const CARD_SUMMARY_LIMIT = 400;

export async function showRadarHome(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const view = radarHomeView(backendDb, config, actorId);
  await showScreen(ctx, view.text, { parse_mode: "Markdown", reply_markup: view.keyboard });
}

export function radarHomeView(backendDb: BackendDb, config: BackendConfig, actorId: number): { text: string; keyboard: InlineKeyboard } {
  const locale = settingsService(backendDb).locale(actorId);
  const time = settingsService(backendDb).timeConfig(actorId, config);
  const counts = candidateCounts(backendDb);
  const search = lastRun(backendDb, "news");
  const lines = [
    `📡 *${t(locale, "radar.title")}*`,
    "",
    t(locale, "radar.waiting", { count: counts.waiting }),
    t(locale, "radar.deferred-count", { count: counts.later }),
  ];
  // An empty radar and a broken radar must not look alike: a week of silence
  // reads as "no news happened" unless the last run says what it did.
  if (!search) lines.push(t(locale, "radar.never-run"));
  else if (search.status === "failed") lines.push(t(locale, "radar.last-failed", { error: truncateUnicode(search.error ?? "", 200) }));
  else lines.push(t(locale, "radar.last-run", { time: formatZonedDateTime(search.startedAt, time.TIMEZONE, time.TIMEZONE_LABEL) }));

  const keyboard = new InlineKeyboard();
  if (counts.waiting > 0) keyboard.text(t(locale, "radar.review"), screenCallback("radar_next")).row();
  keyboard.text(t(locale, "radar.check-now"), screenCallback("radar_run"));
  if (counts.later > 0) keyboard.text(t(locale, "radar.deferred"), screenCallback("radar_deferred"));
  keyboard.row().text(t(locale, "common.menu"), screenCallback("menu_home"));
  return { text: lines.join("\n"), keyboard };
}

/** The next finding waiting for an answer, or the home screen when there is none. */
export async function showNextCandidate(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  status: "new" | "later" = "new",
): Promise<void> {
  const candidate = listCandidates(backendDb, status, 1)[0];
  if (!candidate) {
    await showRadarHome(ctx, backendDb, config);
    return;
  }
  await showCandidate(ctx, backendDb, candidate);
}

async function showCandidate(ctx: Context, backendDb: BackendDb, candidate: EditorialCandidate): Promise<void> {
  const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
  const view = candidateView(candidate, locale);
  await showScreen(ctx, view.text, { parse_mode: "Markdown", reply_markup: view.keyboard, link_preview_options: { is_disabled: true } });
}

export function candidateView(candidate: EditorialCandidate, locale: StudioLocale): { text: string; keyboard: InlineKeyboard } {
  const icon = candidate.producer === "news" ? "📰" : "🧭";
  const lines = [`${icon} *${escapeMarkdown(candidate.title)}*`];
  if (candidate.summary) lines.push("", escapeMarkdown(truncateUnicode(candidate.summary, CARD_SUMMARY_LIMIT)));
  lines.push("", `_${escapeMarkdown(candidate.reason)}_`);
  if (candidate.url) lines.push("", `${t(locale, "radar.source")}: ${candidate.url}`);
  if (candidate.relatedPostIds.length)
    lines.push(`${t(locale, "radar.from-posts")}: ${candidate.relatedPostIds.map((id) => `#${id}`).join(", ")}`);
  const keyboard = new InlineKeyboard()
    .text(t(locale, "radar.accept"), screenCallback("radar_accept", [candidate.id]))
    .row()
    .text(t(locale, "radar.skip"), screenCallback("radar_skip", [candidate.id]))
    .text(t(locale, "radar.later"), screenCallback("radar_later", [candidate.id]))
    .row()
    .text(t(locale, "radar.home"), screenCallback("radar_home"));
  return { text: lines.join("\n"), keyboard };
}

/** Why it was passed over. Optional, and asked after the decision is already
 * recorded: the skip stands whether or not this is answered. */
export async function askSkipReason(ctx: Context, backendDb: BackendDb, config: BackendConfig, candidateId: number): Promise<boolean> {
  const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
  if (!decideCandidate(backendDb, candidateId, { status: "skipped" })) {
    await showRadarHome(ctx, backendDb, config);
    return true;
  }
  const keyboard = new InlineKeyboard();
  for (const reason of SKIP_REASONS)
    keyboard.text(t(locale, `radar.skip-${reason}`), screenCallback("radar_skip_why", [candidateId, reason])).row();
  keyboard.text(t(locale, "radar.skip-no-reason"), screenCallback("radar_next"));
  await showScreen(ctx, t(locale, "radar.skipped"), { reply_markup: keyboard });
  return true;
}

export async function recordSkipReason(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  candidateId: number,
  reason: SkipReason,
): Promise<void> {
  setSkipReason(backendDb, candidateId, reason);
  await showNextCandidate(ctx, backendDb, config);
}

function setSkipReason(backendDb: BackendDb, candidateId: number, reason: SkipReason): void {
  // The status is already `skipped`; this only records which kind of skip it
  // was, and only while it is still a skip.
  decideCandidate(backendDb, candidateId, { status: "skipped", skipReason: reason });
}

/** Puts a finding back on the shelf. It keeps its expiry: "later" is not a
 * place things go to be forgotten, it is a delay, and a story that dies while
 * it sits there is retired like any other. */
export async function deferCandidate(ctx: Context, backendDb: BackendDb, config: BackendConfig, candidateId: number): Promise<void> {
  decideCandidate(backendDb, candidateId, { status: "later" });
  await showNextCandidate(ctx, backendDb, config);
}

/** Runs both producers now, on the operator's word.
 *
 * The search is a subprocess that can take a quarter of an hour, so the tap is
 * answered before it starts rather than left spinning until it ends. */
export async function runRadarNow(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
  await ctx.answerCallbackQuery({ text: t(locale, "radar.check-started") });
  const results = [await runRadar(config, backendDb, "news", { force: true }), await runRadar(config, backendDb, "ideas", { force: true })];
  const failed = results.find((result) => result.status === "failed");
  if (failed?.status === "failed")
    await showMessage(ctx, t(locale, "radar.run-failed", { producer: "news", error: truncateUnicode(failed.error, 1_000) }));
  await showRadarHome(ctx, backendDb, config);
}

/** Accepts a finding and opens the post it became, in the flow every other
 * publication goes through. */
export async function acceptAndOpenDraft(ctx: Context, backendDb: BackendDb, config: BackendConfig, candidateId: number): Promise<boolean> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const accepted = acceptCandidate(backendDb, actorId, candidateId);
  if (!accepted) {
    const existing = getCandidate(backendDb, candidateId);
    await ctx.answerCallbackQuery({
      text: t(locale, existing?.status === "accepted" ? "radar.already-accepted" : "radar.gone"),
      show_alert: true,
    });
    return true;
  }
  await ctx.answerCallbackQuery();
  const preview = postPreviewCard(backendDb, config, actorId, accepted.draftId);
  await showScreen(ctx, preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  return true;
}
