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
