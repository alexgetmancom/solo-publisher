import { type TargetLocale, targetLocale } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import type { VideoLocale } from "../publishing/video-types.js";
import { videoDestinations } from "./destinations.js";
import { registeredPostTargetIds } from "./registry.js";

/**
 * The languages this Studio publishes in, one pipeline at a time, derived from
 * what it has connected.
 *
 * This is the single answer to "does this Studio have English", and every
 * surface asks it: the Telegram screens, the dashboard, MCP and the CLI. When
 * each one decided for itself, a Studio with only Russian channels still had
 * every post machine-translated, still paid for the translation, and still read
 * as bilingual in the dashboard while the bot had already stopped offering
 * English anywhere.
 *
 * A Studio with nothing connected in a pipeline is a fresh install rather than
 * a monolingual one, so it is offered both.
 *
 * Delivery does not gate on this: it goes through `effectivePostTargets`, where
 * an unconnected target is simply off.
 */
export function postLocales(backendDb: BackendDb): TargetLocale[] {
  const targets = registeredPostTargetIds(backendDb);
  return ordered([...targets].flatMap((target) => targetLocale(target) ?? []));
}

export function videoLocales(backendDb: BackendDb): VideoLocale[] {
  return ordered(videoDestinations(backendDb).map((destination) => destination.locale));
}

/**
 * The YouTube channels this Studio has, which is a narrower question than which
 * languages it publishes video in: a Studio can publish video to Instagram
 * alone and have no YouTube account at all.
 *
 * This one takes no fresh-install fallback. "Both languages" is a sensible
 * default for a pipeline that is about to be set up; for live streaming it
 * would mean asking Google to refresh credentials that were never issued, and
 * the answer to that is an error rather than an empty list.
 */
export function youtubeLocales(backendDb: BackendDb): VideoLocale[] {
  const connected = new Set(
    videoDestinations(backendDb)
      .filter((destination) => destination.profile.startsWith("youtube"))
      .map((destination) => destination.locale),
  );
  return LOCALE_ORDER.filter((locale) => connected.has(locale as VideoLocale)) as VideoLocale[];
}

/** Reading order everywhere a language is a column, a row or a heading. */
const LOCALE_ORDER: TargetLocale[] = ["ru", "en"];

function ordered(locales: TargetLocale[]): TargetLocale[] {
  const connected = new Set(locales);
  if (!connected.size) return [...LOCALE_ORDER];
  return LOCALE_ORDER.filter((locale) => connected.has(locale));
}
