import type { StudioLocale } from "../../foundation/locale.js";

/** The language to write in, named in English for a prompt. Intl knows every
 * language ICU does, so a new interface language needs nothing here. */
export function languageName(locale: StudioLocale): string {
  return new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;
}
