import type { PipelineData, PipelinePost } from "../../../analytics/pipeline-payload.js";
import { calendarDays } from "../../../analytics/reach/daily-reach.js";
import { type TextOverview, textOverviewOf } from "../../../analytics/reach/text-overview.js";
import { xActivityReachSeries } from "../../../analytics/reach/text-reach.js";
import type { XActivityDashboardItem } from "../../../analytics/x-activity-dashboard.js";
import { xActivityDashboardRange } from "../../../analytics/x-activity-dashboard.js";
import type { AudienceView } from "../../../botTargets.js";
import { postLocales, videoLocales } from "../../../channels/locales.js";
import type { BackendDb } from "../../../db/client.js";
import type { BackendConfig } from "../../../foundation/config.js";
import { log } from "../../../foundation/logger.js";
import { zonedRollingPeriodBounds, zonedSlot } from "../../../foundation/time.js";
import { dashboardPipelineHistoryPayload } from "../../../operations/read-model.js";
import type { CombinedSectionInput, PlatformMetric } from "./combined-section.js";
import { cachedHistory, dashboardDataVersion } from "./data-version.js";
import { audiencePlatformFollowers } from "./ops-sections.js";
import { rollingPeriodDates } from "./period-controls.js";
import { createVideoOverviewCache, setVideoOverviewCacheRange, type VideoOverview, videoOverview } from "./video-overview.js";

type OverviewCache = ReturnType<typeof createVideoOverviewCache>;

type DashboardReadModel = {
  pipeline: {
    current: PipelineData | null;
    comparison: PipelineData | null;
    dayComparison: PipelineData | null;
    median: PipelineData | null;
  };
  xActivity: {
    current: XActivityDashboardItem[];
    comparison: XActivityDashboardItem[];
    median: XActivityDashboardItem[];
  };
  video: {
    current: VideoOverview;
    /** The chart's whole window, so a video bar means what a text bar means. */
    history: VideoOverview;
    comparison: VideoOverview;
    dayComparison: VideoOverview | null;
    median: VideoOverview;
  };
  text: TextOverview;
  /** What this Studio publishes in, per half, read once for every surface of
   * the page that is drawn per language. */
  locales: { text: string[]; video: string[] };
  videoView: string | null;
  followers: Array<{ key: string; label: string; followers: number | null }>;
  rangeStart: Date;
  rangeEnd: Date;
  periodDays: number;
  weekOffset: number;
  timeZone: string;
};

/** Loads every source used by the unified overview once in one place. */
export function loadDashboardReadModel(
  config: BackendConfig,
  backendDb: BackendDb,
  videoCache: OverviewCache,
  weekOffset: number,
  periodDays: number,
  videoView?: string,
): DashboardReadModel {
  const timings: Record<string, number> = {};
  const timed = <T>(phase: string, load: () => T): T => {
    const startedAt = Date.now();
    const value = load();
    timings[phase] = Date.now() - startedAt;
    return value;
  };
  const [start, end] = rollingPeriodDates(weekOffset, periodDays, config.TIMEZONE);
  const [yesterdayStart, yesterdayEnd] = rollingPeriodDates(weekOffset + 1, 1, config.TIMEZONE);
  const previousEnd = periodDays === 1 ? yesterdayEnd : rollingPeriodDates(weekOffset + 1, periodDays, config.TIMEZONE)[1];
  const previousStart =
    periodDays === 1 ? shiftDays(yesterdayEnd, -29) : rollingPeriodDates(weekOffset + 1, periodDays, config.TIMEZONE)[0];
  const medianOffsetDays = weekOffset * periodDays + periodDays;
  const medianPeriodOffset = medianOffsetDays / 30;
  const [medianStart, medianEnd] = rollingPeriodDates(medianPeriodOffset, 30, config.TIMEZONE);
  const historyStart = new Date(Math.min(start.getTime(), previousStart.getTime(), medianStart.getTime(), yesterdayStart.getTime()));
  const historyEnd = new Date(Math.max(end.getTime(), previousEnd.getTime(), medianEnd.getTime(), yesterdayEnd.getTime()));
  const historyDays = Math.max(1, Math.round((historyEnd.getTime() - historyStart.getTime() + 1) / 86_400_000));
  const offsetDays = weekOffset * periodDays;
  const dataVersion = dashboardDataVersion(backendDb);
  const pipelineHistory = timed("pipelineMs", () =>
    cachedHistory(backendDb, `pipeline|${historyDays}|${offsetDays}`, dataVersion, () =>
      dashboardPipelineHistoryPayload(config, backendDb, historyDays, offsetDays),
    ),
  );
  const pipeline = {
    current: pipelineForDates(pipelineHistory, start, end, config.TIMEZONE),
    comparison: pipelineForDates(pipelineHistory, previousStart, previousEnd, config.TIMEZONE),
    dayComparison: periodDays === 1 ? pipelineForDates(pipelineHistory, yesterdayStart, yesterdayEnd, config.TIMEZONE) : null,
    median: pipelineForDates(pipelineHistory, medianStart, medianEnd, config.TIMEZONE),
  };
  const [historyStartBound, historyEndBound] = periodBounds(historyStart, historyEnd, config.TIMEZONE);
  const xHistory = timed("xActivityMs", () =>
    cachedHistory(backendDb, `x|${historyStartBound.toISOString()}|${historyEndBound.toISOString()}`, dataVersion, () =>
      xActivityDashboardRange(backendDb, historyStartBound.toISOString(), historyEndBound.toISOString()),
    ),
  );
  const xActivity = {
    current: xActivityForDates(xHistory.items, start, end, config.TIMEZONE),
    comparison: xActivityForDates(xHistory.items, previousStart, previousEnd, config.TIMEZONE),
    median: xActivityForDates(xHistory.items, medianStart, medianEnd, config.TIMEZONE),
  };
  const videoHistoryStart = new Date(Math.min(start.getTime(), previousStart.getTime(), medianStart.getTime(), yesterdayStart.getTime()));
  const videoHistoryEnd = new Date(
    Math.max(end.getTime(), previousEnd.getTime(), medianEnd.getTime(), yesterdayEnd.getTime()) + 86_400_000 - 1,
  );
  setVideoOverviewCacheRange(videoCache, videoHistoryStart, videoHistoryEnd, periodDays <= 7 ? 60 * 60 : 24 * 60 * 60);
  const video = timed("videoMs", () => ({
    current: videoForDates(backendDb, config.TIMEZONE, videoCache, start, end, true, videoView),
    history: videoForDates(backendDb, config.TIMEZONE, videoCache, videoHistoryStart, end, true, videoView),
    comparison: videoForDates(backendDb, config.TIMEZONE, videoCache, previousStart, previousEnd, true, videoView),
    dayComparison:
      periodDays === 1 ? videoForDates(backendDb, config.TIMEZONE, videoCache, yesterdayStart, yesterdayEnd, true, videoView) : null,
    median: videoForDates(backendDb, config.TIMEZONE, videoCache, medianStart, medianEnd, true, videoView),
  }));
  const text = timed("textMs", () => {
    const textHistoryDays = periodDays + 30;
    const [textStartIso, textEndIso] = zonedRollingPeriodBounds(offsetDays / textHistoryDays, textHistoryDays, config.TIMEZONE);
    const textStart = new Date(textStartIso);
    const textEnd = new Date(textEndIso);
    const posts = (pipelineHistory.posts ?? []).filter((post) => {
      const publishedAt = Date.parse(String(post.date ?? ""));
      return publishedAt >= textStart.getTime() && publishedAt <= textEnd.getTime();
    });
    return textOverviewOf(
      posts,
      xActivityReachSeries(xHistory.items, xHistory.samples, textStart, textEnd),
      calendarDays(textStart, textEnd, config.TIMEZONE),
      config.TIMEZONE,
    );
  });
  const followers = timed("followersMs", () => audiencePlatformFollowers(backendDb));
  log("info", "dashboard read model timing", {
    periodDays,
    weekOffset,
    ...timings,
    pipelinePosts: pipelineHistory.posts?.length ?? 0,
    xActivityItems: xHistory.items.length,
    videoItems: video.history.items.length,
  });

  return {
    pipeline,
    xActivity,
    video,
    text,
    locales: { text: postLocales(backendDb), video: videoLocales(backendDb) },
    videoView: videoView ?? null,
    followers,
    rangeStart: start,
    rangeEnd: end,
    periodDays,
    weekOffset,
    timeZone: config.TIMEZONE,
  };
}

function pipelineForDates(data: PipelineData, start: Date, end: Date, timeZone: string): PipelineData {
  const [startBound, endBound] = periodBounds(start, end, timeZone);
  const startIso = startBound.toISOString();
  const endIso = endBound.toISOString();
  return {
    ...data,
    posts: (data.posts ?? [])
      .filter((post) => {
        const publishedAt = post.date;
        return typeof publishedAt === "string" && publishedAt >= startIso && publishedAt <= endIso;
      })
      .slice(0, 100),
  };
}

function xActivityForDates(items: XActivityDashboardItem[], start: Date, end: Date, timeZone: string): XActivityDashboardItem[] {
  const [startBound, endBound] = periodBounds(start, end, timeZone);
  const startIso = startBound.toISOString();
  const endIso = endBound.toISOString();
  return items.filter((item) => item.publishedAt >= startIso && item.publishedAt <= endIso);
}

function periodBounds(start: Date, end: Date, timeZone: string): [Date, Date] {
  const startBound = zonedSlot(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate(), "00:00", timeZone);
  const endNextDay = zonedSlot(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate() + 1, "00:00", timeZone);
  return [startBound, new Date(endNextDay.getTime() - 1)];
}

export function buildOverviewData(
  readModel: DashboardReadModel,
  activeView: AudienceView | undefined,
  platformMetric: PlatformMetric,
): CombinedSectionInput {
  const selectedTargetIds = activeView ? [activeView] : undefined;
  const selectPipeline = (data: PipelineData | null): PipelineData | null =>
    selectedTargetIds ? filterPipeline(data, selectedTargetIds) : data;
  const selectX = (items: XActivityDashboardItem[]): XActivityDashboardItem[] => (!activeView ? items : activeView === "x" ? items : []);

  return {
    data: selectPipeline(readModel.pipeline.current),
    previousData: selectPipeline(readModel.pipeline.comparison),
    xItems: selectX(readModel.xActivity.current),
    previousXItems: selectX(readModel.xActivity.comparison),
    dayComparisonData: selectPipeline(readModel.pipeline.dayComparison),
    video: readModel.video.current,
    previousVideo: readModel.video.comparison,
    dayComparisonVideo: readModel.video.dayComparison,
    medianData: selectPipeline(readModel.pipeline.median),
    medianXItems: selectX(readModel.xActivity.median),
    medianVideo: readModel.video.median,
    videoReach: readModel.video.history.dailyByDay,
    videoView: readModel.videoView ?? undefined,
    textReach: readModel.text,
    followers: readModel.followers,
    rangeStart: readModel.rangeStart,
    rangeEnd: readModel.rangeEnd,
    periodDays: readModel.periodDays,
    weekOffset: readModel.weekOffset,
    timeZone: readModel.timeZone,
    platformMetric,
    textTargetIds: selectedTargetIds,
    textView: activeView,
    textLocales: readModel.locales.text,
    videoLocales: readModel.locales.video,
  };
}

export function videoOverviewForPeriod(
  backendDb: BackendDb,
  weekOffset: number,
  periodDays: number,
  config: BackendConfig,
  destination?: string,
): VideoOverview {
  const [start, end] = rollingPeriodDates(weekOffset, periodDays, config.TIMEZONE);
  const cache = createVideoOverviewCache(periodDays <= 7 ? 60 * 60 : 24 * 60 * 60);
  setVideoOverviewCacheRange(
    cache,
    videoDayBounds(start, config.TIMEZONE, false),
    videoDayBounds(end, config.TIMEZONE, true),
    cache.sampleBucketSeconds,
  );
  return videoForDates(backendDb, config.TIMEZONE, cache, start, end, true, destination);
}

function videoForDates(
  backendDb: BackendDb,
  timeZone: string,
  cache: OverviewCache,
  start: Date,
  end: Date,
  endOfDay: boolean,
  destination?: string,
): VideoOverview {
  return videoOverview(
    backendDb,
    videoDayBounds(start, timeZone, false),
    videoDayBounds(end, timeZone, endOfDay),
    timeZone,
    cache,
    destination,
  );
}

function videoDayBounds(date: Date, timeZone: string, endOfDay: boolean): Date {
  const start = zonedSlot(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), "00:00", timeZone);
  return endOfDay ? new Date(start.getTime() + 86_400_000 - 1) : start;
}

function shiftDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

/** Posts that reached at least one of these targets — by delivery status, by a
 * legacy Telegram url, or by having metrics for it. */
export function filterPipeline(data: PipelineData | null, targetIds: readonly string[]): PipelineData | null {
  if (!data) return null;
  return { ...data, posts: (data.posts ?? []).filter((post) => targetIds.some((target) => postHasTarget(post, target))) };
}

function postHasTarget(post: PipelinePost, target: string): boolean {
  if (post.targets?.[target]?.status === "published") return true;
  if (target === "telegram" && post.telegram_url) return true;
  return Boolean(post.metrics?.[target]);
}
