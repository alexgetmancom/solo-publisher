import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { describeError } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { settingsService } from "../studio/services/settings.js";
import { callbackToast } from "./callback-effects.js";
import { showMessage } from "./effects.js";

const CALLBACK_DEDUPLICATION_TTL_MS = 15 * 60_000;
const CALLBACK_DEDUPLICATION_LIMIT = 10_000;
const seenCallbackQueries = new Map<string, number>();

// This dedupe is intentionally process-local. It suppresses Telegram redelivery
// within one bot process, but is not a distributed idempotency guarantee across
// restarts or multiple instances; durable mutations must remain idempotent too.

/** Runs every callback downstream of the bot's authorization middleware. */
export async function runCallbackBoundary(ctx: Context, backendDb: BackendDb, next: () => Promise<void>): Promise<void> {
  const startedAt = performance.now();
  const callbackId = ctx.callbackQuery?.id;
  if (callbackId && !claimCallbackQuery(callbackId)) {
    await answerCallbackSafely(ctx);
    return;
  }
  const answer = ctx.answerCallbackQuery.bind(ctx);
  // The redirect is installed before either of them starts, not between them.
  // The handler now runs while the acknowledgement is still in flight, and
  // Telegram accepts exactly one answer: a handler that answers for itself must
  // find the redirect already in place, whichever finishes first.
  redirectLaterAnswers(ctx);
  // Sending the answer no longer blocks the work behind it. Measured over 78
  // production taps the acknowledgement is a quarter of the tap -- 22 ms of a
  // 115 ms median -- so this removes that quarter, and the screen the operator
  // is waiting for lands that much sooner. Both are still awaited: an
  // unacknowledged callback spins on the operator's phone.
  let acknowledgedAt = startedAt;
  const acknowledgement = answer()
    .catch((error) => log("warn", "Failed to acknowledge Telegram callback query", { error: String(error) }))
    .finally(() => {
      acknowledgedAt = performance.now();
    });
  const handlerStartedAt = performance.now();
  let handlerFinishedAt = handlerStartedAt;
  try {
    await next();
  } catch (error) {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    await replySafely(ctx, callbackToast(describeError(locale, error)));
  } finally {
    handlerFinishedAt = performance.now();
    await acknowledgement;
    log("info", "Telegram callback timing", {
      callback: callbackRoute(ctx.callbackQuery?.data),
      acknowledgeMs: Math.round(acknowledgedAt - startedAt),
      handlerMs: Math.round(handlerFinishedAt - handlerStartedAt),
      totalMs: Math.round(performance.now() - startedAt),
    });
  }
}

/** The grouping key one tap is counted under.
 *
 * `@grammyjs/menu` encodes its buttons as `id/row/col/payload/hash`, and the
 * hash is raw bytes: logging the whole string made every tap on the same button
 * its own unique, unreadable route, which is no grouping at all. The position
 * is what identifies the button, so the payload and the hash are dropped. */
export function callbackRoute(data: string | undefined): string {
  if (!data) return "unknown";
  if (data.includes("/")) return data.split("/").slice(0, 3).join("/");
  return data
    .split(":")
    .slice(0, 2)
    .map((part) => (/^\d+$/.test(part) ? "#" : part))
    .join(":");
}

/** Telegram accepts one callback answer. Spend it immediately so the button
 * stops spinning; later empty acknowledgements are no-ops and actionable
 * toasts become visible chat messages. */
function redirectLaterAnswers(ctx: Context): void {
  ctx.answerCallbackQuery = async (options?: Parameters<Context["answerCallbackQuery"]>[0]) => {
    if (options && typeof options === "object" && "text" in options && options.text) await replySafely(ctx, options.text);
    return true;
  };
}

function claimCallbackQuery(callbackId: string): boolean {
  const now = Date.now();
  for (const [id, seenAt] of seenCallbackQueries) {
    if (now - seenAt > CALLBACK_DEDUPLICATION_TTL_MS) seenCallbackQueries.delete(id);
  }
  if (seenCallbackQueries.has(callbackId)) return false;
  seenCallbackQueries.set(callbackId, now);
  while (seenCallbackQueries.size > CALLBACK_DEDUPLICATION_LIMIT) {
    const oldest = seenCallbackQueries.keys().next().value;
    if (oldest === undefined) break;
    seenCallbackQueries.delete(oldest);
  }
  return true;
}

async function answerCallbackSafely(ctx: Context, options?: { text?: string }): Promise<void> {
  try {
    await ctx.answerCallbackQuery(options);
  } catch (error) {
    // The callback may already have been answered by a screen handler, or its
    // ten-second Telegram window may have closed. Never turn error reporting
    // into a second unhandled callback failure.
    log("warn", "Failed to answer Telegram callback query", { error: String(error) });
  }
}

async function replySafely(ctx: Context, text: string): Promise<void> {
  try {
    await showMessage(ctx, text);
  } catch (error) {
    log("warn", "Failed to send Telegram callback result", { error: String(error) });
  }
}
