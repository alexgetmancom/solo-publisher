import { AUDIENCE_VIEWS, type AudienceView } from "../../botTargets.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { type Html, html, raw } from "../../foundation/html.js";
import { t } from "../../foundation/i18n/index.js";
import { DEFAULT_STUDIO_LOCALE, parseStudioLocale, type StudioLocale } from "../../foundation/locale.js";
import { log } from "../../foundation/logger.js";
import {
  type CommandCenterAttention,
  commandCenterAttention,
  commandCenterFingerprint,
  commandCenterPayload,
} from "../../operations/command-center.js";
import { hasStudioAuthoringInterface, primaryStudioActorId } from "../../studio/access.js";
import { createStudioServices } from "../../studio/services/index.js";
import { type PlatformMetric, renderCombinedSection } from "./dashboard/combined-section.js";
import { localeQuery, renderLocaleSwitcher } from "./dashboard/locale-links.js";
import { renderCredentialsSection, renderDiagnosticsSection, renderQueueSection } from "./dashboard/ops-sections.js";
import { buildOverviewData, loadDashboardReadModel } from "./dashboard/overview-data.js";
import { renderPeriodControls } from "./dashboard/period-controls.js";
import { renderDashboardShell } from "./dashboard/shell.js";
import { dashboardThemeToggleHtml } from "./dashboard/theme.js";
import type { OpsPayload } from "./dashboard/types.js";
import { createVideoOverviewCache } from "./dashboard/video-overview.js";
import { renderStudioOnboarding, renderStudioSection } from "./studio.js";

type DashboardTab = "posts" | "studio";
type DashboardPanel = "overview" | "queue" | "health";
const MAX_DASHBOARD_CACHE_ENTRIES = 5;
type DashboardCacheEntry = { html: string };
const dashboardCaches = new WeakMap<BackendDb, Map<string, DashboardCacheEntry>>();

function dashboardCacheFor(backendDb: BackendDb): Map<string, DashboardCacheEntry> {
  const existing = dashboardCaches.get(backendDb);
  if (existing) return existing;
  const created = new Map<string, DashboardCacheEntry>();
  dashboardCaches.set(backendDb, created);
  return created;
}

function dashboardCacheKey(
  config: BackendConfig,
  weekOffset: number,
  requestedTab: string | undefined,
  requestedLocale: string | undefined,
  requestedPanel: string | undefined,
  requestedPeriod: string | undefined,
  requestedView: string | undefined,
  requestedMetric: string | undefined,
  requestedVideoView: string | undefined,
  revision: string,
): string {
  return JSON.stringify({
    timezone: config.TIMEZONE,
    studioActorId: config.MCP_STUDIO_ACTOR_ID ?? null,
    request: [
      weekOffset,
      requestedTab ?? null,
      requestedLocale ?? null,
      requestedPanel ?? null,
      requestedPeriod ?? null,
      requestedView ?? null,
      requestedMetric ?? null,
      requestedVideoView ?? null,
      revision,
    ],
  });
}

function rememberDashboard(cache: Map<string, DashboardCacheEntry>, key: string, html: string): void {
  cache.delete(key);
  cache.set(key, { html });
  while (cache.size > MAX_DASHBOARD_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
}

export function renderDashboard(
  config: BackendConfig,
  backendDb: BackendDb,
  weekOffset: number,
  requestedTab?: string,
  requestedLocale?: string,
  requestedPanel?: string,
  requestedPeriod?: string,
  requestedView?: string,
  requestedMetric?: string,
  requestedVideoView?: string,
): string {
  const renderStartedAt = Date.now();
  const fingerprintStartedAt = Date.now();
  const revision = JSON.stringify(commandCenterFingerprint(backendDb));
  const fingerprintMs = Date.now() - fingerprintStartedAt;
  const cache = dashboardCacheFor(backendDb);
  const cacheKey = dashboardCacheKey(
    config,
    weekOffset,
    requestedTab,
    requestedLocale,
    requestedPanel,
    requestedPeriod,
    requestedView,
    requestedMetric,
    requestedVideoView,
    revision,
  );
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    log("info", "dashboard render timing", {
      cacheHit: true,
      fingerprintMs,
      totalMs: Date.now() - renderStartedAt,
      htmlBytes: Buffer.byteLength(cached.html),
    });
    return cached.html;
  }
  const videoCache = createVideoOverviewCache();
  const studioActorId = primaryStudioActorId(config);
  const connectedChannelCount = createStudioServices(backendDb, config).channels.list().length;
  const needsOnboarding = connectedChannelCount === 0 || !hasStudioAuthoringInterface(config);
  // The unified overview is the landing screen of every Studio, whichever
  // halves it publishes.
  const tab: DashboardTab = requestedTab === "studio" ? "studio" : "posts";
  const showPosts = tab === "posts";
  const showStudio = tab === "studio";
  const activeTab = showStudio ? "studio" : "posts";
  const locale = parseStudioLocale(requestedLocale);
  const panel: DashboardPanel = requestedPanel === "queue" || requestedPanel === "health" ? requestedPanel : "overview";
  const attentionStartedAt = Date.now();
  const ops = panel === "queue" || panel === "health" ? commandCenterPayload(config, backendDb) : null;
  const hasAttention = ops ? opsNeedsAttention(ops) : commandCenterAttentionState(commandCenterAttention(config, backendDb));
  const attentionMs = Date.now() - attentionStartedAt;
  const periodDays = [1, 7, 30, 90, 365].includes(Number(requestedPeriod)) ? Number(requestedPeriod) : 1;
  const activeView = showPosts && AUDIENCE_VIEWS.includes(requestedView as AudienceView) ? (requestedView as AudienceView) : undefined;
  const platformMetric: PlatformMetric = requestedMetric === "followers" ? "followers" : "reach";
  // `target:locale`, the same key the video destination registry uses.
  const videoView = showPosts && /^[a-z_]+:(ru|en)$/.test(requestedVideoView ?? "") ? requestedVideoView : undefined;
  const localeParam = localeQuery(locale);
  const panelLink = (value: DashboardPanel) =>
    `/command-center?tab=posts&panel=${value}${periodDays !== 1 ? `&period=${periodDays}` : ""}${localeParam}`;
  const localeLink = (target: StudioLocale): string => {
    const params = new URLSearchParams({ tab: activeTab });
    if (panel !== "overview") params.set("panel", panel);
    if (periodDays !== 1) params.set("period", String(periodDays));
    if (activeView) params.set("view", activeView);
    if (platformMetric === "followers") params.set("metric", "followers");
    if (videoView) params.set("video_view", videoView);
    if (target !== DEFAULT_STUDIO_LOCALE) params.set("locale", target);
    return `/command-center?${params.toString()}`;
  };
  const overviewFilterQuery = platformMetric === "followers" ? "&metric=followers" : "";
  const overviewControls =
    panel === "overview" && showPosts && !needsOnboarding
      ? renderPeriodControls(locale, weekOffset, periodDays, config.TIMEZONE, activeView, videoView, overviewFilterQuery)
      : "";
  const contentStartedAt = Date.now();
  // The overview is the only panel that reads the whole Studio, and it is the
  // one a cache miss is paid on. Split into the two halves that can be acted on
  // separately -- the database read and the HTML built from it -- because
  // "content took 1.4s" names neither.
  let readModelMs = 0;
  let htmlMs = 0;
  const content = renderPanel();
  const contentMs = Date.now() - contentStartedAt;

  function renderPanel(): Html {
    switch (panel) {
      case "queue":
        return renderQueueSection(ops ?? {}, locale);
      case "health":
        return html`${renderCredentialsSection(ops ?? {}, locale)}${renderDiagnosticsSection(ops ?? {}, locale)}`;
      default:
        return renderOverview();
    }
  }

  function renderOverview(): Html {
    if (showPosts) {
      if (needsOnboarding) return renderStudioOnboarding(config, connectedChannelCount, locale);
      const readModelStartedAt = Date.now();
      const readModel = loadDashboardReadModel(config, backendDb, videoCache, weekOffset, periodDays, videoView);
      readModelMs = Date.now() - readModelStartedAt;
      const htmlStartedAt = Date.now();
      const section = renderCombinedSection(buildOverviewData(readModel, activeView, platformMetric), locale);
      htmlMs = Date.now() - htmlStartedAt;
      return section;
    }
    if (showStudio) return renderStudioSection(config, backendDb, studioActorId, locale);
    return html``;
  }

  // Everything except the overview lives behind the overflow menu: the operator
  // opens Queue, Health and Video rarely, and spelled out they cost the
  // widest, tallest row on the screen. The one thing that must not be hidden is
  // a problem, so the menu carries a dot when Health has something to say.
  const secondaryTabs = [
    { label: t(locale, "cc.nav.queue"), href: panelLink("queue"), active: panel === "queue" },
    { label: t(locale, "cc.nav.health"), href: panelLink("health"), active: panel === "health", attention: hasAttention },
    {
      label: t(locale, "cc.nav.studio"),
      href: `/command-center?tab=studio${localeParam}`,
      active: panel === "overview" && activeTab === "studio",
    },
  ];
  const activeSecondary = secondaryTabs.find((tab) => tab.active);
  const menuAttention = secondaryTabs.some((tab) => tab.attention);
  const overviewTab = html`<a class="${panel === "overview" && activeTab === "posts" ? "active" : ""}" href="${panelLink("overview")}">${t(locale, "cc.nav.overview")}</a>`;
  // Not open on arrival even when one of its entries is the current section:
  // the panel would drop over the content the operator just navigated to. The
  // control names the section instead.
  const menu = html`<details class="nav-more">
    <summary class="nav-more__toggle${activeSecondary ? " active" : ""}${menuAttention ? " nav-more__toggle--attention" : ""}" aria-label="${t(locale, "cc.nav.more-sections")}">${activeSecondary ? activeSecondary.label : "···"}</summary>
    <div class="nav-more__menu">${secondaryTabs.map(
      (tab) =>
        html`<a class="${tab.active ? "active" : ""}" href="${tab.href}">${tab.label}${tab.attention ? raw('<i class="nav-dot"></i>') : ""}</a>`,
    )}</div>
  </details>`;
  const localeSwitcher = renderLocaleSwitcher(locale, localeLink);
  // The overview is one complete Studio surface: text and video stay side by
  // side, with only the period, platform and metric filters remaining.
  const body = html`
    <nav class="dashboard-tabs"><span class="dashboard-tabs__start">${overviewTab}${menu}</span><span class="dashboard-tabs__end">${overviewControls}${localeSwitcher}${dashboardThemeToggleHtml(t(locale, "cc.theme.toggle"))}</span></nav>
    <section id="overview" class="overview">${content}</section>`;
  const shellStartedAt = Date.now();
  const page = renderDashboardShell(body, locale);
  const shellMs = Date.now() - shellStartedAt;
  rememberDashboard(cache, cacheKey, page);
  log("info", "dashboard render timing", {
    cacheHit: false,
    fingerprintMs,
    attentionMs,
    contentMs,
    readModelMs,
    htmlMs,
    shellMs,
    totalMs: Date.now() - renderStartedAt,
    htmlBytes: Buffer.byteLength(page),
  });
  return page;
}

/** Health is the one hidden tab whose state the operator must see without
 * opening it: a failed publish job, a broken credential, or a metric target
 * that stopped reporting. */
function opsNeedsAttention(ops: OpsPayload): boolean {
  if (ops.jobs?.some((job) => job.status === "failed")) return true;
  if (ops.credentials?.some((credential) => credential.status && !["ok", "ready"].includes(credential.status))) return true;
  return Boolean(ops.pipeline?.metrics?.recent?.some((issue) => issue.error || issue.status === "failed"));
}

function commandCenterAttentionState(attention: CommandCenterAttention): boolean {
  return attention.hasActionableIssue || attention.hasCredentialIssue || attention.hasMetricIssue;
}
