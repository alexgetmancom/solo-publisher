import { type Html, html, raw } from "../../../foundation/html.js";
import { t } from "../../../foundation/i18n/index.js";
import type { StudioLocale } from "../../../foundation/locale.js";
import { formatMetricValue } from "./format.js";

type HeroMetric = { value: string; label: string };

/** What both halves of the overview report the same way. `countLabel` is the
 * rendered count, so the raw tally never has to travel alongside it. */
type HeroCommon = {
  views: number;
  /** The part of `views` earned by what was published inside the period. */
  freshViews: number;
  medianViews: number | null;
  countLabel: string;
  normLabel: string;
  contextLabel: string;
  paceLabel: string | null;
  projectionViews: number | null;
  progressPercent: number | null;
};

/** The kind travels with the numbers, so no caller has to pass it a second time
 * and no renderer has to cast to reach the half it was handed. */
export type HeroMetrics =
  | (HeroCommon & {
      kind: "text";
      reactions: number;
      replies: number;
      reposts: number;
      engagementRate: number | null;
    })
  | (HeroCommon & {
      kind: "video";
      completionRate: number | null;
      averageWatchTimeMs: number | null;
      subscribers: number | null;
    });

export function renderHeroCard(metrics: HeroMetrics, locale: StudioLocale): Html {
  const isText = metrics.kind === "text";
  const count = metrics.countLabel;
  const label = t(locale, isText ? "cc.hero.text" : "cc.hero.video");
  const color = isText ? "var(--series-text)" : "var(--series-video)";
  const ariaLabel = t(locale, isText ? "cc.hero.text-aria" : "cc.hero.video-aria");
  const progress = metrics.progressPercent === null ? 0 : Math.min(100, Math.max(0, metrics.progressPercent)) / 100;
  const delta = formatDelta(metrics.views, metrics.medianViews);
  // The rule under the heading is the goal gauge, and it turns green once the
  // norm is passed — the same signal the pace label spells out in words.
  const beatNorm = metrics.progressPercent !== null && metrics.progressPercent >= 100;
  return html`<article class="hero-card overview-hero-card hero-card--${metrics.kind}" style="--hero-progress:${progress.toFixed(3)}" aria-label="${ariaLabel}">
    <div class="hero-card__heading overview-hero-card__heading${beatNorm ? " overview-hero-card__heading--win" : ""}"><i style="background:${color}"></i><strong>${label}</strong><span>${count}</span></div>
    <div class="hero-card__primary overview-hero-card__primary">
      <div class="hero-card__views overview-hero-card__views"><strong>${formatMetricValue(metrics.views)}</strong>${delta ? html`<em class="hero-card__delta ${deltaClass(metrics.views, metrics.medianViews)}">${delta}</em>` : ""}</div>
      <div class="hero-card__median overview-hero-card__median"><span>${metrics.normLabel} · <b>${formatOptionalMetric(metrics.medianViews)}</b></span></div>
    </div>
    <div class="overview-hero-card__split">${splitLabel(metrics.views, metrics.freshViews, locale)}</div>
    <div class="overview-hero-card__context"><span>${metrics.contextLabel}</span>${metrics.paceLabel ? html`<span class="overview-hero-card__pace ${metrics.progressPercent !== null && metrics.progressPercent >= 100 ? "overview-hero-card__pace--positive" : ""}">${metrics.paceLabel}</span>` : ""}</div>
  </article>`;
}

export function renderHeroMicroMetrics(metrics: HeroMetrics, locale: StudioLocale): Html {
  const values: HeroMetric[] =
    metrics.kind === "text"
      ? [
          { value: formatMetricValue(metrics.reactions), label: t(locale, "cc.hero.reactions") },
          { value: formatMetricValue(metrics.replies), label: t(locale, "cc.hero.replies") },
          { value: formatMetricValue(metrics.reposts), label: t(locale, "cc.hero.reposts") },
          { value: formatRate(metrics.engagementRate), label: t(locale, "cc.hero.engagement") },
        ]
      : [
          { value: formatCompletionRate(metrics.completionRate), label: t(locale, "cc.hero.completions") },
          { value: formatSeconds(metrics.averageWatchTimeMs, locale), label: t(locale, "cc.hero.avg-time") },
          { value: formatSigned(metrics.subscribers), label: t(locale, "cc.hero.subscribers") },
        ];
  return html`<div class="overview-micro">${values.map(
    (item, index) =>
      html`${index ? raw('<span class="overview-micro__separator">·</span>') : ""}<span><b>${item.value}</b> ${item.label}</span>`,
  )}</div>`;
}

/**
 * The one number splits in two: what this period's own publications earned, and
 * what everything published earlier earned during it. Together they are the
 * headline figure, so the reader can tell a strong day from a long tail.
 */
function splitLabel(views: number, freshViews: number, locale: StudioLocale): Html {
  if (views <= 0) return html``;
  const fresh = Math.max(0, Math.min(freshViews, views));
  const catalogue = views - fresh;
  return html`<span><b>${formatMetricValue(fresh)}</b> ${t(locale, "cc.hero.fresh")}</span><span class="overview-hero-card__split-separator">·</span><span><b>${formatMetricValue(catalogue)}</b> ${t(locale, "cc.hero.catalogue")}</span>`;
}

function formatOptionalMetric(value: number | null): string {
  return value === null ? "—" : formatMetricValue(value);
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

function formatCompletionRate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatSeconds(value: number | null, locale: StudioLocale): string {
  return value === null ? "—" : t(locale, "cc.hero.seconds", { value: (value / 1_000).toFixed(1) });
}

function formatSigned(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "−"}${formatMetricValue(Math.abs(value))}`;
}

function formatDelta(value: number, median: number | null): string {
  // A zero for the selected period is incomplete data, not a meaningful
  // performance change. Showing -100% or 0% here creates noise until metrics
  // arrive.
  if (value === 0) return "";
  if (median === null) return "—";
  if (median === 0) return value > 0 ? "+100%" : "0%";
  const delta = Math.round(((value - median) / median) * 100);
  return `${delta >= 0 ? "+" : "−"}${Math.abs(delta)}%`;
}

function deltaClass(value: number, median: number | null): string {
  if (median === null) return "hero-card__delta--flat";
  return value >= median ? "hero-card__delta--up" : "hero-card__delta--down";
}
