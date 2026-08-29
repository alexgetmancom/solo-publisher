import { type Html, html } from "../../../foundation/html.js";
import { t } from "../../../foundation/i18n/index.js";
import type { StudioLocale } from "../../../foundation/locale.js";
import { formatMetricValue } from "./format.js";

/** Compact daily bars for the editorial overview.
 *
 * Each half of the overview scales to its own numbers: this runs once per track,
 * over that track's days only, so text is never drawn against video's height.
 *
 * The ceiling is the best day, until one day stands so far above the rest that
 * following it would flatten the month behind it — a single viral post against
 * a typical day two orders of magnitude smaller. Past that the scale sits on the
 * ninetieth percentile instead, which an outlier cannot drag with it the way the
 * mean can, and the outlying days are clipped and marked as clipped. The tooltip
 * always reports what a day earned, whatever height it was drawn at.
 *
 * HARD_CAP is the absolute lid: above it two periods stop being comparable at a
 * glance, which is most of what this strip is for. */
const HARD_CAP = 50_000;
/** How far above the ninetieth percentile the best day has to stand before it
 * counts as an outlier rather than as the top of the range. */
const OUTLIER_RATIO = 1.5;
/** Breathing room over the percentile, so the tallest kept bar is not welded to
 * the cap line. */
const HEADROOM = 1.15;

function sparkCeiling(values: number[]): number {
  // A day with no reach says nothing about the scale the rest need, and a
  // period that has not started yet is mostly those.
  const active = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (!active.length) return 10;
  const peak = active.at(-1) ?? 0;
  const p90 = quantile(active, 0.9);
  const ceiling = peak <= p90 * OUTLIER_RATIO ? peak : p90 * HEADROOM;
  return Math.min(HARD_CAP, Math.max(10, Math.round(ceiling)));
}

function quantile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  if (lower === upper) return lowerValue;
  return lowerValue + ((sorted[upper] ?? lowerValue) - lowerValue) * (position - lower);
}

/**
 * `fresh` is the part of `value` earned by publications of that same day, drawn
 * as a darker foot of the bar. `partial` marks a day still in progress, whose
 * bar is short because the day is, not because the day is bad.
 */
export type OverviewSparkPoint = { label: string; value: number; fresh?: number; partial?: boolean };

export function renderOverviewSparkline(
  points: OverviewSparkPoint[],
  color: string,
  ariaLabel: string,
  leftLabel: string,
  rightLabel: string,
  locale: StudioLocale,
): Html {
  if (!points.length) return html``;

  const width = 560;
  const height = 58;
  const barGap = 3;
  const barWidth = (width - (points.length - 1) * barGap) / points.length;
  const values = points.map((point) => Math.max(0, point.value));
  const average = values.reduce((total, value) => total + value, 0) / values.length;
  const ceiling = sparkCeiling(values);
  const averageY = height - (Math.min(average, ceiling) / ceiling) * height;
  const bars = points.map((point, index) => {
    const value = values[index] ?? 0;
    const overCap = value > ceiling;
    const visibleValue = Math.min(value, ceiling);
    const barHeight = Math.max(1, (visibleValue / ceiling) * height);
    const x = index * (barWidth + barGap);
    const y = height - barHeight;
    const opacity =
      overCap || index === points.length - 1 ? 1 : Math.max(0.24, 0.72 - ((points.length - 1 - index) / Math.max(1, points.length)) * 0.35);
    const barClass = `overview-spark__bar${overCap ? " overview-spark__bar--over-cap" : ""}${point.partial ? " overview-spark__bar--partial" : ""}`;
    const fresh = Math.max(0, point.fresh ?? 0);
    // The cap clips how tall the segment is drawn, never what it reports.
    const freshHeight = fresh > 0 ? Math.min(barHeight, Math.max(1, (Math.min(fresh, visibleValue) / ceiling) * height)) : 0;
    const cohort =
      freshHeight > 0
        ? html`<rect class="overview-spark__bar overview-spark__bar--fresh" x="${x.toFixed(2)}" y="${(height - freshHeight).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${freshHeight.toFixed(2)}" rx="2" fill="${color}" opacity="${Math.min(1, opacity + 0.34).toFixed(2)}"/>${
            barHeight - freshHeight > 1.5
              ? html`<line class="overview-spark__cohort" x1="${x.toFixed(2)}" y1="${(height - freshHeight).toFixed(2)}" x2="${(x + barWidth).toFixed(2)}" y2="${(height - freshHeight).toFixed(2)}"/>`
              : ""
          }`
        : "";
    const tooltip = [
      `${point.label} · ${formatMetricValue(value)}`,
      fresh > 0 ? `${t(locale, "cc.overview.new")} ${formatMetricValue(fresh)}` : "",
      point.partial ? t(locale, "cc.overview.partial-day") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return html`<g><rect class="${barClass}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="2" fill="${color}" opacity="${opacity.toFixed(2)}"/>${cohort}<rect class="chart-hit" x="${Math.max(0, x - barGap / 2).toFixed(2)}" y="0" width="${(barWidth + barGap).toFixed(2)}" height="${height}" data-tooltip="${tooltip}"/></g>`;
  });

  return html`<div class="overview-spark">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${ariaLabel}">
      <line class="overview-spark__cap" x1="0" y1="0" x2="${width}" y2="0"/>
      <text class="overview-spark__cap-label" x="${width}" y="9" text-anchor="end">${formatMetricValue(ceiling)}</text>
      <line class="overview-spark__average" x1="0" y1="${averageY.toFixed(2)}" x2="${width}" y2="${averageY.toFixed(2)}"/>
      ${bars}
    </svg>
    <div class="overview-spark__footer"><span>${leftLabel}</span><span>${t(locale, "cc.overview.average")} <b>${formatMetricValue(Math.round(average))}</b> · ${rightLabel} <b>${formatMetricValue(points.at(-1)?.value ?? 0)}</b></span></div>
  </div>`;
}
