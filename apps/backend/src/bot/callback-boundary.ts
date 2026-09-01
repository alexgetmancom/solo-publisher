import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { describeError } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { currentTapMeasurement, recordTapAnswered, tapApiMethods } from "../foundation/tap-measurement.js";
import { settingsService } from "../studio/services/settings.js";
import { callbackToast } from "./callback-effects.js";
import { showMessage } from "./effects.js";
import { supersedableScreen } from "./screen-callback.js";

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
 *
 * This is also where a tap claims its place in the supersession, for the same
 * reason: the claim has to be made in arrival order, and everything downstream
 * of `sequentialize` runs in it only one tap at a time.
 */
export function acknowledgeCallback(ctx: Context): void {
  const callbackId = ctx.callbackQuery?.id;
  if (!callbackId) return;
  const receivedAt = performance.now();
  if (!claimCallbackQuery(callbackId)) {
    // A redelivery of something already handled. Answer it so it stops spinning,
    // and mark it for the boundary to drop.
    taps.set(ctx, { receivedAt, duplicate: true, acknowledgement: answerCallbackSafely(ctx), claim: undefined });
    return;
  }
  const answer = ctx.answerCallbackQuery.bind(ctx);
  redirectLaterAnswers(ctx);
  const acknowledgement = answer()
    .then(() => undefined)
    .catch((error) => log("warn", "Failed to acknowledge Telegram callback query", { error: String(error) }));
  taps.set(ctx, { receivedAt, duplicate: false, acknowledgement, claim: claimSupersession(ctx) });
}

type Tap = { receivedAt: number; duplicate: boolean; acknowledgement: Promise<void>; claim: Claim | undefined };
const taps = new WeakMap<Context, Tap>();

/** Runs every callback downstream of the bot's authorization middleware. */
export async function runCallbackBoundary(ctx: Context, backendDb: BackendDb, next: () => Promise<void>): Promise<void> {
  const tap = taps.get(ctx) ?? { receivedAt: performance.now(), duplicate: false, acknowledgement: Promise.resolve(), claim: undefined };
  const startedAt = performance.now();
  if (tap.duplicate) {
    recordTapAnswered();
    await tap.acknowledgement;
    return;
  }
  // The operator has already tapped this same button again, and the tap behind
  // this one draws whatever this one would have. Drawing it first costs a round
  // trip nobody ever sees -- a burst through the queue paid one per page.
  if (tap.claim && isSuperseded(tap.claim)) {
    // The answer is the newer tap's to give, and it is already behind this one.
    recordTapAnswered();
    await tap.acknowledgement;
    log("info", "Telegram callback superseded", {
      callback: callbackRoute(ctx.callbackQuery?.data),
      queuedMs: Math.round(startedAt - tap.receivedAt),
    });
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
    // Taken before the acknowledgement is waited for, because the screen is
    // drawn by now and the operator is no longer waiting for anything.
    recordTapAnswered();
    const answerMs = handlerFinishedAt - tap.receivedAt;
    // Waited for all the same: it keeps `acknowledgeMs` and the method costs
    // complete, and it is what stops an acknowledgement being dropped by a
    // shutdown. It is simply not part of what this tap is judged by.
    await tap.acknowledgement;
    if (tap.claim) releaseSupersession(tap.claim);
    const measurement = currentTapMeasurement();
    const { apiSumMs, apiCalls, providerMs, providerCalls, unchangedEdits } = measurement;
    log("info", "Telegram callback timing", {
      callback: callbackRoute(ctx.callbackQuery?.data),
      // Not a wait the operator has: the acknowledgement goes out ahead of the
      // queue and settles whenever the event loop returns to it. That is what
      // makes it worth logging -- two calls to the same server in one tap, one
      // at 950 ms and one at 68 ms, is a busy loop and not a slow network.
      acknowledgeMs: Math.round(acknowledgedAt - tap.receivedAt),
      queuedMs: Math.round(startedAt - tap.receivedAt),
      handlerMs: Math.round(handlerFinishedAt - handlerStartedAt),
      // Aggregate request cost, not a wall-time partition: acknowledgement and
      // handler calls can overlap. Redundant calls still show up here and in
      // apiCalls without inventing a negative "local" duration.
      apiSumMs: Math.round(apiSumMs),
      apiCalls,
      apiMethods: tapApiMethods(measurement),
      unchangedEdits,
      providerMs: Math.round(providerMs),
      providerCalls,
      // Arrival to answer, which is the whole of what the operator sat through.
      answerMs: Math.round(answerMs),
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

/** One tap's place in the queue for a button.
 *
 * A tap is superseded only by a later tap on the *same button of the same
 * message*: that is the one relation under which the newer tap is known to do
 * everything the older would have done, arguments included. Two different
 * buttons, or the same button on two cards, never stand in for each other.
 */
type Claim = { key: string; sequence: number };
const claims = new Map<string, number>();
let taken = 0;

function claimSupersession(ctx: Context): Claim | undefined {
  const data = ctx.callbackQuery?.data;
  const message = ctx.callbackQuery?.message;
  const messageId = message && "message_id" in message ? message.message_id : null;
  if (!data || messageId == null || ctx.chat?.id == null) return undefined;
  const screen = supersedableScreen(data);
  if (!screen) return undefined;
  taken += 1;
  const claim = { key: `${ctx.chat.id}:${messageId}:${screen}`, sequence: taken };
  claims.set(claim.key, claim.sequence);
  return claim;
}

function isSuperseded(claim: Claim): boolean {
  return claims.get(claim.key) !== claim.sequence;
}

/** The last tap holding a key is the one that drew, so nothing has to be kept
 * once it is done: the map holds only what is still waiting. */
function releaseSupersession(claim: Claim): void {
  if (claims.get(claim.key) === claim.sequence) claims.delete(claim.key);
}
