/**
 * Theme switching, shared verbatim by the public site and the dashboard.
 *
 * Three modes, cycled by the button: system -> light -> dark -> system. The
 * resolved theme lives in data-theme on <html>; the mode the operator picked
 * lives in data-theme-mode beside it, because "dark" chosen explicitly and
 * "dark" resolved from the OS have to look the same to CSS and different to the
 * button. localStorage holds the mode, and holds nothing while it is system.
 *
 * Both surfaces get it as source text rather than a module: the dashboard is
 * rendered as a string by the backend and never goes through the site's bundler,
 * and the boot half has to be inline and un-deferred on both anyway. Two
 * hand-kept copies had already drifted — the site updated the browser chrome
 * colour and the dashboard did not.
 */

/**
 * Runs before first paint: without it the document renders in the default dark
 * theme and then flips, which reads as a flash. Must stay inline and un-deferred.
 */
export const THEME_BOOT_SCRIPT = `
(() => {
  try {
    const stored = localStorage.getItem("theme");
    const mode = stored === "light" || stored === "dark" ? stored : "system";
    const theme = mode === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : mode;
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-theme-mode", mode);
  } catch {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.setAttribute("data-theme-mode", "system");
  }
})();
`;

/**
 * The click, persistence, and following the OS setting while the mode is system.
 * What the button looks like in each mode is CSS on both surfaces, keyed off
 * data-theme-mode, so this never touches the button's contents.
 */
export const THEME_TOGGLE_SCRIPT = `
(() => {
  const CYCLE = { system: 'light', light: 'dark', dark: 'system' };
  const currentMode = () => {
    const value = document.documentElement.getAttribute('data-theme-mode');
    return value === 'light' || value === 'dark' ? value : 'system';
  };
  const apply = (mode) => {
    const theme = mode === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode;
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-theme-mode', mode);
    // The browser UI colour is a meta tag, not a CSS variable, so it cannot pick
    // the token up on its own — read the resolved value and copy it across.
    const meta = document.querySelector('meta[name="theme-color"]');
    const chrome = getComputedStyle(document.documentElement).getPropertyValue('--browser-chrome').trim();
    if (meta && chrome) meta.setAttribute('content', chrome);
  };
  apply(currentMode());
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-theme-toggle]') : null;
    if (!button) return;
    const next = CYCLE[currentMode()];
    try {
      if (next === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', next);
    } catch {
      // Private mode and blocked storage: the switch still works for this page.
    }
    apply(next);
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (currentMode() === 'system') apply('system');
  });
})();
`;
