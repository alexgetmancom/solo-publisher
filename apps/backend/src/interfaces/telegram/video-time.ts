import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { formatZonedDateTime } from "../../foundation/time.js";

/** Telegram presentation of a neutral scheduled timestamp. Reads the configured
 * zone through `formatZonedDateTime` like every other Studio surface: this used to
 * hardcode a deployment zone, so changing this Studio's `timezone` moved post times and
 * silently left video times behind. */
export function formatVideoTime(
  value: string | null,
  locale: StudioLocale,
  config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">,
): string {
  return value ? formatZonedDateTime(value, config.TIMEZONE, config.TIMEZONE_LABEL) : t(locale, "video.time-unset");
}
