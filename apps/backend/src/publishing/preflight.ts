import { targetLocale } from "../botTargets.js";
import { draftLocaleContent } from "../content/draft-content.js";
import { textLocale } from "../content/text-locale.js";
import { splitText } from "../delivery/social/payload.js";
import { StudioError } from "../foundation/errors.js";
import { formatPlatformText, platformProfile } from "./platform-profiles.js";
import { assertKnownTargets, parseTargets } from "./targets.js";
import { isThreadsTarget, threadsBody } from "./threads-text.js";

type DraftForPreflight = {
  text_ru: string | null;
  text_en_approved?: string | null;
  text_en_machine?: string | null;
  media_ru_json: string | null;
  media_en_json?: string | null;
  text_ru_entities_json?: string | null;
  text_en_entities_json?: string | null;
  targets_json: string;
  threads_chain_approved?: number | boolean | null;
};

export type PublicationPreflightIssue = {
  target: string;
  locale: "ru" | "en";
  /** What is wrong, for surfaces to word in their own locale. */
  kind: "text-limit" | "caption-limit" | "language" | "empty";
  label: string;
  limit?: number;
  actual?: number;
  /** The language the text is actually written in, on a `language` issue. */
  written?: "ru" | "en";
  /** How many Threads posts the text would take if the author waives the rule.
   * Absent on issues that cannot be waived, which is what the bot keys the
   * override button off — a Telegram caption has no chain to fall back to. */
  chainParts?: number;
};

/**
 * Checks constraints that must block a plan. Delivery still defensively
 * validates delivery payloads, but a new draft must never become a partial
 * publication merely because a selected target cannot accept its media caption.
 */
export function publicationPreflight(draft: DraftForPreflight): PublicationPreflightIssue[] {
  const targets = parseTargets(draft.targets_json);
  const content = {
    ru: draftLocaleContent(draft, "ru"),
    en: draftLocaleContent(draft, "en"),
  } as const;
  return Object.entries(targets).flatMap(([target, enabled]): PublicationPreflightIssue[] => {
    if (!enabled) return [];
    const profile = platformProfile(target);
    const locale = targetLocale(target) ?? "ru";
    const value = content[locale];
    const label = profile?.label ?? target;
    // Threads is measured on the body it will actually carry: the appended link
    // is part of the budget when it fits, and simply absent when it does not.
    const text = isThreadsTarget(target)
      ? threadsBody(target, value.text, value.entities, { chain: Boolean(draft.threads_chain_approved) }).text
      : formatPlatformText(target, value.text);
    // A caption limit only binds when media is attached; a text limit is the
    // platform's own cap on a post and binds always. Threads has the second kind:
    // it used to be met by splitting into a reply chain, and is now a hard stop,
    // so the draft has to fit before it is planned.
    // A Threads text limit can be waived per draft, because Threads has somewhere
    // to put the overflow: a reply chain. A Telegram caption limit cannot — there
    // is no second message to continue into — so it is never waivable.
    // A target publishes into one language, and the draft either has that
    // language or it does not. Both of these used to pass: an English target
    // carried the Russian text through a chain of fallbacks, and a target whose
    // locale had nothing at all published an empty post.
    // Its own media, not the Russian images it would borrow: a Russian post with
    // photos and the English target left on looked like it had something to
    // publish, and published a page with no words on it.
    if (!value.text.trim() && value.ownMedia.length === 0)
      return [
        {
          target,
          locale,
          kind: "empty" as const,
          label,
        },
      ];
    const written = textLocale(value.text);
    // Only a text that says what it is blocks. Anglicisms, brand lists and
    // link-only posts read as neither language, and neither is refused.
    if (written && written !== locale)
      return [
        {
          target,
          locale,
          kind: "language" as const,
          label,
          written,
        },
      ];
    const waivable = isThreadsTarget(target);
    const waived = waivable && Boolean(draft.threads_chain_approved);
    const rules = [
      {
        kind: "text-limit" as const,
        limit: profile?.limits?.text,
        applies: !waived,
        waivable,
      },
      {
        kind: "caption-limit" as const,
        limit: profile?.limits?.caption,
        applies: value.media.length > 0,
        waivable: false,
      },
    ];
    return rules.flatMap((rule) =>
      rule.applies && rule.limit && text.length > rule.limit
        ? [
            {
              target,
              locale,
              kind: rule.kind,
              limit: rule.limit,
              actual: text.length,
              label,
              ...(rule.waivable ? { chainParts: splitText(text, rule.limit).length } : {}),
            },
          ]
        : [],
    );
  });
}

export function assertPublicationPreflight(draft: DraftForPreflight): void {
  const targets = parseTargets(draft.targets_json);
  assertKnownTargets(targets);
  // The caller has already narrowed these to the targets with a connected
  // channel, so an empty set is a publication with nowhere to go. It used to be
  // created anyway: no jobs, and a `scheduled` publication that no worker would
  // ever pick up and no status would ever move off "upcoming".
  if (!Object.values(targets).some(Boolean)) throw new StudioError("err.post-no-targets");
  const issues = publicationPreflight(draft);
  const issue = issues[0];
  if (issue) throw new StudioError("err.post-preflight", { target: issue.label, reason: issue.kind });
}
