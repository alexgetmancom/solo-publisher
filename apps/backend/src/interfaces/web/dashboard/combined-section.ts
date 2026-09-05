import type { PipelineData, PipelinePost } from "../../../analytics/pipeline-payload.js";
import { type DailyReach, emptyReachCounters, type ReachCounters } from "../../../analytics/reach/daily-reach.js";
import { type TextOverview, textDailyReach } from "../../../analytics/reach/text-overview.js";
import { X_CONVERSATION_TARGET } from "../../../analytics/reach/text-reach.js";
import type { XActivityDashboardItem } from "../../../analytics/x-activity-dashboard.js";
import { targetLocale } from "../../../botTargets.js";
import { type Html, html } from "../../../foundation/html.js";
import { t } from "../../../foundation/i18n/index.js";
import type { StudioLocale } from "../../../foundation/locale.js";
import { isCurrentCalendarDay } from "../../../foundation/time.js";
import { ORDERED_TARGETS, PLATFORM_ICONS, platformKey, VIDEO_PLATFORM_ICON_KEYS } from "./assets.js";
import { type OverviewSparkPoint, renderOverviewSparkline } from "./chart.js";
import {
  emptyTotals,
  formatPlatformDelta,
  medianOfDays,
  metricProgress,
  percentDelta,
  periodContextLabel,
  periodCountLabel,
  periodNormLabel,
  periodPaceLabel,
  periodProjection,
  scaleTotals,
  type Totals,
} from "./combined-math.js";
import { formatMetricValue } from "./format.js";
import { type HeroMetrics, renderHeroCard, renderHeroMicroMetrics } from "./hero-section.js";
import { localeQuery } from "./locale-links.js";
import { renderOverviewPublicationList } from "./table.js";
import type { VideoContentItem, VideoOverview } from "./video-overview.js";
import { additionalXActivityPosts } from "./x-activity-posts.js";

/**
 * The unified overview: text and video on one screen, under one period.
 *
 * The two feeds are equal here, which rules out the obvious shortcut of adding
 * them together. A Shorts view and a Threads view are not the same unit — one
 * is an autoplay in a scrolling feed, the other a deliberate read — so a single
 * "104.9k views" figure would be dominated by video and its delta would report
 * video's day as the whole day's. Every KPI therefore carries the two numbers
 * side by side, each with its own comparison, and the sum is never shown.
 */

export type PlatformMetric = "reach" | "followers";

type TextPlatformFollowers = { key: string; label: string; followers: number | null };

export type CombinedSectionInput = {
  data: PipelineData | null;
  previousData: PipelineData | null;
  xItems: XActivityDashboardItem[];
  previousXItems: XActivityDashboardItem[];
  dayComparisonData?: PipelineData | null;
  video: VideoOverview;
  previousVideo: VideoOverview;
  dayComparisonVideo?: VideoOverview | null;
  /** Thirty-day history immediately before the selected period, used by the
   * hero cards as a comparable median baseline. */
  medianData?: PipelineData | null;
  medianXItems?: XActivityDashboardItem[];
  medianVideo?: VideoOverview | null;
  /** Daily reach per destination over the chart's whole window. */
  textReach: TextOverview;
  /** The video track's daily reach over that same window. */
  videoReach: Record<string, DailyReach>;
  followers: TextPlatformFollowers[];
  rangeStart: Date;
  rangeEnd: Date;
  periodDays: number;
  weekOffset: number;
  timeZone: string;
  platformMetric: PlatformMetric;
  /** Restricts the text half when a platform row is selected. */
  textTargetIds?: readonly string[] | undefined;
  /** The selected text platform, if that half is filtered. */
  textView?: string | undefined;
  /** The selected video destination, if that half is filtered. */
  videoView?: string | undefined;
  /** The languages each half publishes in, so a Studio that has one is not
   * drawn with an empty column for the language it never had. */
  textLocales: readonly string[];
  videoLocales: readonly string[];
};

/** The locale columns one half is drawn in: the languages it publishes, plus any
 * language that still has something to report. The first half of that rule is
 * what spares a one-language Studio a permanently empty column; the second
 * keeps a since-disconnected channel's reach on screen instead of dropping it
 * out of a legend whose bar still counts it. */
function localeColumns(trackLocales: readonly string[], rows: OverviewPlatformRow[]): string[] {
  const reporting = new Set(
    rows.flatMap((row) => (row.locale && (row.views > 0 || row.followers !== null) ? [row.locale.toLowerCase()] : [])),
  );
  return ["ru", "en"].filter((locale) => trackLocales.includes(locale) || reporting.has(locale));
}

const TEXT_COLOR = "var(--series-text)";
const VIDEO_COLOR = "var(--series-video)";

export function renderCombinedSection(input: CombinedSectionInput, locale: StudioLocale): Html {
  const { periodDays } = input;
  const posts = input.data?.posts ?? [];
  const extraX = additionalXActivityPosts(posts, input.xItems);

  const previousVideoTotals =
    periodDays === 1
      ? medianDailyVideoTotals(input.previousVideo, 30)
      : {
          views: input.previousVideo.totals.views,
          reactions: input.previousVideo.totals.reactions,
          replies: input.previousVideo.totals.replies,
        };
  const textHero = textHeroMetrics(input, posts.length, locale);
  const videoHero = videoHeroMetrics(input, periodDays, previousVideoTotals, locale);
  // Both halves stay on screen whatever is filtered: a filter narrows its own
  // half, it does not take the other one away.
  const textColumn = renderOverviewColumn(
    {
      hero: textHero,
      color: TEXT_COLOR,
      titleKey: "cc.overview.text",
      viewParam: input.textView ? ["view", input.textView] : null,
      trackLocales: input.textLocales,
      showMetricFilter: true,
      publications: { posts: input.textView === "x" ? [...posts, ...extraX] : posts, targetIds: selectedTextTargetIds(input), videos: [] },
    },
    input,
    locale,
  );
  const videoColumn = renderOverviewColumn(
    {
      hero: videoHero,
      color: VIDEO_COLOR,
      titleKey: "cc.overview.video",
      viewParam: input.videoView ? ["video_view", input.videoView] : null,
      trackLocales: input.videoLocales,
      showMetricFilter: false,
      publications: { posts: [], targetIds: [], videos: input.video.items },
    },
    input,
    locale,
  );

  // Both halves reserve the same number of destination rows — the tallest of the
  // four columns — so their publication lists start on one line without either
  // side padding out a fixed block of empty space.
  const platformRowCount = Math.max(
    1,
    ...[
      { rows: overviewPlatformRows(input, "text", locale), locales: input.textLocales },
      { rows: overviewPlatformRows(input, "video", locale), locales: input.videoLocales },
    ].flatMap(({ rows, locales }) =>
      localeColumns(locales, rows).map(
        (locale) => rows.filter((row) => row.locale?.toLowerCase() === locale && (row.views > 0 || row.followers !== null)).length,
      ),
    ),
  );
  return html`<section class="pipeline-overview" style="--platform-rows:${Math.min(PLATFORM_SLOTS, platformRowCount)}">
    <div class="overview-split">
      ${textColumn}
      ${videoColumn}
    </div>
    <div class="chart-tooltip overview-chart-tooltip" hidden></div>
  </section>`;
}

type OverviewKind = "text" | "video";
type OverviewPlatformRow = {
  key: string;
  label: string;
  locale: string | null;
  icon: Html;
  views: number;
  followers: number | null;
  delta: number | null;
  href: string | null;
  /** This row is the filter currently applied to its half. */
  active?: boolean;
  secondary?: boolean;
};

/** Everything one half of the overview does differently, named once by its
 * caller. The renderer below then draws a track without asking which one it is. */
type OverviewTrack = {
  hero: HeroMetrics;
  color: string;
  titleKey: "cc.overview.text" | "cc.overview.video";
  /** The query parameter this half uses to carry its own drill-down, if it has one. */
  viewParam: readonly [string, string] | null;
  trackLocales: readonly string[];
  showMetricFilter: boolean;
  publications: { posts: PipelinePost[]; targetIds: string[]; videos: VideoContentItem[] };
};

function renderOverviewColumn(track: OverviewTrack, input: CombinedSectionInput, locale: StudioLocale): Html {
  const kind = track.hero.kind;
  const history = overviewHistory(input, kind);
  const platformRows = overviewPlatformRows(input, kind, locale);
  // The list loader is per half: each one asks only for its own publications.
  const moreParams = new URLSearchParams({ period: String(input.periodDays), week_offset: String(input.weekOffset), track: kind });
  if (locale === "en") moreParams.set("locale", "en");
  if (track.viewParam) moreParams.set(track.viewParam[0], track.viewParam[1]);
  const moreUrl = `/api/command-center/publication-details?${moreParams.toString()}`;
  const { posts, targetIds, videos } = track.publications;
  const publicationMarkup = renderOverviewPublicationList(locale, input.textLocales, posts, targetIds, videos, { limit: 4, moreUrl });
  const title = t(locale, track.titleKey);
  const activeRow = platformRows.find((row) => row.active);
  // The filter has to say it is on and how to get out; without that the only way
  // back was editing the URL.
  const filterChip = activeRow?.href
    ? html`<a class="overview-track__filter" href="${activeRow.href}" title="${t(locale, "cc.overview.remove-filter")}">${activeRow.label}<i>×</i></a>`
    : "";
  const historyLabel = t(locale, input.periodDays === 1 ? "cc.overview.history-30" : "cc.overview.period-start");
  const historyRightLabel = t(locale, input.periodDays === 1 ? "cc.overview.today" : "cc.overview.period-end");
  return html`<section class="overview-track overview-track--${kind}">
    ${filterChip}
    ${renderHeroCard(track.hero, locale)}
    ${renderOverviewSparkline(history, track.color, t(locale, "cc.overview.views-over-time", { track: title }), historyLabel, historyRightLabel, locale)}
    ${renderHeroMicroMetrics(track.hero, locale)}
    ${renderOverviewPlatforms(input, track, platformRows, locale)}
    <div class="overview-publications" id="overview-publications-${kind}">
      <div class="overview-kicker">${t(locale, "cc.overview.publications")}</div>
      ${publicationMarkup}
    </div>
  </section>`;
}

function renderOverviewPlatforms(
  input: CombinedSectionInput,
  track: OverviewTrack,
  rows: OverviewPlatformRow[],
  locale: StudioLocale,
): Html {
  const { color, showMetricFilter, trackLocales } = track;
  const metricValue = (row: OverviewPlatformRow): number | null => (input.platformMetric === "reach" ? row.views : row.followers);
  const total = rows.reduce((sum, row) => sum + (metricValue(row) ?? 0), 0);
  const localeTotal = (locale: string) =>
    rows.reduce((sum, row) => sum + (row.locale?.toLowerCase() === locale ? (metricValue(row) ?? 0) : 0), 0);
  const localeShare = (value: number) => (total > 0 ? Math.round((value / total) * 100) : 0);
  const segments =
    total > 0
      ? rows.map((row, index) => {
          const value = metricValue(row) ?? 0;
          if (value <= 0) return "";
          const opacity = Math.max(0.2, 1 - index * 0.2);
          const share = (value / total) * 100;
          const tooltip = `${row.label}${row.locale ? ` ${row.locale.toUpperCase()}` : ""} · ${formatMetricValue(value)} · ${share.toFixed(1)}%${row.delta === null ? "" : ` · ${formatPlatformDelta(row.delta)}`}`;
          return html`<i data-tooltip="${tooltip}" style="width:${share.toFixed(3)}%;background:${color};opacity:${opacity.toFixed(2)}"></i>`;
        })
      : html`<i class="overview-platforms__empty-segment" style="width:100%;background:${color}"></i>`;
  // The bar already splits the period RU from EN, so the legend under it is read
  // the same way: each side lists its own destinations, largest first. The
  // locale badge that used to sit on every row is gone with it — the column it
  // stands in is the locale. Three per side is the whole legend; the bar keeps
  // naming every destination in its hover text.
  const columns = localeColumns(trackLocales, rows);
  const ranked = input.platformMetric === "reach" ? rows : rows.filter((row) => !row.secondary);
  const renderRow = (row: OverviewPlatformRow): Html => {
    const value = metricValue(row);
    const formatted = value === null ? "—" : formatMetricValue(value);
    const delta = input.platformMetric === "reach" ? formatPlatformDelta(row.delta) : "";
    const body = html`<span class="overview-platform__icon" style="color:${color}">${row.icon}</span><strong>${formatted}</strong><span class="overview-platform__delta ${row.delta !== null && row.delta >= 0 ? "overview-platform__delta--up" : "overview-platform__delta--down"}">${delta || "\u00a0"}</span>`;
    const className = `overview-platform${row.active ? " overview-platform--active" : ""}`;
    const title = row.active ? `${row.label} · ${t(locale, "cc.overview.remove-filter")}` : row.label;
    return row.href
      ? html`<a class="${className}" href="${row.href}" title="${title}" aria-label="${title}" aria-pressed="${row.active === true}">${body}</a>`
      : html`<div class="${className}" title="${title}" aria-label="${title}">${body}</div>`;
  };
  // The columns rank destinations that have something to report; the ones with
  // neither reach nor an audience wait behind the expander rather than pushing a
  // live destination out of the top three.
  const ofLocale = (locale: string) => ranked.filter((row) => row.locale?.toLowerCase() === locale);
  const live = (row: OverviewPlatformRow) => row.views > 0 || row.followers !== null;
  const shown = (locale: string) => ofLocale(locale).filter(live).slice(0, PLATFORM_SLOTS);
  const platformRows = columns.map((locale) => html`<div class="overview-platforms__column">${shown(locale).map(renderRow)}</div>`);
  // Everything the two columns had no room for, on demand. Without it the
  // smaller destinations would be reachable only through the bar's hover text.
  const hidden = (locale: string) => {
    const visible = new Set(shown(locale).map((row) => row.key));
    return ofLocale(locale).filter((row) => !visible.has(row.key));
  };
  const restRows = columns.map((locale) => html`<div class="overview-platforms__column">${hidden(locale).map(renderRow)}</div>`);
  const rest = columns.reduce((sum, locale) => sum + hidden(locale).length, 0);
  const expand = rest
    ? html`<details class="overview-platforms__all"><summary aria-label="${t(locale, "cc.overview.all-platforms")}" title="${t(locale, "cc.overview.all-platforms")}">+<span>${rest}</span></summary><div class="overview-platforms__all-list">${restRows}</div></details>`
    : "";
  const filter = showMetricFilter
    ? renderPlatformMetricFilter(input.platformMetric, input.periodDays, input.weekOffset, locale, input.textView, input.videoView)
    : "";
  // The figures ride above the bar and the RU/EN labels below it, where they
  // head the two columns of destinations as well: one label now names its half
  // of the bar and its half of the legend at once. The metric switch keeps the
  // middle of the top line — it is a real filter, not decoration.
  // One language means one column: the figure, the label and the destinations
  // under them all count once. A second, permanently empty half used to be
  // drawn for a Studio that had never connected the language it stood for.
  const legend = columns.map((key, index) => {
    const value = localeTotal(key);
    const share = `${localeShare(value)}%`;
    const amount = html`<b>${formatMetricValue(value)}</b>`;
    return index === 0 ? html`<span>${amount} · ${share}</span>` : html`<span>${share} · ${amount}</span>`;
  });
  const legendBody = legend.length > 1 ? html`${legend[0]}${filter}${legend[1]}` : html`${legend[0] ?? ""}${filter}`;
  const labels = columns.map((key) => html`<span>${key.toUpperCase()}</span>`);
  return html`<div class="overview-platforms" style="--locale-columns:${Math.max(1, columns.length)}">
    <div class="overview-platforms__legend">${legendBody}</div>
    <div class="overview-platforms__bar">${segments}</div>
    <div class="overview-platforms__bar-labels">${labels}${expand}</div>
    <div class="overview-platforms__rows">${platformRows}</div>
  </div>`;
}

function overviewPlatformRows(input: CombinedSectionInput, kind: OverviewKind, locale: StudioLocale): OverviewPlatformRow[] {
  const byViews = (left: OverviewPlatformRow, right: OverviewPlatformRow) =>
    input.platformMetric === "reach" ? right.views - left.views : (right.followers ?? -1) - (left.followers ?? -1);
  // Every row is a filter switch for its own half, and the row already selected
  // switches it back off. Nothing else on the page moves.
  const filterHref = (parameter: "view" | "video_view", key: string, active: boolean) => {
    const params = new URLSearchParams({ period: String(input.periodDays), week_offset: String(input.weekOffset) });
    const text = parameter === "view" ? (active ? undefined : key) : input.textView;
    const video = parameter === "video_view" ? (active ? undefined : key) : input.videoView;
    if (text) params.set("view", text);
    if (video) params.set("video_view", video);
    if (input.platformMetric === "followers") params.set("metric", "followers");
    if (locale === "en") params.set("locale", "en");
    return `/command-center?${params.toString()}`;
  };

  if (kind === "video") {
    return input.video.platforms
      .map((platform) => {
        const previous = input.periodDays === 1 ? (input.dayComparisonVideo?.platforms ?? []) : input.previousVideo.platforms;
        const previousRow = previous.find(
          (item) => item.target === platform.target && item.locales.join(",") === platform.locales.join(","),
        );
        const isActive = input.videoView === `${platform.target}:${(platform.locales[0] ?? "").toLowerCase()}`;
        return {
          key: `${platform.target}:${platform.locales.join(",")}`,
          label: platform.label,
          locale: platform.locales[0] ?? null,
          icon: PLATFORM_ICONS[VIDEO_PLATFORM_ICON_KEYS[platform.target] ?? ""] ?? html``,
          views: platform.views,
          followers: platform.followers,
          delta: previousRow ? percentDelta(platform.views, previousRow.views) : null,
          href: filterHref("video_view", `${platform.target}:${(platform.locales[0] ?? "").toLowerCase()}`, isActive),
          active: isActive,
          secondary: false,
        };
      })
      .sort(byViews);
  }

  // The text rows read the same daily reach the bars do, so a destination's
  // number is what it earned in the period, not the lifetime of what it
  // published in it — and the rows now add up to the hero figure above them.
  const currentKeys = dayKeys(input.rangeEnd, input.periodDays);
  const previousEnd = new Date(input.rangeEnd);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - input.periodDays);
  const previousKeys = dayKeys(previousEnd, input.periodDays);
  const textTargetIds = selectedTextTargetIds(input);
  const reachOf = (target: string, keys: readonly string[]) => sumDays(input.textReach.byTarget[target] ?? {}, keys).views;
  const followersByKey = new Map(input.followers.map((platform) => [platform.key, platform]));
  // The declared catalogue, not just what has data: a destination that published
  // nothing this period is still one of this Studio's destinations, and the
  // expander is where it belongs.
  const keys = [
    ...new Set([
      ...ORDERED_TARGETS.map((target) => target.id),
      ...input.followers.map((platform) => platform.key),
      ...Object.keys(input.textReach.byTarget),
    ]),
  ].filter((key) => textTargetIds.includes(key));
  return keys
    .map((key) => {
      const known = ORDERED_TARGETS.find((target) => target.id === key);
      const followers = followersByKey.get(key);
      return {
        key,
        label: followers?.label ?? known?.label ?? key,
        locale: targetLocale(key) ?? known?.locale ?? null,
        icon: PLATFORM_ICONS[key.startsWith("threads") ? "threads" : platformKey(key)] ?? html``,
        views: reachOf(key, currentKeys),
        followers: followers?.followers ?? null,
        delta: percentDelta(reachOf(key, currentKeys), reachOf(key, previousKeys)),
        href: filterHref("view", key, input.textView === key),
        active: input.textView === key,
        secondary: SECONDARY_TEXT_TARGETS.has(key),
      };
    })
    .sort(byViews);
}

function selectedTextTargetIds(input: CombinedSectionInput): string[] {
  return input.textTargetIds ? [...input.textTargetIds] : ORDERED_TARGETS.map((target) => target.id);
}

/**
 * The bars, for either track.
 *
 * Both feeds arrive here as the same daily map, so there is nothing left to
 * branch on: the shape of the chart is a property of the period, not of the
 * medium.
 */
function overviewHistory(input: CombinedSectionInput, kind: OverviewKind): OverviewSparkPoint[] {
  const daily: Record<string, DailyReach> =
    kind === "text" ? textDailyReach(input.textReach, selectedTextTargetIds(input)) : input.videoReach;
  // Only the trailing bar can be a day still in progress, and only when the
  // selected period actually ends today.
  const openEnded = isCurrentCalendarDay(input.rangeEnd, input.timeZone);
  const keys = input.periodDays === 1 ? dayKeys(input.rangeEnd, 30) : dayKeys(input.rangeEnd, input.periodDays);
  return keys.map((key, index) => {
    const day = daily[key];
    return { label: key, value: day?.views ?? 0, fresh: day?.freshViews ?? 0, partial: index === keys.length - 1 && openEnded };
  });
}

/** The `count` calendar keys ending at `end`, in the zone's own calendar. */
function dayKeys(end: Date, count: number): string[] {
  const keys: string[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const day = new Date(end);
    day.setUTCDate(day.getUTCDate() - index);
    keys.push(day.toISOString().slice(0, 10));
  }
  return keys;
}

/** Sums a daily map over a set of days. */
function sumDays(daily: Record<string, DailyReach>, keys: readonly string[]): ReachCounters {
  const totals = emptyReachCounters();
  for (const key of keys) {
    const day = daily[key];
    if (!day) continue;
    totals.views += day.views;
    totals.reactions += day.reactions;
    totals.replies += day.replies;
    totals.reposts += day.reposts;
  }
  return totals;
}

/** Median daily views over the thirty days before the selected period. */
function medianDailyViews(daily: Record<string, DailyReach>, input: CombinedSectionInput): number | null {
  const before = new Date(input.rangeEnd);
  before.setUTCDate(before.getUTCDate() - input.periodDays);
  const values = dayKeys(before, 30).map((key) => ({ views: daily[key]?.views ?? 0, reactions: 0, replies: 0 }));
  if (!values.some((value) => value.views > 0)) return null;
  const median = medianOfDays(values, 30);
  return input.periodDays === 1 ? median.views : scaleTotals(median, input.periodDays).views;
}

function textHeroMetrics(input: CombinedSectionInput, postCount: number, locale: StudioLocale): HeroMetrics {
  const days = dayKeys(input.rangeEnd, input.periodDays);
  const daily = textDailyReach(input.textReach, selectedTextTargetIds(input));
  const period = sumDays(daily, days);
  // Threads earn views without being published, so they are reported beside the
  // figure rather than inside it: everything above is divided by a count of
  // editorial posts, and a reply was never one of them.
  const conversation = sumDays(textDailyReach(input.textReach, [X_CONVERSATION_TARGET]), days);
  const median = medianDailyViews(daily, input);
  // A repost is a reaction that also travels, and the overview has always
  // counted it as both.
  const reactions = period.reactions + period.reposts;
  return {
    kind: "text",
    views: period.views,
    freshViews: days.reduce((total, key) => total + (daily[key]?.freshViews ?? 0), 0),
    medianViews: median,
    reactions,
    replies: period.replies,
    reposts: period.reposts,
    conversationViews: conversation.views,
    engagementRate: period.views > 0 ? (reactions / period.views) * 100 : null,
    countLabel: periodCountLabel(postCount, "post", input.periodDays, locale),
    normLabel: periodNormLabel(input.periodDays, locale),
    contextLabel: periodContextLabel(input.rangeEnd, input.periodDays, input.timeZone, locale),
    paceLabel: periodPaceLabel(period.views, median, input.rangeEnd, input.periodDays, input.timeZone, locale),
    projectionViews: periodProjection(period.views, input.rangeEnd, input.periodDays, input.timeZone),
    progressPercent: metricProgress(period.views, median),
  };
}

function videoHeroMetrics(input: CombinedSectionInput, periodDays: number, fallbackMedian: Totals, locale: StudioLocale): HeroMetrics {
  const median = hasVideoHistory(input.medianVideo)
    ? medianVideoViews(input.medianVideo, periodDays)
    : hasVideoHistory(input.previousVideo) && periodDays === 1
      ? medianDailyVideoTotals(input.previousVideo, 30)
      : hasVideoHistory(input.previousVideo)
        ? fallbackMedian
        : null;
  const progressPercent = metricProgress(input.video.totals.views, median?.views ?? null);
  return {
    kind: "video",
    views: input.video.totals.views,
    freshViews: dayKeys(input.rangeEnd, input.periodDays).reduce((total, key) => total + (input.videoReach[key]?.freshViews ?? 0), 0),
    medianViews: median?.views ?? null,
    completionRate: input.video.summary.completionRate,
    averageWatchTimeMs: input.video.summary.averageWatchTimeMs,
    subscribers: input.video.summary.subscribers,
    countLabel: periodCountLabel(input.video.totals.posts, "video", periodDays, locale),
    normLabel: periodNormLabel(periodDays, locale),
    contextLabel: periodContextLabel(input.rangeEnd, periodDays, input.timeZone, locale),
    paceLabel: periodPaceLabel(input.video.totals.views, median?.views ?? null, input.rangeEnd, periodDays, input.timeZone, locale),
    projectionViews: periodProjection(input.video.totals.views, input.rangeEnd, periodDays, input.timeZone),
    progressPercent,
  };
}

function hasVideoHistory(video: VideoOverview | null | undefined): video is VideoOverview {
  return Boolean(video && (video.items.length > 0 || Object.keys(video.dailyByDay).length > 0));
}

function medianVideoViews(video: VideoOverview, periodDays: number): Totals {
  const daily = Object.values(video.dailyByDay).map((values) => ({
    views: values.views,
    reactions: values.reactions,
    replies: values.replies,
  }));
  const median = medianOfDays(daily, 30);
  return periodDays === 1 ? median : scaleTotals(median, periodDays);
}

/** Destinations listed per locale column — see renderOverviewPlatforms. */
const PLATFORM_SLOTS = 3;

const SECONDARY_TEXT_TARGETS = new Set(["site_ru", "site_en", "telegram_stories", "instagram_stories_ru", "instagram_stories"]);

function renderPlatformMetricFilter(
  platformMetric: PlatformMetric,
  periodDays: number,
  weekOffset: number,
  locale: StudioLocale,
  view?: string,
  videoView?: string,
): Html {
  const viewParam = view ? `&view=${encodeURIComponent(view)}` : "";
  const videoViewParam = videoView ? `&video_view=${encodeURIComponent(videoView)}` : "";
  const base = `/command-center?period=${periodDays}&week_offset=${weekOffset}${viewParam}${videoViewParam}${localeQuery(locale)}`;
  const options: Array<[PlatformMetric, string]> = [
    ["reach", t(locale, "cc.overview.reach")],
    ["followers", t(locale, "cc.overview.followers")],
  ];
  return html`<div class="platform-metric-filter" role="group" aria-label="${t(locale, "cc.overview.metric")}">${options.map(
    ([value, label]) =>
      html`<a class="platform-metric-btn${value === platformMetric ? " platform-metric-btn--active" : ""}" href="${base}${value === "followers" ? "&metric=followers" : ""}" aria-pressed="${value === platformMetric}">${label}</a>`,
  )}</div>`;
}

function medianDailyVideoTotals(video: VideoOverview, days: number): Totals {
  const daily = new Map<string, Totals>();
  for (const [key, values] of Object.entries(video.dailyByDay)) {
    const bucket = daily.get(key) ?? emptyTotals();
    bucket.views += values.views;
    bucket.reactions += values.reactions;
    bucket.replies += values.replies;
    daily.set(key, bucket);
  }
  return medianOfDays([...daily.values()], days);
}
