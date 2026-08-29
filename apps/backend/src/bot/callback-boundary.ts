import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { describeError } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { settingsService } from "../studio/services/settings.js";
import { callbackToast } from "./callback-effects.js";

const CALLBACK_DEDUPLICATION_TTL_MS = 15 * 60_000;
const CALLBACK_DEDUPLICATION_LIMIT = 10_000;
const seenCallbackQueries = new Map<string, number>();

// This dedupe is intentionally process-local. It suppresses Telegram redelivery
// within one bot process, but is not a distributed idempotency guarantee across
// restarts or multiple instances; durable mutations must remain idempotent too.

/** Runs every callback downstream of the bot's authorization middleware. */
export async function runCallbackBoundary(ctx: Context, backendDb: BackendDb, next: () => Promise<void>): Promise<void> {
  const callbackId = ctx.callbackQuery?.id;
  if (callbackId && !claimCallbackQuery(callbackId)) {
    await answerCallbackSafely(ctx);
    return;
  }
  const answered = recordAnswers(ctx);
  try {
    await next();
    // Telegram spins that button until something answers it, and every handler
    // answering for itself is a rule nobody can hold: the one that forgets
    // leaves a control turning for ten seconds and no trace anywhere. A handler
    // still answers when it has something to say -- a toast, an alert -- and
    // this is what covers the ones that have nothing.
    if (!answered.value) await answerCallbackSafely(ctx);
  } catch (error) {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    await answerCallbackSafely(ctx, { text: callbackToast(describeError(locale, error)) });
  }
}

/** Watches this update's own acknowledgement, so the boundary can tell a tap
 * that was answered from one that was dropped. */
function recordAnswers(ctx: Context): { value: boolean } {
  const answered = { value: false };
  const answer = ctx.answerCallbackQuery.bind(ctx);
  ctx.answerCallbackQuery = async (...args: Parameters<Context["answerCallbackQuery"]>) => {
    answered.value = true;
    return answer(...args);
  };
  return answered;
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
