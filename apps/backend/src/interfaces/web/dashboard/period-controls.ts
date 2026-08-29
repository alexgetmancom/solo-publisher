import { type Html, html } from "../../../foundation/html.js";
import { t } from "../../../foundation/i18n/index.js";
import type { StudioLocale } from "../../../foundation/locale.js";
import { monthShortName, zonedDateParts } from "../../../foundation/time.js";
import { localeQuery } from "./locale-links.js";

const PERIODS = [1, 7, 30, 90, 365] as const;

/**
 * Period and date, as one quiet cluster on the right edge.
 *
 * The five periods used to sit out as a permanent segmented control, which
 * made a filter that changes maybe twice a day the second-heaviest thing in
 * the header. It collapses to the current choice; the rest are one click away
 * in the menu.
 */
export function renderPeriodControls(
  locale: StudioLocale,
  weekOffset: number,
  periodDays: number,
  timeZone: string,
  view?: string,
  videoView?: string,
  extraQuery = "",
): Html {
  const [start, end] = rollingPeriodDates(weekOffset, periodDays, timeZone);
  const viewParam = view ? `&view=${encodeURIComponent(view)}` : "";
  const videoViewParam = videoView ? `&video_view=${encodeURIComponent(videoView)}` : "";
  const filterParam = `${viewParam}${videoViewParam}${extraQuery}${localeQuery(locale)}`;
  const periodLabel = (days: number) => (days === 365 ? t(locale, "cc.period.year") : t(locale, "cc.period.days", { days }));
  const quickOptions = PERIODS.filter((days) => days <= 30).map(
    (days) =>
      html`<a class="period-quick-link${days === periodDays ? " active" : ""}" href="/command-center?period=${days}&week_offset=${weekOffset}${filterParam}">${periodLabel(days)}</a>`,
  );
  const longOptions = PERIODS.filter((days) => days > 30).map(
    (days) =>
      html`<a class="${days === periodDays ? "active" : ""}" href="/command-center?period=${days}&week_offset=${weekOffset}${filterParam}">${periodLabel(days)}</a>`,
  );
  const previous = html`<a class="period-nav" href="/command-center?period=${periodDays}&week_offset=${weekOffset + 1}${filterParam}" aria-label="${t(locale, "cc.period.previous")}">‹</a>`;
  const next =
    weekOffset > 0
      ? html`<a class="period-nav" href="/command-center?period=${periodDays}&week_offset=${weekOffset - 1}${filterParam}" aria-label="${t(locale, "cc.period.next")}">›</a>`
      : html`<span class="period-nav muted">›</span>`;
  const longMenu = longOptions.length
    ? html`<details class="period-menu"><summary class="period-menu__toggle" aria-label="${t(locale, "cc.period.more")}">${periodDays > 30 ? periodLabel(periodDays) : t(locale, "cc.period.more")}<i class="caret">▾</i></summary><div class="period-menu__list">${longOptions}</div></details>`
    : "";
  return html`<div class="dashboard-nav__controls"><div class="period-quick" role="group" aria-label="${t(locale, "cc.period.group")}">${quickOptions}</div>${longMenu}<div class="period-range">${previous}<span>${shortDateRange(start, end, locale)}</span>${next}</div></div>`;
}

/** Returns UTC-midnight dates whose calendar fields carry the configured zone. */
export function rollingPeriodDates(offset: number, days: number, timeZone: string): [Date, Date] {
  const shiftedNow = new Date(Date.now() - offset * days * 86_400_000);
  const endParts = zonedDateParts(shiftedNow, timeZone);
  const end = new Date(Date.UTC(endParts.year, endParts.month - 1, endParts.day));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return [start, end];
}

function shortDateRange(start: Date, end: Date, locale: StudioLocale): string {
  const month = (date: Date) => monthShortName(locale, date.getUTCMonth() + 1);
  if (start.getTime() === end.getTime()) return `${end.getUTCDate()} ${month(end)}`;
  if (start.getUTCMonth() === end.getUTCMonth()) return `${start.getUTCDate()}–${end.getUTCDate()} ${month(end)}`;
  return `${start.getUTCDate()} ${month(start)} – ${end.getUTCDate()} ${month(end)}`;
}
