import type { ThreadPart } from "../application/ports.js";
import { targetLocale } from "../botTargets.js";
import { draftLocaleContent } from "../content/draft-content.js";
import { textLocale } from "../content/text-locale.js";
import { joinedThread, localizedThread } from "../content/thread.js";
import { splitText } from "../delivery/social/payload.js";
import { StudioError } from "../foundation/errors.js";
import { formatPlatformText, platformProfile } from "./platform-profiles.js";
import { assertKnownTargets, parseTargets } from "./targets.js";
import { isThreadsTarget, threadsBody, threadsTextLimit } from "./threads-text.js";

type DraftForPreflight = {
  text_ru: string | null;
  text_en_approved?: string | null;
  text_en_machine?: string | null;
  media_ru_json: string | null;
  media_en_json?: string | null;
  text_ru_entities_json?: string | null;
  text_en_entities_json?: string | null;
  targets_json: string;
  thread?: readonly ThreadPart[];
};

export type PublicationPreflightIssue = {
  target: string;
  locale: "ru" | "en";
  /** What is wrong, for surfaces to word in their own locale. */
  kind: "text-limit" | "caption-limit" | "media-limit" | "language" | "empty";
  label: string;
  limit?: number;
  actual?: number;
  /** The language the text is actually written in, on a `language` issue. */
  written?: "ru" | "en";
  /** Which post of a thread is at fault; absent for the first post. */
  part?: number;
  /** How many posts the text would make as a thread. Set only on a first post
   * that is not a thread yet and goes to a platform that carries one, which is
   * what the bot keys the "make it a thread" button off. */
  threadParts?: number;
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
    const thread = localizedThread(draft.thread ?? [], locale);
    // A target publishes into one language, and the draft either has that
    // language or it does not. Both of these used to pass: an English target
    // carried the Russian text through a chain of fallbacks, and a target whose
    // locale had nothing at all published an empty post.
    // Its own media, not the Russian images it would borrow: a Russian post with
    // photos and the English target left on looked like it had something to
    // publish, and published a page with no words on it.
    if (!value.text.trim() && value.ownMedia.length === 0) return [{ target, locale, kind: "empty" as const, label }];
    // A part whose English has not arrived would be an empty reply.
    const emptyPart = thread.findIndex((part) => !part.text.trim());
    if (emptyPart >= 0) return [{ target, locale, kind: "empty" as const, label, part: emptyPart + 2 }];
    const written = textLocale(value.text);
    // Only a text that says what it is blocks. Anglicisms, brand lists and
    // link-only posts read as neither language, and neither is refused.
    if (written && written !== locale) return [{ target, locale, kind: "language" as const, label, written }];
    const mode = profile?.thread?.mode;
    // Telegram carries a thread as one rich message, which has its own budget
    // and no caption: the text and caption limits of a single post do not apply.
    if (profile?.thread?.mode === "rich" && thread.length) {
      const joined = joinedThread(value, thread).text;
      const media = value.media.length + thread.reduce((sum, part) => sum + part.media.length, 0);
      if (joined.length > profile.thread.textLimit)
        return [{ target, locale, kind: "text-limit" as const, label, limit: profile.thread.textLimit, actual: joined.length }];
      if (media > profile.thread.mediaLimit)
        return [{ target, locale, kind: "media-limit" as const, label, limit: profile.thread.mediaLimit, actual: media }];
      return [];
    }
    if (profile?.thread?.mode === "chain") {
      const limit = profile.thread.replyMediaLimit;
      const crowded = thread.findIndex((part) => part.media.length > limit);
      const part = thread[crowded];
      if (part) return [{ target, locale, kind: "media-limit" as const, label, limit, actual: part.media.length, part: crowded + 2 }];
    }
    const measure = (text: string, entities: Record<string, unknown>[]) =>
      isThreadsTarget(target) ? threadsBody(target, text, entities).text : formatPlatformText(target, text);
    // A caption limit only binds when media is attached; a text limit is the
    // platform's own cap on a post and binds always. A platform that carries a
    // thread measures every post of it; any other publishes the parts joined.
    const posts =
      mode === "chain"
        ? [
            { text: measure(value.text, value.entities), media: value.media.length },
            ...thread.map((part) => ({ text: measure(part.text, part.entities), media: part.media.length })),
          ]
        : [
            {
              text: measure(joinedThread(value, thread).text, []),
              media: value.media.length + thread.reduce((sum, part) => sum + part.media.length, 0),
            },
          ];
    return posts.flatMap((post, index) =>
      (
        [
          { kind: "text-limit" as const, limit: profile?.limits?.text, applies: true },
          { kind: "caption-limit" as const, limit: profile?.limits?.caption, applies: post.media > 0 },
        ] as const
      ).flatMap((rule) =>
        rule.applies && rule.limit && post.text.length > rule.limit
          ? [
              {
                target,
                locale,
                kind: rule.kind,
                limit: rule.limit,
                actual: post.text.length,
                label,
                ...(index > 0 ? { part: index + 1 } : {}),
                // A thread is cut at the Threads budget whatever the overflow was.
                ...(mode && index === 0 && !thread.length
                  ? { threadParts: splitText(post.text, threadsTextLimit("threads_ru")).length }
                  : {}),
              },
            ]
          : [],
      ),
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
