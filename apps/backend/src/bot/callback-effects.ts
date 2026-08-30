import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { withActionLock } from "../foundation/action-lock.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { truncateUnicode } from "../foundation/text.js";
import { executePublicationEffects, type PublicationEffect } from "./effects.js";

const MAX_TOAST_LENGTH = 200;

type CallbackAction = {
  locale: StudioLocale;
  /** Serialises the taps that must not run twice; every tap that shares a
   * workflow shares the key, or two different buttons of one dialog race. */
  lockKey: string;
  describe: (error: unknown) => string;
  onError?: (error: unknown) => void;
};

/** Runs one tapped control and delivers whatever it produced.
 *
 * Every callback in the bot ends here, so the three rules that make a tap
 * legible hold in one place: a duplicate tap is refused rather than run twice,
 * and a failure reaches the operator instead of stopping at a log line. The
 * callback boundary has already acknowledged the tap; its context redirects
 * actionable callback text into a chat message. */
export async function runCallbackAction(
  ctx: Context,
  backendDb: BackendDb,
  action: CallbackAction,
  produce: () => Promise<readonly PublicationEffect[] | undefined>,
): Promise<void> {
  try {
    const locked = await withActionLock(action.lockKey, produce);
    const effects = locked.ok ? [...(locked.value ?? [])] : [{ type: "toast" as const, text: t(action.locale, "action.in-flight") }];
    if (!effects.some((effect) => effect.type === "answer-callback" || effect.type === "toast"))
      effects.unshift({ type: "answer-callback" });
    await executePublicationEffects(ctx, backendDb, effects);
  } catch (error) {
    action.onError?.(error);
    await executePublicationEffects(ctx, backendDb, [{ type: "toast", text: callbackToast(action.describe(error)) }]);
  }
}

/** Telegram silently drops a toast over its limit, so the message is cut to fit. */
export function callbackToast(text: string): string {
  const shortened = truncateUnicode(text, MAX_TOAST_LENGTH);
  return shortened.length < text.length ? `${truncateUnicode(text, MAX_TOAST_LENGTH - 1)}…` : shortened;
}
