/* =============================================================================
 * EVERY PLAYER INTERFACE STRING
 * -----------------------------------------------------------------------------
 * The one place the player's button and menu labels live.
 * A new label: add the key to StoryUi below and a value to EVERY locale — the
 * compiler rejects the object that is missing it.
 * A new language: one more object here, added to `catalog`.
 * Usage: const ui = storyUi(locale) — the object is passed down to components.
 * Do NOT hardcode strings in .svelte/.astro, or the locales will drift apart.
 * ========================================================================== */

import type { SiteLocale } from "../../utils/locale";

export interface StoryUi {
  storyLabel: string;
  share: string;
  copied: string;
  readMore: string;
  collapse: string;
  read: string;
  back: string;
  mute: string;
  muted: string;
  tapForSound: string;
  storyRail: string;
  feedMode: string;
  feedLatest: string;
  feedDeep: string;
  feedWatched: string;
  menu: string;
  language: string;
  telegram: string;
  about: string;
}

const en: StoryUi = {
  storyLabel: "AI news player",
  share: "Share",
  copied: "Copied",
  readMore: "Read more",
  collapse: "Collapse",
  read: "Read",
  back: "Back",
  mute: "Audio",
  muted: "Muted",
  tapForSound: "Tap for sound",
  storyRail: "Story rail",
  feedMode: "Feed mode",
  feedLatest: "Latest",
  feedDeep: "Deep",
  feedWatched: "Watched",
  menu: "Menu",
  language: "Русский",
  telegram: "Telegram",
  about: "About",
};

const ru = {
  storyLabel: "Новостной плеер",
  share: "Поделиться",
  copied: "Скопировано",
  readMore: "Читать дальше",
  collapse: "Свернуть",
  read: "Читать",
  back: "Назад",
  mute: "Звук",
  muted: "Звук выкл",
  tapForSound: "Включить звук",
  storyRail: "Выбор новостей",
  feedMode: "Режим ленты",
  feedLatest: "Последние",
  feedDeep: "Глубокие",
  feedWatched: "Просмотренные",
  menu: "Меню",
  language: "English",
  telegram: "Telegram",
  about: "Об авторе",
} satisfies StoryUi;

const catalog: Record<SiteLocale, StoryUi> = { en, ru };

export function storyUi(locale: SiteLocale): StoryUi {
  return catalog[locale];
}
