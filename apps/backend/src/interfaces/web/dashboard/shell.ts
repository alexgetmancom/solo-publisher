import { THEME_BOOT_SCRIPT, THEME_TOGGLE_SCRIPT } from "../../../../../../shared/theme-script.js";
import { type Html, html, raw } from "../../../foundation/html.js";
import type { StudioLocale } from "../../../foundation/locale.js";
import { SHELL_SCRIPT } from "./shell-script.js";
import { SHELL_CSS } from "./shell-styles.js";
import { DASHBOARD_THEME_CSS } from "./theme.js";

/** The document every dashboard screen is served inside. The stylesheet and the
 * client script are siblings rather than 600 lines quoted inline here, so this
 * file stays a page skeleton one screen tall. Both are still interpolated into
 * the page, which therefore ships as one request with no extra round trip. */
export function renderDashboardShell(body: Html, locale: StudioLocale): string {
  return String(html`<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Command Center</title>
  <script>${raw(THEME_BOOT_SCRIPT)}</script>
  <style>
    ${raw(DASHBOARD_THEME_CSS)}
    ${raw(SHELL_CSS)}
  </style>
</head>
<body>
<main>
  ${body}
</main>
<script>
${raw(THEME_TOGGLE_SCRIPT)}
${raw(SHELL_SCRIPT)}
</script>
</body>
</html>`);
}
