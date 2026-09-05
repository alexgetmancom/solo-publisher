// UTC is the default because a wrong one is invisible: a date still renders,
// just in somebody else's day. Callers on the public site pass the Studio's
// site timezone for that language (studio.siteTimezone(locale)).
export function formatDate(value: string, locale = "en-GB", timeZone = "UTC"): string {
  if (!value) return "";
  try {
    return (
      new Intl.DateTimeFormat(locale, {
        timeZone,
        day: "2-digit",
        month: locale === "ru-RU" ? "2-digit" : "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .format(new Date(value))
        // ICU joins the date and the time with a comma in some versions and with
        // the word "at" in others, so the same code rendered two different strings
        // on the container and on a laptop. Drop whichever connector arrived.
        .replace(/,| at /g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
  } catch {
    return value;
  }
}

export function formatRelativeTime(value: string, locale = "en"): string {
  try {
    const diffMs = Date.now() - new Date(value).getTime();
    const absMs = Math.abs(diffMs);
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const rtf = new Intl.RelativeTimeFormat(locale === "ru" ? "ru" : "en", { numeric: "auto" });
    if (absMs < hour) return rtf.format(Math.round(-diffMs / minute), "minute");
    if (absMs < day) return rtf.format(Math.round(-diffMs / hour), "hour");
    return rtf.format(Math.round(-diffMs / day), "day");
  } catch {
    return "";
  }
}

/** The zone's own short name at that moment — "MSK", "EDT", "EST".
 * Derived rather than stored: a zone that observes daylight saving is called
 * something different half the year, and a label typed in once is wrong for
 * that half. */
export function timeZoneLabel(value: string, timeZone: string, locale = "en-GB"): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }).formatToParts(new Date(value));
    return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}
