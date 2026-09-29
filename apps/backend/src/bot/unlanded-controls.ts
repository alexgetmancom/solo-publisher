import type { InlineKeyboard } from "grammy";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import type { PublicationKind } from "./publication-callback.js";
import { publicationCallback } from "./publication-callback.js";

/** One target a publication did not land on, as the operator has to act on it:
 * retry it, give up on it, or -- for a target nobody can do either with --
 * simply read that it failed. */
export type UnlandedTarget = {
  target: string;
  label: string;
  retryable: boolean;
  skippable: boolean;
  /** Set when the platform refused the content itself: which language of the
   * post has to be edited for the answer to change. */
  fix?: "ru" | "en";
};

type UnlandedControls = {
  locale: StudioLocale;
  kind: PublicationKind;
  draftId: number;
  /** Which surface the tap comes from, so the handler knows whether a card is
   * open to refresh behind it. */
  origin: "card" | "notice";
  targets: readonly UnlandedTarget[];
};

/** Appends "retry" and "give up" for every target that did not land.
 *
 * The publication card and the completion notice offer the operator the same
 * decision about the same targets, and as two copies of these rows they had
 * already drifted apart on ordering. Returns whether anything was added, so a
 * notice with nothing to decide carries no keyboard at all. */
export function appendUnlandedControls(keyboard: InlineKeyboard, options: UnlandedControls): boolean {
  const { locale, kind, draftId, origin, targets } = options;
  // Giving up on a target, and doing every target at once, are post operations:
  // a video is retried one upload at a time because each carries its own
  // metadata, and a video target is given up on by cancelling the video, which
  // its own card offers. The registry says the same thing -- "skip" is declared
  // for posts only -- so these rows name that kind outright.
  const retryable = targets.filter((item) => item.retryable);
  const skippable = kind === "post" ? targets.filter((item) => item.skippable) : [];
  if (!retryable.length && !skippable.length) return false;
  if (kind === "post") {
    if (retryable.length) keyboard.text(t(locale, "notif.retry-failed"), publicationCallback("post", "retry", [draftId, "all", origin]));
    if (skippable.length) keyboard.text(t(locale, "notif.skip-failed"), publicationCallback("post", "skip", [draftId, "all", origin]));
    keyboard.row();
  }
  for (const item of targets) {
    const skip = skippable.includes(item);
    if (!item.retryable && !skip && !item.fix) continue;
    // Each action is spelled out, because the callback registry reads these
    // call sites to know which actions exist.
    if (item.fix === "en")
      keyboard.text(t(locale, "notif.fix-target", { target: item.label }), publicationCallback("post", "edit_en", [draftId]));
    if (item.fix === "ru")
      keyboard.text(t(locale, "notif.fix-target", { target: item.label }), publicationCallback("post", "edit_ru", [draftId]));
    if (item.retryable)
      keyboard.text(
        t(locale, "notif.retry-target", { target: item.label }),
        publicationCallback(kind, "retry", [draftId, item.target, origin]),
      );
    if (skip)
      keyboard.text(
        t(locale, "notif.skip-target", { target: item.label }),
        publicationCallback("post", "skip", [draftId, item.target, origin]),
      );
    keyboard.row();
  }
  return true;
}
