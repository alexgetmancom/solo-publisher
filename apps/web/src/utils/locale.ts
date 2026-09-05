/** The languages the public site publishes in.
 *
 * A locale is a URL prefix, a set of feed routes and one object in the copy
 * catalog (`server/site-copy.ts`). Adding one: add the member here with its
 * Intl tag, fill in the catalog — the compiler names every hole — and add the
 * `pages/<locale>/` route files that call the shared feed builders.
 *
 * The default locale owns the bare paths (`/1/slug/`); the others are prefixed
 * (`/ru/1/slug/`). Nothing else in the tree may spell that rule out. */
export const SITE_LOCALES = ["en", "ru"] as const;
export type SiteLocale = (typeof SITE_LOCALES)[number];

export const DEFAULT_SITE_LOCALE: SiteLocale = "en";

/** BCP-47 tags for Intl date and number formatting. The English audience this
 * site publishes for is American, and the tag decides more than punctuation:
 * `en-GB` names US zones "GMT-4", `en-US` names them "EDT". */
export const SITE_LOCALE_TAGS: Record<SiteLocale, string> = { en: "en-US", ru: "ru-RU" };

/** The site path for `path` in `locale`, e.g. localePath("ru", "/1/slug/"). */
export function localePath(locale: SiteLocale, path = "/"): string {
  return locale === DEFAULT_SITE_LOCALE ? path : `/${locale}${path}`;
}
