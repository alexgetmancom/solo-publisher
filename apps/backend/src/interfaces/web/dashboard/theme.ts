/**
 * DASHBOARD DESIGN TOKENS
 *
 * NAME CONTRACT. The site declares the same token names in
 * apps/web/src/shared/styles/tokens.css. The values here are deliberately
 * different: the site is editorial (crimson accent, airy, photographic), the
 * dashboard is a dense ops tool that needs higher contrast and a blue accent so
 * that status colours stay unambiguous. What is shared is the vocabulary and
 * the switching mechanism, not the look.
 *
 * The overlap is enforced by apps/backend/tests/themeContract.test.ts, which
 * parses both files: every name in SHARED_THEME_TOKENS must be declared here
 * and on the site, in both themes. Renaming a token in one place fails there
 * rather than silently leaving the other half unstyled.
 *
 * SWITCHING. Same as the site, and the same source: shared/theme-script.ts sets
 * data-theme on <html> before first paint, plus data-theme-mode holding which of
 * the three modes (system, light, dark) the operator picked. System is the
 * default and stores nothing; an explicit choice is stored in localStorage. The
 * glyph on the button is CSS keyed off data-theme-mode, in the shell stylesheet.
 *
 * On the palette: the values below collapse what used to be roughly twenty
 * near-identical greys (#d7dee8, #d8e0e9, #d6dee8, #dce4ed ...) into one text
 * scale. Those variants were drift, not design — nobody could see the
 * difference, but every new rule picked a slightly different hex.
 */

/**
 * Tokens both surfaces must implement. Adding a name here without adding it to
 * both stylesheets fails the contract test.
 */
export const SHARED_THEME_TOKENS = [
  "bg-color",
  "surface",
  "surface-raised",
  "text-header",
  "text-main",
  "text-secondary",
  "text-muted",
  "accent",
  "accent-strong",
  "accent-contrast",
  "accent-glow",
  "border",
  "border-hover",
  "border-soft",
  "danger",
  "link",
] as const;

export const DASHBOARD_THEME_CSS = `
:root,
html[data-theme="dark"] {
  color-scheme: dark;

  --bg-color: #050607;
  --surface: #161b22;
  --surface-raised: #21262d;
  --surface-sunken: #0d1117;

  --text-header: #f5f8fc;
  --text-main: #d7dee8;
  --text-secondary: #9aa6b5;
  --text-muted: #8b949e;

  --accent: #58a6ff;
  --accent-strong: #1f6feb;
  --accent-contrast: #ffffff;
  --accent-glow: rgba(76, 152, 255, 0.16);
  --accent-soft-text: #a9d0ff;

  --border: #30363d;
  --border-hover: #8b949e;
  --border-soft: #1c222a;

  --danger: #ff7b72;
  --danger-strong: #ff4e75;
  --success: #63d48a;
  --link: #58a6ff;

  --total-bg: #1a3a5c;
  --total-text: #7dd3fc;
  --total-border: #3b82f6;

  --scrim-soft: rgba(255, 255, 255, 0.025);
  --tooltip-shadow: rgba(0, 0, 0, 0.35);

  /* Chart series. These are data, not chrome: they must stay distinguishable
   * from each other AND readable against the surface, which is why the light
   * theme darkens them rather than reusing the same hexes. */
  --series-views: #3b8dff;
  --series-likes: #ff4e75;
  --series-comments: #a5d6ff;
  --series-replies: #b7bec9;
  --series-previous: #aeb8c8;

  /* Text and video are the two halves of the unified overview, so they need one
   * hue each, held apart from status colour. Red is not available: it already
   * means "fell" in a delta and "failed" on a target, and the KPI cards put a
   * delta directly beside the series figure. */
  --series-text: #3b8dff;
  --series-video: #b083ff;
}

html[data-theme="light"] {
  color-scheme: light;

  --bg-color: #ffffff;
  --surface: #ffffff;
  --surface-raised: #f7f7fa;
  --surface-sunken: #fbfbfc;

  --text-header: #0b1219;
  --text-main: #1f2933;
  --text-secondary: #55606d;
  --text-muted: #6b7683;

  --accent: #0969da;
  --accent-strong: #0969da;
  --accent-contrast: #ffffff;
  --accent-glow: rgba(9, 105, 218, 0.12);
  --accent-soft-text: #0550ae;

  --border: #d0d7de;
  --border-hover: #8c959f;
  --border-soft: #e4e8ec;

  --danger: #cf222e;
  --danger-strong: #a40e26;
  --success: #12a150;
  --link: #0969da;

  --total-bg: #ddf0ff;
  --total-text: #0550ae;
  --total-border: #3b82f6;

  --scrim-soft: rgba(9, 30, 66, 0.03);
  --tooltip-shadow: rgba(31, 41, 51, 0.18);

  --series-views: #1668d6;
  --series-likes: #d61f4a;
  --series-comments: #2a9d8f;
  --series-replies: #6b7683;
  --series-previous: #98a2b0;

  --series-text: #2f6bff;
  --series-video: #7b52f5;
}
`;

/** Markup for the switch. Sits in the tab bar, next to the period controls. */
export function dashboardThemeToggleHtml(label: string): string {
  return `<button type="button" class="theme-toggle" data-theme-toggle aria-label="${label}"></button>`;
}
