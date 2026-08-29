import { type Html, html } from "../../../foundation/html.js";
import { t } from "../../../foundation/i18n/index.js";
import { DEFAULT_STUDIO_LOCALE, STUDIO_LOCALE_NAMES, STUDIO_LOCALES, type StudioLocale } from "../../../foundation/locale.js";

/** The `locale` query parameter carried through dashboard links. The default
 * language is the absence of the parameter, so only the others spell it out. */
export function localeQuery(locale: StudioLocale): string {
  return locale === DEFAULT_STUDIO_LOCALE ? "" : `&locale=${locale}`;
}

/** The one language picker in the Command Center. It takes the link builder
 * from its caller because each surface knows which of its own parameters must
 * survive the switch — the markup, the order and the active state do not
 * differ between them, and a second copy would drift. */
export function renderLocaleSwitcher(locale: StudioLocale, href: (target: StudioLocale) => string): Html {
  const links = STUDIO_LOCALES.map(
    (target) =>
      html`<a href="${href(target)}" hreflang="${target}" title="${STUDIO_LOCALE_NAMES[target]}" class="${target === locale ? "active" : ""}">${target.toUpperCase()}</a>`,
  );
  return html`<span class="dashboard-locale" aria-label="${t(locale, "cc.language")}">${links}</span>`;
}
