import type { PipelinePost } from "../../../analytics/pipeline-payload.js";
import { escapeHtml } from "../../../foundation/html.js";
import { t } from "../../../foundation/i18n/index.js";
import type { StudioLocale } from "../../../foundation/locale.js";
import { ORDERED_TARGETS, PLATFORM_ICONS, platformKey, VIDEO_PLATFORM_ICON_KEYS } from "./assets.js";
import { formatMetricValue, shortPipelineText } from "./format.js";
import { getTargetMetric, getTargetStatus, postMetricTotals } from "./metrics.js";
import { getTargetUrl } from "./target-url.js";
import type { VideoContentItem } from "./video-overview.js";

const DETAIL_BATCH_SIZE = 10;

export type PublicationDetailsResult = {
  html: string;
  total: number;
  loaded: number;
  remaining: number;
};

type TrackPublicationListOptions = {
  limit?: number;
  /** Where the "show all N" link goes. Omitted, the footer is not rendered at all. */
  moreUrl?: string | undefined;
};

/** Thin, recent rows for the overview. */
export function renderOverviewPublicationList(
  locale: StudioLocale,
  textLocales: readonly string[],
  posts: PipelinePost[],
  targetIds: string[] = ORDERED_TARGETS.map((target) => target.id),
  videos: VideoContentItem[] = [],
  options: TrackPublicationListOptions = {},
): string {
  const recent = publicationEntries(posts, targetIds, videos, textLocales);
  if (!recent.length) return empty(t(locale, "cc.publication.no-posts"));
  return `<div class="overview-publications__list">${renderRecentPublicationList(recent, Math.max(1, options.limit ?? 4), options.moreUrl, locale)}</div>`;
}

function renderRecentPublicationList(
  entries: PublicationEntry[],
  limit: number,
  moreUrl: string | undefined,
  locale: StudioLocale,
): string {
  const lazy = Boolean(moreUrl);
  const rows = lazy
    ? entries
        .slice(0, limit)
        .map((entry) => entry.recent(false, locale))
        .join("")
    : entries.map((entry, index) => entry.recent(index >= limit, locale)).join("");
  if (entries.length <= limit) return rows;
  const button = lazy
    ? `<button class="show-more-posts" type="button" data-more-url="${escapeHtml(moreUrl ?? "")}" data-more-offset="${limit}">${t(locale, "cc.publication.show-more")} <span>${entries.length - limit}</span></button>`
    : `<button class="show-more-posts" type="button">${t(locale, "cc.publication.show-more")} <span>${entries.length - limit}</span></button>`;
  return `${rows}${button}`;
}

/** Renders only a bounded fragment for the dashboard's read-only detail loader. */
export function renderPublicationDetails(
  locale: StudioLocale,
  textLocales: readonly string[],
  posts: PipelinePost[],
  targetIds: string[] = ORDERED_TARGETS.map((target) => target.id),
  videos: VideoContentItem[] = [],
  offset = 0,
  limit = DETAIL_BATCH_SIZE,
): PublicationDetailsResult {
  const entries = publicationEntries(posts, targetIds, videos, textLocales);
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(1, Math.min(DETAIL_BATCH_SIZE, Math.floor(limit)));
  const selected = entries.slice(safeOffset, safeOffset + safeLimit);
  return {
    html: selected.map((entry) => entry.recent(false, locale)).join(""),
    total: entries.length,
    loaded: selected.length,
    remaining: Math.max(0, entries.length - safeOffset - selected.length),
  };
}

type PublicationEntry = {
  date: string;
  views: number;
  recent: (hidden: boolean, locale: StudioLocale) => string;
};

/** The list answers "what worked", so it reads best-performing first in every
 * period; the date only breaks ties between equally seen publications. */
function publicationEntries(
  posts: PipelinePost[],
  targetIds: string[],
  videos: VideoContentItem[],
  textLocales: readonly string[],
): PublicationEntry[] {
  return [
    ...posts.map((post) => ({
      date: post.date ?? "",
      views: postMetricTotals(post, targetIds).views,
      recent: (hidden: boolean, locale: StudioLocale) => renderRecentPost(post, targetIds, hidden, locale, textLocales),
    })),
    ...videos.map((video) => ({
      date: video.publishedAt ?? "",
      views: video.views,
      recent: (hidden: boolean, locale: StudioLocale) => renderRecentVideo(video, hidden, locale),
    })),
  ].sort((left, right) => right.views - left.views || right.date.localeCompare(left.date));
}

type PublicationPlatform = {
  name: string;
  locale: string;
  icon: string;
};

function textPublicationPlatforms(post: PipelinePost, targetIds: string[]): PublicationPlatform[] {
  return ORDERED_TARGETS.filter((target) => targetIds.includes(target.id) && getTargetStatus(post, target.id) === "published").map(
    (target) => ({
      name: target.label.replace(/\s(?:RU|EN)$/i, ""),
      locale: target.locale.toUpperCase(),
      icon: PLATFORM_ICONS[platformKey(target.id)] ?? "",
    }),
  );
}

function videoPublicationPlatforms(video: VideoContentItem): PublicationPlatform[] {
  return video.destinations.map((destination) => ({
    name: (destination.label || destination.target).replace(/\s(?:RU|EN)$/i, ""),
    locale: destination.locale?.toUpperCase() ?? "",
    icon: PLATFORM_ICONS[VIDEO_PLATFORM_ICON_KEYS[destination.target] ?? destination.target] ?? "",
  }));
}

function publicationPlatformSummary(platforms: PublicationPlatform[], locale: StudioLocale): string {
  if (!platforms.length) return "";
  if (platforms.length === 1) {
    const platform = platforms[0];
    if (!platform) return "";
    const label = platform.name + (platform.locale ? ` ${platform.locale}` : "");
    const locale = platform.locale ? `<b class="post-detail__platform-locale">${escapeHtml(platform.locale)}</b>` : "";
    return `<span class="post-detail__platform-summary" aria-label="${escapeHtml(label)}"><i class="platform-mark">${platform.icon}</i>${locale}</span>`;
  }

  const grouped = new Map<string, PublicationPlatform[]>();
  for (const platform of platforms) {
    const locale = platform.locale || "OTHER";
    const group = grouped.get(locale);
    if (group) group.push(platform);
    else grouped.set(locale, [platform]);
  }
  const localeOrder = ["EN", "RU", ...[...grouped.keys()].filter((locale) => locale !== "EN" && locale !== "RU")];
  const columns = localeOrder
    .filter((locale) => grouped.has(locale))
    .map((locale) => {
      const entries = grouped.get(locale) ?? [];
      return [
        `<div class="post-detail__platform-tooltip-column"><b>${escapeHtml(locale)}</b><ul>`,
        entries
          .map((platform) => `<li><i class="platform-mark">${platform.icon}</i><span>${escapeHtml(platform.name)}</span></li>`)
          .join(""),
        "</ul></div>",
      ].join("");
    })
    .join("");
  const labels = platforms.map((platform) => platform.name + (platform.locale ? ` ${platform.locale}` : ""));
  const accessible = escapeHtml(`${platforms.length} ${t(locale, "cc.publication.platforms")}: ${labels.join(", ")}`);
  return `<span class="post-detail__platform-summary post-detail__platform-summary--count" tabindex="0" aria-label="${accessible}"><b class="post-detail__platform-count">${platforms.length}</b><span class="post-detail__platform-tooltip" role="tooltip" aria-hidden="true">${columns}</span></span>`;
}

function renderRecentVideo(video: VideoContentItem, hidden: boolean, locale: StudioLocale): string {
  // The same row the text side opens: a summary that reads as a column, and a
  // body that names what each destination earned.
  const extra = [
    video.afterPeriodViews > 0 ? t(locale, "cc.publication.after-period-views", { value: formatMetricValue(video.afterPeriodViews) }) : "",
    video.subscribers
      ? `${video.subscribers > 0 ? "+" : ""}${formatMetricValue(video.subscribers)} ${t(locale, "cc.publication.subscriptions")}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    `<details class="post-detail${hidden ? " post-detail--more" : ""}" title="${escapeHtml(video.title)}">`,
    '<summary><span class="post-detail__summary">',
    '<span class="post-detail__headline"><span class="post-detail__chevron">›</span>',
    `<span class="post-detail__title">${escapeHtml(shortPipelineText(video.title, 7))}</span></span>`,
    `<span class="post-detail__media">${publicationPlatformSummary(videoPublicationPlatforms(video), locale)}</span>`,
    // Two figures answering two questions — what the clip earned inside the
    // period, and what it is worth by now — each in its own column so the rows
    // read down as columns.
    `<span class="post-detail__metric"><span>${formatMetricValue(video.views)}</span></span>`,
    `<span class="post-detail__metric post-detail__lifetime">${video.lifetimeViews > video.views ? `${t(locale, "cc.publication.of")} ${formatMetricValue(video.lifetimeViews)}` : ""}</span>`,
    `<span class="post-detail__metric"><span>${formatMetricValue(video.reactions)}</span></span>`,
    `<span class="post-detail__metric"><span>${formatMetricValue(video.replies)}</span></span>`,
    "</span></summary>",
    '<div class="post-detail__body">',
    platformBreakdown(videoPlatformResults(video), locale),
    extra
      ? `<div class="post-detail__content"><div><span class="post-detail__label">${t(locale, "cc.publication.after-period")}</span><p>${escapeHtml(extra)}</p></div></div>`
      : "",
    "</div>",
    "</details>",
  ].join("");
}

function renderRecentPost(
  post: PipelinePost,
  targetIds: string[],
  hidden: boolean,
  locale: StudioLocale,
  textLocales: readonly string[],
): string {
  const metrics = total(post, targetIds);
  // A Studio that publishes no English has no English publication to read: its
  // rows are headed by what actually went out, and the copy below them is the
  // one language it wrote.
  const servesEn = textLocales.includes("en");
  const english = post.full_text_en || post.text_en || t(locale, "cc.publication.no-english");
  const russian = post.full_text_ru || post.text_ru || "—";
  const headline = servesEn ? english : russian;
  return [
    `<details class="post-detail${hidden ? " post-detail--more" : ""}">`,
    '<summary><span class="post-detail__summary">',
    '<span class="post-detail__headline">',
    '<span class="post-detail__chevron">›</span>',
    `<span class="post-detail__title">${escapeHtml(shortPipelineText(headline, 7))}</span>`,
    "</span>",
    `<span class="post-detail__media">${publicationPlatformSummary(textPublicationPlatforms(post, targetIds), locale)}</span>`,
    `<span class="post-detail__metric"><span>${formatMetricValue(metrics.views)}</span></span>`,
    `<span class="post-detail__metric"><span>${formatMetricValue(reactions(metrics))}</span></span>`,
    `<span class="post-detail__metric"><span>${formatMetricValue(metrics.replies)}</span></span>`,
    "</span></summary>",
    '<div class="post-detail__body">',
    platformBreakdown(textPlatformResults(post, targetIds), locale),
    '<div class="post-detail__content"><div>',
    ...(servesEn
      ? [
          `<span class="post-detail__label">${t(locale, "cc.publication.english")}</span><p>${escapeHtml(english)}</p>`,
          `<span class="post-detail__label">${t(locale, "cc.publication.ru-original")}</span><p>${escapeHtml(russian)}</p>`,
        ]
      : [`<p>${escapeHtml(russian)}</p>`]),
    "</div>",
    "</div></div>",
    "</details>",
  ].join("");
}

/** What one publication earned on one destination, whichever feed it came from. */
type PlatformResult = {
  icon: string;
  locale: string;
  url: string | null;
  views: number;
  reactions: number;
  replies: number;
};

function platformBreakdown(results: PlatformResult[], locale: StudioLocale): string {
  if (!results.length) return "";
  return [
    `<section class="post-platforms" aria-label="${t(locale, "cc.publication.by-platform")}">`,
    `<span class="post-detail__label">${t(locale, "cc.publication.result-by-platform")}</span>`,
    '<div class="post-platforms__grid">',
    results.map((result) => platformMetrics(result, locale)).join(""),
    "</div>",
    "</section>",
  ].join("");
}

function textPlatformResults(post: PipelinePost, targetIds: string[]): PlatformResult[] {
  return ORDERED_TARGETS.filter((target) => targetIds.includes(target.id) && getTargetStatus(post, target.id) === "published").map(
    (target) => ({
      icon: PLATFORM_ICONS[platformKey(target.id)] ?? "",
      locale: target.locale,
      url: getTargetUrl(post, target.id),
      views: getTargetMetric(post, target.id, "views"),
      reactions: getTargetMetric(post, target.id, "likes") + getTargetMetric(post, target.id, "reposts"),
      replies: getTargetMetric(post, target.id, "replies"),
    }),
  );
}

function videoPlatformResults(video: VideoContentItem): PlatformResult[] {
  return video.destinations.map((destination) => ({
    icon: PLATFORM_ICONS[VIDEO_PLATFORM_ICON_KEYS[destination.target] ?? destination.target] ?? "",
    locale: destination.locale ?? "",
    url: destination.url,
    views: destination.views,
    reactions: destination.reactions,
    replies: destination.replies,
  }));
}

function platformMetrics(result: PlatformResult, locale: StudioLocale): string {
  const name = `<span class="post-platform__name">${result.icon}<b class="post-platform__locale">${escapeHtml(result.locale.toUpperCase())}</b></span>`;
  const metric = (label: string, value: number) => {
    const formatted = formatMetricValue(value);
    return `<span class="post-platform__metric" title="${label}" aria-label="${label}: ${formatted}"><b>${formatted}</b></span>`;
  };
  const content = `${name}<span class="post-platform__metrics">${metric(t(locale, "cc.publication.reach"), result.views)}${metric(t(locale, "cc.publication.reactions"), result.reactions)}${metric(t(locale, "cc.publication.replies"), result.replies)}</span>`;
  return result.url
    ? `<a class="post-platform" href="${escapeHtml(result.url)}" target="_blank" rel="noopener noreferrer">${content}</a>`
    : `<div class="post-platform">${content}</div>`;
}

function total(post: PipelinePost, targetIds: string[]) {
  return postMetricTotals(post, targetIds);
}
function reactions(metrics: ReturnType<typeof total>) {
  return metrics.likes + metrics.reposts;
}
function empty(text: string) {
  return `<p class="empty-state">${escapeHtml(text)}</p>`;
}
