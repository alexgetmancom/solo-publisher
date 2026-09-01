import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { describeError } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { currentTapMeasurement } from "../foundation/tap-measurement.js";
import { settingsService } from "../studio/services/settings.js";
import { callbackToast } from "./callback-effects.js";
import { showMessage } from "./effects.js";

const CALLBACK_DEDUPLICATION_TTL_MS = 15 * 60_000;
const CALLBACK_DEDUPLICATION_LIMIT = 10_000;
const seenCallbackQueries = new Map<string, number>();

// This dedupe is intentionally process-local. It suppresses Telegram redelivery
// within one bot process, but is not a distributed idempotency guarantee across
// restarts or multiple instances; durable mutations must remain idempotent too.

/**
 * Answers a callback the moment its update arrives, before anything queues.
 *
 * The acknowledgement is what stops the spinner on the operator's phone, and it
 * is the one part of a tap that does not need to wait its turn: screen edits
 * must stay in order, an answer to "I got this" must not. Sitting behind the
 * previous tap's screen edit, it turned a burst of taps into a row of buttons
 * that visibly hang.
 *
 * Telegram accepts exactly one answer per callback, so the redirect that turns a
 * later answer into a chat message is installed here too -- before any handler
 * can run and try to answer for itself.
 */
export function acknowledgeCallback(ctx: Context): void {
  const callbackId = ctx.callbackQuery?.id;
  if (!callbackId) return;
  const receivedAt = performance.now();
  if (!claimCallbackQuery(callbackId)) {
    // A redelivery of something already handled. Answer it so it stops spinning,
    // and mark it for the boundary to drop.
    taps.set(ctx, { receivedAt, duplicate: true, acknowledgement: answerCallbackSafely(ctx) });
    return;
  }
  const answer = ctx.answerCallbackQuery.bind(ctx);
  redirectLaterAnswers(ctx);
  const acknowledgement = answer()
    .then(() => undefined)
    .catch((error) => log("warn", "Failed to acknowledge Telegram callback query", { error: String(error) }));
  taps.set(ctx, { receivedAt, duplicate: false, acknowledgement });
}

type Tap = { receivedAt: number; duplicate: boolean; acknowledgement: Promise<void> };
const taps = new WeakMap<Context, Tap>();

/** Runs every callback downstream of the bot's authorization middleware. */
export async function runCallbackBoundary(ctx: Context, backendDb: BackendDb, next: () => Promise<void>): Promise<void> {
  const tap = taps.get(ctx) ?? { receivedAt: performance.now(), duplicate: false, acknowledgement: Promise.resolve() };
  const startedAt = performance.now();
  if (tap.duplicate) {
    await tap.acknowledgement;
    return;
  }
  let acknowledgedAt = tap.receivedAt;
  void tap.acknowledgement.then(() => {
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
    await tap.acknowledgement;
    const { apiSumMs, apiCalls, providerMs, providerCalls } = currentTapMeasurement();
    const totalMs = performance.now() - tap.receivedAt;
    log("info", "Telegram callback timing", {
      callback: callbackRoute(ctx.callbackQuery?.data),
      // Measured from the update arriving, not from this handler starting: the
      // wait for a turn is exactly what a burst of taps is made of, and leaving
      // it out would hide the thing this ordering exists to fix.
      acknowledgeMs: Math.round(acknowledgedAt - tap.receivedAt),
      queuedMs: Math.round(startedAt - tap.receivedAt),
      handlerMs: Math.round(handlerFinishedAt - handlerStartedAt),
      // Aggregate request cost, not a wall-time partition: acknowledgement and
      // handler calls can overlap. Redundant calls still show up here and in
      // apiCalls without inventing a negative "local" duration.
      apiSumMs: Math.round(apiSumMs),
      apiCalls,
      providerMs: Math.round(providerMs),
      providerCalls,
      totalMs: Math.round(totalMs),
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
