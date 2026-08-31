import { calendarDays, emptyDailyReach, latestAtOrBefore } from "../../../analytics/reach/daily-reach.js";
import { publicationRef } from "../../../application/publication-ref.js";
import type { BackendDb } from "../../../db/client.js";
import { log } from "../../../foundation/logger.js";
import { emptyMetrics } from "./video-overview-calendar.js";
import {
  aggregateDailyMetrics,
  destinationFor,
  destinationKey,
  periodReachByRow,
  periodSubscribersByRow,
  type TargetRow,
  type VideoOverview,
  type VideoOverviewCache,
  videoAnalyticsBundle,
  videoLabel,
  videoSummaryMetrics,
  viewEvents,
} from "./video-overview-data.js";

export type { VideoContentItem, VideoOverview, VideoOverviewCache } from "./video-overview-data.js";

export {
  createVideoOverviewCache,
  emptyVideoOverview,
  invalidateVideoOverviewCache,
  setVideoOverviewCacheRange,
} from "./video-overview-data.js";

/**
 * Public facade for the dashboard video read model.
 *
 * Querying, aggregation and cache state live in video-overview-data.ts. This
 * module assembles the stable overview shape consumed by dashboard renderers.
 */
export function videoOverview(
  backendDb: BackendDb,
  start: Date,
  end: Date,
  timeZone: string,
  cache: VideoOverviewCache,
  destination?: string,
): VideoOverview {
  const startedAt = Date.now();
  const bundle = videoAnalyticsBundle(backendDb, start, end, cache);
  const bundleMs = Date.now() - startedAt;
  const prepStartedAt = Date.now();
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  // Two populations, deliberately not one. Reach is a property of the calendar
  // period — every clip alive in it keeps earning views — while a publication
  // list is a property of the period's own output. Scoping reach to the clips
  // published in the window made the selected day answer a different question
  // than every other day on the same chart.
  // A selected destination narrows the whole half — reach, norm, platforms and
  // the publication list alike — exactly as a selected text platform narrows
  // the other one.
  const reachRows = destination
    ? bundle.rows.filter((row) => {
        const own = destinationFor(bundle.catalogue, row);
        return own !== null && destinationKey(own) === destination;
      })
    : bundle.rows;
  const rows = reachRows.filter((row) => Boolean(row.publishedAt && row.publishedAt >= startIso && row.publishedAt <= endIso));
  const snapshots = new Map(reachRows.map((row) => [row.id, bundle.snapshots.get(row.id) ?? []]));
  const periodDays = calendarDays(start, end, timeZone);
  const prepMs = Date.now() - prepStartedAt;
  // Five of these run per render. Two rounds of production measurement have now
  // been spent guessing which part of one costs the most, so it says so itself.
  const reachStartedAt = Date.now();
  const reachViews = periodReachByRow(bundle, reachRows, snapshots, periodDays, timeZone);
  const reachMs = Date.now() - reachStartedAt;
  const summaryStartedAt = Date.now();
  const summary = videoSummaryMetrics(backendDb, reachRows, snapshots, reachViews, periodDays, end, timeZone, cache);
  const summaryMs = Date.now() - summaryStartedAt;
  const itemsStartedAt = Date.now();
  const subscribersByRow = periodSubscribersByRow(bundle, reachRows, snapshots, periodDays, timeZone);
  // One row per clip, not per destination: the same clip on Shorts and on Reels
  // is one publication that went to two places, which is how the text side has
  // always read a post that went to Telegram and to Threads.
  const byDraft = new Map<number, TargetRow[]>();
  for (const row of rows) byDraft.set(row.videoDraftId, [...(byDraft.get(row.videoDraftId) ?? []), row]);
  const items = [...byDraft.values()]
    .map((draftRows) => {
      const destinations = draftRows
        .map((row) => {
          const destination = destinationFor(bundle.catalogue, row);
          const period = reachViews.get(row.id) ?? emptyDailyReach();
          return {
            target: row.target,
            label: destination?.label ?? videoLabel(row.target),
            locale: destination ? destination.locale.toUpperCase() : (row.locale?.toUpperCase() ?? null),
            providerAccountId: row.providerAccountId,
            url: row.externalUrl,
            views: period.views,
            reactions: period.reactions,
            replies: period.replies,
          };
        })
        .sort((left, right) => right.views - left.views);
      const totals = draftRows.reduce(
        (all, row) => {
          const history = snapshots.get(row.id) ?? [];
          const period = reachViews.get(row.id) ?? emptyDailyReach();
          const periodEnd = latestAtOrBefore(history, end)?.metrics ?? emptyMetrics();
          const lifetime = history.at(-1)?.metrics ?? emptyMetrics();
          const subscribers = subscribersByRow.get(row.id) ?? null;
          all.views += period.views;
          all.reactions += period.reactions;
          all.replies += period.replies;
          all.afterPeriodViews += Math.max(0, lifetime.views - periodEnd.views);
          all.lifetimeViews += lifetime.views;
          if (subscribers !== null) all.subscribers = (all.subscribers ?? 0) + subscribers;
          return all;
        },
        { views: 0, reactions: 0, replies: 0, afterPeriodViews: 0, lifetimeViews: 0, subscribers: null as number | null },
      );
      const first = draftRows[0];
      return {
        key: publicationRef("video", first?.videoDraftId ?? 0),
        destinations,
        title: first?.label || "Без названия",
        url: destinations.find((destination) => destination.url)?.url ?? null,
        publishedAt: draftRows.map((row) => row.publishedAt).sort()[0] ?? null,
        ...totals,
      };
    })
    .sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""));

  const itemsMs = Date.now() - itemsStartedAt;
  const platformsStartedAt = Date.now();
  const totals = reachRows.reduce(
    (all, row) => {
      const period = reachViews.get(row.id);
      all.views += period?.views ?? 0;
      all.reactions += period?.reactions ?? 0;
      all.replies += period?.replies ?? 0;
      return all;
    },
    { views: 0, reactions: 0, replies: 0, posts: items.length },
  );

  // One row per declared destination, filtered to the ones this Studio actually
  // has: publications in the period, or an audience snapshot. Listing the whole
  // catalogue would put an English channel on a Studio that has never had one;
  // listing only what published would drop a real channel on a quiet week.
  const counted = bundle.catalogue.map((destination) => {
    const earning = reachRows.filter((row) => destinationFor(bundle.catalogue, row)?.profile === destination.profile);
    return {
      destination,
      earning,
      hasPublication: bundle.historicalDestinations.has(destinationKey(destination)),
      own: bundle.followers.get(destination.profile) ?? null,
    };
  });
  const platforms = counted
    .map(({ destination, earning, hasPublication, own }) => ({
      target: destination.target as string,
      label: destination.label,
      locales: [destination.locale.toUpperCase()],
      views: earning.reduce((sum, row) => sum + (reachViews.get(row.id)?.views ?? 0), 0),
      followers: own,
      active: hasPublication || own !== null,
    }))
    .filter((row) => row.active)
    .map(({ active: _active, ...row }) => row);

  const platformsMs = Date.now() - platformsStartedAt;
  const dailyStartedAt = Date.now();
  const daily = aggregateDailyMetrics(backendDb, bundle, reachRows, snapshots, periodDays, timeZone, cache);
  const dailyMs = Date.now() - dailyStartedAt;
  const eventsStartedAt = Date.now();
  const events = viewEvents(reachRows, snapshots, start, end);
  const eventsMs = Date.now() - eventsStartedAt;
  log("info", "video overview timing", {
    days: periodDays.length,
    rows: reachRows.length,
    bundleMs,
    prepMs,
    reachMs,
    summaryMs,
    itemsMs,
    platformsMs,
    dailyMs,
    eventsMs,
    totalMs: Date.now() - startedAt,
  });

  return {
    items,
    totals,
    summary,
    platforms,
    dailyByDay: daily,
    viewEvents: events,
  };
}
