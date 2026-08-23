import { InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { settingsService } from "../studio/services/settings.js";
import { getConversationState } from "./conversation-state.js";
import type { PublicationEffect } from "./effects.js";
import { type PublicationKind, publicationCallback, versionedCallback } from "./publication-callback.js";
import { screenCallback } from "./screen-callback.js";

type DialogButton = { label: string; callback: string };

/** Renders a compact row of dialog actions with an optional session revision. */
function dialogKeyboard(buttons: readonly DialogButton[], revision?: number | null): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const button of buttons) keyboard.text(button.label, versionedCallback(button.callback, revision));
  return keyboard;
}

/** Adds the standard cancel action to a prompt keyboard. */
export function appendCancelButton(
  keyboard: InlineKeyboard,
  locale: StudioLocale,
  callback: string,
  revision?: number | null,
): InlineKeyboard {
  keyboard.text(t(locale, "common.cancel"), versionedCallback(callback, revision));
  return keyboard;
}

/** Builds a free-text prompt keyboard with only its cancel action. */
export function cancelPromptKeyboard(locale: StudioLocale, callback: string, revision?: number | null): InlineKeyboard {
  return appendCancelButton(new InlineKeyboard(), locale, callback, revision);
}

/** Asks the operator for one value, under the cancel button that closes the
 * dialog it belongs to.
 *
 * Post and video each had their own copy of this, and the two stamped the
 * session revision onto the cancel callback in different places -- same bytes,
 * two spellings, and nothing keeping them that way. */
export function promptEffect(
  backendDb: BackendDb,
  actorId: number,
  kind: PublicationKind,
  text: string,
  options: { plainText?: true } = {},
): PublicationEffect {
  const locale = settingsService(backendDb).locale(actorId);
  const revision = getConversationState(backendDb, actorId, kind)?.revision;
  return {
    type: "prompt",
    text,
    options: {
      ...(options.plainText ? {} : { parse_mode: "Markdown" }),
      reply_markup: cancelPromptKeyboard(locale, publicationCallback(kind, "cancel_dialog"), revision),
    },
  };
}

/** Builds the repeated two-button confirmation footer used by content flows. */
export function confirmationKeyboard(confirm: DialogButton, back: DialogButton, revision?: number | null): InlineKeyboard {
  return dialogKeyboard([confirm, back], revision);
}

/** Builds the final navigation footer after a draft operation. */
export function resultNavigationKeyboard(locale: StudioLocale): InlineKeyboard {
  return appendResultNavigation(new InlineKeyboard(), locale);
}

/** Appends a result footer to a keyboard that already contains operation
 * specific actions, preserving the existing rows.
 *
 * There is one queue screen, so there is one button back to it: the drafts and
 * the upcoming publications are two sections of it, never two destinations. */
export function appendResultNavigation(keyboard: InlineKeyboard, locale: StudioLocale): InlineKeyboard {
  keyboard.text(t(locale, "queue.back-btn"), screenCallback("queue_home")).text(t(locale, "common.menu"), screenCallback("menu_home"));
  return keyboard;
}
