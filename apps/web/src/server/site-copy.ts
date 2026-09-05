import type { SiteLocale } from "../utils/locale";
import { siteUrlFromContext } from "../utils/site";
import { getRuntime } from "./runtime";

/**
 * Every string the machine-facing endpoints emit — RSS, JSON feed, the AI feed,
 * per-post markdown and llms.txt.
 *
 * These endpoints used to spell their copy inline as `russian ? … : …`, which
 * meant a third language would have had to touch every line of every builder.
 * English is the source of truth for the key set; each other locale is typed
 * `satisfies SiteCopy`, so the compiler rejects a missing key.
 */
type SiteChrome = {
  /** Title for a post whose text starts with something unusable. */
  postFallback: string;
  publishedOn: string;
  backHome: string;
  viewArticle: string;
  headingAbout: string;
  headingLinks: string;
  headingSocial: string;
  headingPosts: string;
  labelWebsite: string;
  /** This language named in itself, for cross-links from the other languages. */
  nativeName: string;
  labelJsonFeed: string;
  labelRss: string;
  labelSitemap: string;
  labelMarkdownIndex: string;
  noPosts: string;
  /** About page chrome. The page's body is `bio`, which is configuration. */
  aboutTitle: string;
  headingElsewhere: string;
  headingTopics: string;
  headingMachine: string;
  aboutPending: string;
};

/** Who this Studio publishes as, from its profile row. An install that has not
 * said names itself by its own domain, which is true and belongs to nobody
 * else — the alternative was serving the publisher's name and social accounts
 * from every stranger's site. */
function identity(locale: SiteLocale) {
  const site = getRuntime().config.studio.site(locale);
  const host = new URL(siteUrlFromContext()).host;
  return {
    name: site.name || host,
    tagline: site.tagline,
    about: site.about,
    bio: site.bio,
    social: site.profiles.map((profile): [string, string] => [profile.label, profile.url]),
  };
}

const en: SiteChrome = {
  postFallback: "Post {id}",
  publishedOn: "Published on",
  backHome: "Back to Home",
  viewArticle: "View Article",
  headingAbout: "About",
  headingLinks: "Core URLs",
  headingSocial: "Social profiles",
  headingPosts: "Latest posts",
  labelWebsite: "Website",
  nativeName: "English",
  labelJsonFeed: "JSON feed",
  labelRss: "RSS",
  labelSitemap: "Sitemap",
  labelMarkdownIndex: "Markdown overview",
  noPosts: "No posts yet.",
  aboutTitle: "About",
  headingElsewhere: "Where else to read",
  headingTopics: "Topics",
  headingMachine: "Machine-readable",
  aboutPending: "This Studio has not written its About text yet.",
};

const ru: SiteChrome = {
  postFallback: "Пост {id}",
  publishedOn: "Опубликовано",
  backHome: "На главную",
  viewArticle: "Читать статью",
  headingAbout: "О сайте",
  headingLinks: "Основные адреса",
  headingSocial: "Профили",
  headingPosts: "Последние посты",
  labelWebsite: "Сайт",
  nativeName: "Русский",
  labelJsonFeed: "JSON-лента",
  labelRss: "RSS",
  labelSitemap: "Карта сайта",
  labelMarkdownIndex: "Обзор в Markdown",
  noPosts: "Пока постов нет.",
  aboutTitle: "Об авторе",
  headingElsewhere: "Где ещё читать",
  headingTopics: "Темы",
  headingMachine: "Для машин",
  aboutPending: "Эта Студия ещё не написала текст о себе.",
} satisfies SiteChrome;

const catalog: Record<SiteLocale, SiteChrome> = { en, ru };

/** Interface wording plus what this Studio says it is. The first is the
 * product and lives here; the second is configuration, because it is different
 * for every install. */
export type SiteCopy = SiteChrome & {
  feedTitle: string;
  feedDescription: string;
  llmsTitle: string;
  llmsTagline: string;
  llmsAbout: string;
  /** The About page body, paragraph-separated by blank lines. */
  bio: string;
  social: [label: string, url: string][];
};

export function siteCopy(locale: SiteLocale): SiteCopy {
  const { name, tagline, about, bio, social } = identity(locale);
  return {
    ...catalog[locale],
    feedTitle: tagline ? `${name} | ${tagline}` : name,
    feedDescription: about,
    llmsTitle: name,
    llmsTagline: tagline,
    llmsAbout: about,
    bio,
    social,
  };
}

/** Fills `{name}` placeholders, the same convention the backend catalog uses. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in values ? String(values[name]) : `{${name}}`));
}
