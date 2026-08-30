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
  try {
    await answer();
  } catch (error) {
    log("warn", "Failed to acknowledge Telegram callback query", { error: String(error) });
  }
  const acknowledgedAt = performance.now();
  redirectLaterAnswers(ctx);
  try {
    await next();
  } catch (error) {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    await replySafely(ctx, callbackToast(describeError(locale, error)));
  } finally {
    log("info", "Telegram callback timing", {
      callback: callbackRoute(ctx.callbackQuery?.data),
      acknowledgeMs: Math.round(acknowledgedAt - startedAt),
      handlerMs: Math.round(performance.now() - acknowledgedAt),
      totalMs: Math.round(performance.now() - startedAt),
    });
  }
}

function callbackRoute(data: string | undefined): string {
  if (!data) return "unknown";
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
