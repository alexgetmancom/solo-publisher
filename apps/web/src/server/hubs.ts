import { SITE_LOCALE_TAGS, type SiteLocale } from "../utils/locale";
import { type EventKind, eventKind } from "../utils/taxonomy";
import { getFirstSentence } from "../utils/text";
import type { FeedItem } from "./public-site";

/** Which knowledge entities a hub collects. This is data, not copy: it lived
 * duplicated in pages/[hub].astro and pages/ru/[hub].astro, so adding a model to
 * the English hub silently left the Russian one behind. Locale-specific titles
 * and intros stay beside it — those genuinely differ per language. */
export type HubDefinition = {
  entities: ReadonlyArray<{ kind: string; slug: string }>;
  title: string;
  intro: { ru: string; en: string };
};

const HUBS: Record<string, HubDefinition> = {
  codex: {
    entities: [{ kind: "topic", slug: "codex" }],
    title: "Codex",
    intro: {
      en: "OpenAI's agentic coding environment. Track launches, access, limits, workflows, and the way people actually use it.",
      ru: "Агентская среда OpenAI для работы с кодом. Здесь собраны релизы, доступ, лимиты, сценарии и реальные изменения.",
    },
  },
  claude: {
    entities: [
      { kind: "model", slug: "claude" },
      { kind: "model", slug: "fable-5" },
    ],
    title: "Claude",
    intro: {
      en: "Anthropic's model family. Track releases, access, limits, Claude Code, Cowork, and the events that change how the models are used.",
      ru: "Линейка моделей Anthropic. Здесь собраны релизы, доступ, лимиты, Claude Code, Cowork и важные изменения.",
    },
  },
};

export function hubDefinition(hub: string | undefined): HubDefinition | null {
  return hub && hub in HUBS ? HUBS[hub] : null;
}

/** Entity paths that redirected to a hub back when the condition was written out
 * by hand instead of derived from `HUBS`. They are indexed, so they keep their
 * 301 even though the hub does not collect that exact kind — dropping them would
 * change live redirect targets for no gain. */
const LEGACY_HUB_PATHS: Record<string, string> = {
  "product:codex": "codex",
  "product:claude": "claude",
  "topic:claude": "claude",
};

/** The hub URL that replaces an entity's generic `/entities/<kind>/<slug>/`
 * listing, or null when the entity has no hub. The entity routes and the link
 * builder each used to carry their own copy of this condition, and it had already
 * drifted: `product:claude` redirected to a hub that does not collect it, while
 * `model:claude` (which the hub does collect) got no redirect at all. */
export function hubUrl(kind: string, slug: string, locale: "en" | "ru" = "en"): string | null {
  const collected = Object.entries(HUBS).find(([, definition]) =>
    definition.entities.some((entity) => entity.kind === kind && entity.slug === slug),
  )?.[0];
  const hub = collected ?? LEGACY_HUB_PATHS[`${kind}:${slug}`];
  return hub ? `${locale === "ru" ? "/ru" : ""}/${hub}/` : null;
}

/** Posts in the hub's focus, restricted to the locale that can actually be linked. */
export function hubPosts(items: FeedItem[], definition: HubDefinition, locale: "ru" | "en"): FeedItem[] {
  return items.filter(
    (post) =>
      (locale === "en" ? post.has_en && post.slug_en : post.has_ru && post.slug_ru) &&
      post.entities.some(
        (entity) =>
          entity.link_role === "focus" &&
          definition.entities.some((candidate) => candidate.kind === entity.kind && candidate.slug === entity.slug),
      ),
  );
}

/** Every hub as [title, path], for pages that link the site's own topics. */
export function hubTitles(locale: "en" | "ru"): Array<[string, string]> {
  return Object.entries(HUBS).map(([hub, definition]) => [definition.title, `${locale === "ru" ? "/ru" : ""}/${hub}/`]);
}

/** One recorded event in a hub's chronology. */
type HubEvent = { date: string; kind: EventKind; title: string; href: string };

/** A hub's chronology, newest first, grouped by the month each event fell in.
 *
 * The month is resolved in the site's own display zone, not the server's: an
 * event at 01:30 MSK on the first belongs to a different month for a reader in
 * New York, and a page that says otherwise is wrong for the audience it is
 * written for. */
export type HubMonth = { key: string; label: string; events: HubEvent[] };

export function hubChronology(posts: FeedItem[], locale: SiteLocale, timeZone: string): HubMonth[] {
  const tag = SITE_LOCALE_TAGS[locale];
  const monthLabel = new Intl.DateTimeFormat(tag, { timeZone, month: "long", year: "numeric" });
  const monthKey = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" });
  const months = new Map<string, HubMonth>();

  for (const post of posts) {
    const slug = locale === "ru" ? post.slug_ru : post.slug_en;
    if (!slug) continue;
    const text = locale === "ru" ? post.text : post.text_en || post.text;
    const when = new Date(post.date);
    if (Number.isNaN(when.getTime())) continue;
    const key = monthKey.format(when);
    const month = months.get(key) ?? { key, label: monthLabel.format(when), events: [] };
    month.events.push({
      date: post.date,
      kind: eventKind(text),
      title: getFirstSentence(text) || `${locale === "ru" ? "Пост" : "Post"} ${post.post_id}`,
      href: `${locale === "ru" ? "/ru" : ""}/${post.post_id}/${slug}/`,
    });
    months.set(key, month);
  }

  // Sorted here rather than trusted from the caller: the chronology is the
  // page's claim about what happened when, and it must not depend on which
  // query happened to feed it.
  for (const month of months.values()) month.events.sort((a, b) => b.date.localeCompare(a.date));
  return [...months.values()].sort((a, b) => b.key.localeCompare(a.key));
}
