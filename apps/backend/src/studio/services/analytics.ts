import { analyticsDataVersion } from "../../analytics/data-version.js";
import { audienceAnalysis } from "../../analytics/reports/audience.js";
import { creatorMilestoneHistory } from "../../analytics/reports/milestone-history.js";
import { creatorArchiveSummary, creatorPostArchive, creatorPostMedia, creatorPostMetrics } from "../../analytics/reports/post-archive.js";
import { studioAnalyticsDashboard } from "../../analytics/reports/studio-dashboard.js";
import { creatorVideoArchive, creatorVideoMetrics } from "../../analytics/reports/video-archive.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { trackUsageAsync, trackUsageSync } from "../../observability/usage.js";

type AnalyticsSection = "overview" | "audience" | "posts" | "video";
type AnalyticsPeriod = 1 | 7 | 30;
type AnalyticsDashboard = ReturnType<typeof studioAnalyticsDashboard>;

const MAX_CACHED_DASHBOARDS = 8;
const dashboardCaches = new WeakMap<BackendDb, Map<string, { version: string; value: AnalyticsDashboard }>>();

/**
 * The finished screen, kept until the numbers on it change.
 *
 * Fifteen seconds was the wrong question asked twice: an operator stepping
 * between sections is slower than that, so each step rebuilt everything, while
 * a step inside the window could still show figures that had just moved. The
 * version costs 2.7 ms warm and 94 ms cold on the larger production Studio, so
 * this screen asks once per request and answers what the cache needs to know.
 *
 * This stays an ordinary computed cache, not a projection: the value is
 * discarded and recomputed the moment its inputs move, so there is no second
 * copy of the truth to keep in step with the first.
 */
function cachedDashboard(backendDb: BackendDb, section: AnalyticsSection, days: AnalyticsPeriod, locale: StudioLocale): AnalyticsDashboard {
  const key = `${section}:${days}:${locale}`;
  const version = analyticsDataVersion(backendDb);
  const cache = dashboardCaches.get(backendDb) ?? new Map<string, { version: string; value: AnalyticsDashboard }>();
  dashboardCaches.set(backendDb, cache);
  const cached = cache.get(key);
  if (cached && cached.version === version) return cached.value;
  const value = studioAnalyticsDashboard(backendDb, section, days, locale);
  cache.delete(key);
  cache.set(key, { version, value });
  while (cache.size > MAX_CACHED_DASHBOARDS) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
  return value;
}

/**
 * Application boundary for creator analytics. Telegram, Web Studio and MCP use
 * these operations instead of reaching into analytics tables or render helpers.
 */
export function analyticsService(backendDb: BackendDb, config: BackendConfig) {
  return {
    dashboard(section: AnalyticsSection, days: AnalyticsPeriod, locale: StudioLocale) {
      return trackUsageSync(backendDb, "studio.analytics.dashboard.read", () => cachedDashboard(backendDb, section, days, locale));
    },
    postArchive(offset: number, locale: StudioLocale) {
      return trackUsageSync(backendDb, "studio.analytics.post.read", () => creatorPostArchive(backendDb, offset, locale));
    },
    postMetrics(postId: number, locale: StudioLocale) {
      return trackUsageSync(backendDb, "studio.analytics.post.read", () => creatorPostMetrics(backendDb, postId, locale));
    },
    postMedia(postId: number, locale: StudioLocale) {
      return trackUsageSync(backendDb, "studio.analytics.post.read", () => creatorPostMedia(backendDb, postId, locale));
    },
    archiveSummary(locale: StudioLocale) {
      return trackUsageSync(backendDb, "studio.analytics.post.read", () => creatorArchiveSummary(backendDb, locale));
    },
    milestoneHistory(offset: number, locale: StudioLocale) {
      return trackUsageSync(backendDb, "studio.analytics.milestones.read", () =>
        creatorMilestoneHistory(backendDb, offset, locale, config.TIMEZONE),
      );
    },
    videoArchive(offset: number, locale: StudioLocale) {
      return trackUsageSync(backendDb, "studio.analytics.video.read", () => creatorVideoArchive(backendDb, offset, locale));
    },
    videoMetrics(publicationId: number, locale: StudioLocale) {
      return trackUsageSync(backendDb, "studio.analytics.video.read", () =>
        creatorVideoMetrics(backendDb, publicationId, locale, config.TIMEZONE),
      );
    },
    audienceAnalysis(locale: StudioLocale) {
      return trackUsageAsync(backendDb, "studio.analytics.audience.read", () => audienceAnalysis(backendDb, config, locale));
    },
  };
}
