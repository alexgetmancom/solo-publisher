import type { ThreadPart } from "../application/ports.js";
import { targetLocale } from "../botTargets.js";
import { draftLocaleContent } from "../content/draft-content.js";
import { chainPosts, joinedThread, type LocalizedThreadPart, localizedThread } from "../content/thread.js";
import { platformProfile } from "./platform-profiles.js";
import { parseTargets } from "./targets.js";

type DraftForChainPlan = {
  text_ru?: string | null;
  text_en_approved?: string | null;
  text_en_machine?: string | null;
  text_ru_entities_json?: unknown;
  text_en_entities_json?: unknown;
  media_ru_json?: unknown;
  media_en_json?: unknown;
  targets_json: string;
  thread: readonly ThreadPart[];
};

/** What one target actually receives: the posts it will be sent, already cut
 * the way delivery cuts them. */
export type TargetDelivery = { target: string; label: string; locale: "ru" | "en"; posts: LocalizedThreadPart[]; chained: boolean };

/**
 * The one answer to "how many posts is this, and where do the cuts fall".
 *
 * The author's Russian is cut to the Threads budget when it is saved, and every
 * language is cut again at delivery -- the English machine translation of a post
 * that fit rarely does. The card used to show the first number and the platform
 * received the second, which is how a "thread of 2" went out as four posts. Every
 * surface that says anything about a thread reads this, and delivery cuts with
 * the same `chainPosts` it calls.
 */
export function plannedTargetDeliveries(draft: DraftForChainPlan): TargetDelivery[] {
  const content = { ru: draftLocaleContent(draft, "ru"), en: draftLocaleContent(draft, "en") } as const;
  return Object.entries(parseTargets(draft.targets_json)).flatMap(([target, enabled]): TargetDelivery[] => {
    if (!enabled) return [];
    const locale = targetLocale(target) ?? "ru";
    const profile = platformProfile(target);
    const value = content[locale];
    const thread = localizedThread(draft.thread, locale);
    const written = [{ text: value.text, entities: value.entities, media: value.media }, ...thread];
    const chained = profile?.thread?.mode === "chain";
    const posts = chained
      ? chainPosts(written, profile?.limits?.text ?? Number.MAX_SAFE_INTEGER)
      : [{ ...joinedThread(value, thread), media: value.media.concat(...thread.map((part) => part.media)) }];
    return [{ target, label: profile?.label ?? target, locale, posts, chained }];
  });
}
