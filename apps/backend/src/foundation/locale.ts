/** Locale primitives shared by Studio services and every interface.
 *
 * Two different concepts wear the word "locale" in this system and they must
 * not be conflated:
 *
 * - StudioLocale is the *interface* language of the owner — bot screens, the
 *   Command Center, MCP replies. Adding one is three edits: a member here, a
 *   native name below, and one more object in the message catalog. Every
 *   `Record<StudioLocale, …>` in the tree then fails to compile until it is
 *   filled in, which is the whole point.
 * - The `"ru" | "en"` spelled out inline across publishing, delivery and
 *   channels is a *content* language: what a post is written in. It is pinned
 *   to those two by the channels that exist, and a new interface language must
 *   never widen it. Do not reach for StudioLocale there.
 */
export const STUDIO_LOCALES = ["en", "ru"] as const;
export type StudioLocale = (typeof STUDIO_LOCALES)[number];

/** Each language named in itself, for the language picker. */
export const STUDIO_LOCALE_NAMES: Record<StudioLocale, string> = { en: "English", ru: "Русский" };

/** BCP-47 tags for Intl formatting of dates and numbers. */
export const STUDIO_LOCALE_TAGS: Record<StudioLocale, string> = { en: "en-GB", ru: "ru-RU" };

const DEFAULT_STUDIO_LOCALE: StudioLocale = "ru";

function isStudioLocale(value: unknown): value is StudioLocale {
  return typeof value === "string" && (STUDIO_LOCALES as readonly string[]).includes(value);
}

/** Reads an interface locale off a query string, cookie or stored setting. */
export function parseStudioLocale(value: unknown, fallback: StudioLocale = DEFAULT_STUDIO_LOCALE): StudioLocale {
  return isStudioLocale(value) ? value : fallback;
}
