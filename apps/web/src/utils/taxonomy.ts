import { DEFAULT_SITE_LOCALE, type SiteLocale } from "./locale";
import { compactText } from "./text";

type SmartBadge = { label: string; class: string; emoji: string };

export function getSmartBadge(text: string): SmartBadge {
  const value = (text || "").toLowerCase();
  if (["слив", "утек", "секрет", "leak", "эксклюзив"].some((word) => value.includes(word)))
    return { label: "Сливы", class: "badge--leaks", emoji: "⚡" };
  if (["gpt", "gemini", "claude", "anthropic", "openai", "google", "llama", "codex"].some((word) => value.includes(word)))
    return { label: "ИИ-Модели", class: "badge--ai", emoji: "🤖" };
  if (["нейросеть", "midjourney", "sora", "генераци", "искусствен", "ии-", "ai "].some((word) => value.includes(word)))
    return { label: "Нейросети", class: "badge--neural", emoji: "🎨" };
  return { label: "Новости", class: "badge--news", emoji: "📰" };
}

/** Exact lookup rather than substring matching: `value.includes("ai")` sent any
 * future class or label that merely contained those letters ("badge--airdrop")
 * into ai-models. A badge is a closed set, so treat it as one. */
const SLUG_BY_BADGE: Record<string, string> = {
  "badge--leaks": "leaks",
  "badge--ai": "ai-models",
  "badge--neural": "neural-networks",
  "badge--news": "news",
  Сливы: "leaks",
  "ИИ-Модели": "ai-models",
  Нейросети: "neural-networks",
  Новости: "news",
};

export function categorySlugFromBadge(badge: { class?: string; label?: string } | string): string {
  const value = typeof badge === "string" ? badge : badge.class || badge.label || "";
  return SLUG_BY_BADGE[value.trim()] ?? "news";
}

const labels: Record<string, Record<SiteLocale, string>> = {
  leaks: { en: "Leaks", ru: "Сливы" },
  "ai-models": { en: "AI Models", ru: "ИИ-Модели" },
  "neural-networks": { en: "Neural Networks", ru: "Нейросети" },
  news: { en: "News", ru: "Новости" },
};

export function categoryLabel(slug: string, locale: SiteLocale = DEFAULT_SITE_LOCALE): string {
  return (labels[slug] ?? labels.news)[locale];
}

/** The category of a text, named in the reader's language. */
export function localizedCategory(text: string, locale: SiteLocale): string {
  return categoryLabel(categorySlugFromBadge(getSmartBadge(text)), locale);
}

/* -----------------------------------------------------------------------------
 * What kind of event a post records.
 *
 * The badge above answers which section a post belongs to. This answers a
 * different question the hub chronologies ask — what happened — and it lives
 * here so that classifying a post's text stays one file's job.
 *
 * Order is the rule, not a detail: a release post almost always also names a
 * price, and a limits post almost always also names the model. First match
 * wins, so the list runs from the most specific event to the least.
 * -------------------------------------------------------------------------- */

export type EventKind = "limits" | "pricing" | "benchmark" | "release" | "leak" | "update";

const EVENT_PATTERNS: ReadonlyArray<readonly [EventKind, RegExp]> = [
  ["limits", /\b(limits?|quota|rate[- ]limit|reset|usage cap)\b|лимит|сброс|квот/i],
  // Before pricing and benchmarks: a launch post almost always quotes the new
  // price and the new score, and what it records is still the launch. The verb
  // forms only — the bare noun "release" shows up in posts that are about a
  // release not having happened yet, which is a leak.
  [
    "release",
    /\b(is out|are out|released|releasing|launch(?:ed|es|ing)?|ships|shipped|now available|drops today|generally available)\b|релиз[ин]|вышл|выпуст|запуст|стал доступ/i,
  ],
  ["benchmark", /\b(benchmarks?|arena|intelligence index|leaderboard|outperform\w*|tops the|#\d)\b|бенчмарк|индекс|рейтинг|обошл|обгон/i],
  ["pricing", /\b(pricing|prices?|cheaper|per 1m|free tier|\$\d)\b|цен[аыу]|подешев|бесплатн/i],
  ["leak", /\b(leak\w*|rumou?r\w*|spotted|showed up|appeared|taken down|registered in|confirmed:)\b|утечк|слив|появил|засветил|замечен/i],
];

/** The event a post records, for the hub chronologies. */
export function eventKind(text: string): EventKind {
  const value = compactText(text);
  return EVENT_PATTERNS.find(([, pattern]) => pattern.test(value))?.[0] ?? "update";
}

const EVENT_LABELS: Record<EventKind, Record<SiteLocale, string>> = {
  limits: { en: "Limits", ru: "Лимиты" },
  pricing: { en: "Pricing", ru: "Цены" },
  benchmark: { en: "Benchmarks", ru: "Бенчмарки" },
  release: { en: "Release", ru: "Релиз" },
  leak: { en: "Leak", ru: "Утечка" },
  update: { en: "Update", ru: "Обновление" },
};

export function eventKindLabel(kind: EventKind, locale: SiteLocale = DEFAULT_SITE_LOCALE): string {
  return EVENT_LABELS[kind][locale];
}
