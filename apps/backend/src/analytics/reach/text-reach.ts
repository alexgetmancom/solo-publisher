import type { PipelinePost } from "../pipeline-payload.js";
import type { XActivityDashboardItem, XActivityMetricSample } from "../x-activity-dashboard.js";
import type { ReachCounters, ReachSample, ReachSeries } from "./daily-reach.js";

/**
 * The text feed's adapters onto the shared reach vocabulary.
 *
 * Publications carry a cumulative counter per (post, destination) in
 * `metric_samples`; standalone X activity carries the same shape in
 * `x_activity_metric_snapshots`. Both become `ReachSeries`, so the text half of
 * the overview is computed by exactly the code that computes the video half.
 */

/** Counter names as the collectors write them, mapped onto the shared four.
 * One map for both feeds: an X export's `likes` column and a collector's
 * `likes` are the same count, and reading the export's `interactions` here
 * instead put engagements — clicks, profile visits, expands — on the line the
 * publications spell out in likes. */
const COUNTER_OF: Record<string, keyof ReachCounters> = {
  views: "views",
  bot_views: "views",
  likes: "reactions",
  replies: "replies",
  reposts: "reposts",
};

type RawSample = { at: number; value: number };

export type XActivitySeries = ReachSeries & { linkedPublicationKey: string | null };

/**
 * `coveredByXActivity` names the posts whose tweet the X collector reports
 * directly. That row is the fresher source for the same tweet, so the post's own
 * `x` series steps aside rather than being added to it.
 */
export function textReachSeries(
  posts: readonly PipelinePost[],
  targetIds: readonly string[],
  coveredByXActivity: ReadonlySet<string> = new Set(),
): ReachSeries[] {
  const series: ReachSeries[] = [];
  for (const post of posts) {
    for (const target of targetIds) {
      if (target === "x" && post.publication_key && coveredByXActivity.has(post.publication_key)) continue;
      if (!isPublished(post, target)) continue;
      const metrics = post.metrics?.[target];
      if (!metrics) continue;
      const observed = new Map<string, RawSample[]>();
      const lifetime: ReachCounters = { views: 0, reactions: 0, replies: 0, reposts: 0 };
      for (const [name, counter] of Object.entries(COUNTER_OF)) {
        const metric = metrics[name];
        if (!metric) continue;
        lifetime[counter] += numeric(metric.value);
        for (const sample of metric.samples ?? []) {
          const at = Date.parse(String(sample.sampled_at ?? ""));
          if (Number.isNaN(at)) continue;
          const list = observed.get(name) ?? [];
          list.push({ at, value: numeric(sample.value) });
          observed.set(name, list);
        }
      }
      series.push({
        publishedAt: post.date ?? null,
        target,
        samples: alignSamples(observed, post.date ?? null, lifetime),
      });
    }
  }
  return series;
}

/** Where a reply or a repost lands, kept apart from `x` itself. A thread earns
 * real views and they belong on the account's account of itself, but they are
 * not something that was published: folded into `x` they would be divided by a
 * count of editorial posts that never included them. */
export const X_CONVERSATION_TARGET = "x_conversation";

/** Every tweet in the window, standalone or crossposted, with its link back to
 * the publication it came from. */
export function xActivityReachSeries(
  items: readonly XActivityDashboardItem[],
  snapshots: readonly XActivityMetricSample[],
  start: Date,
  end: Date,
): XActivitySeries[] {
  const startMs = start.getTime();
  const endMs = end.getTime();
  const wanted = items.filter((item) => {
    const publishedAt = Date.parse(item.publishedAt);
    return publishedAt >= startMs && publishedAt <= endMs;
  });
  if (!wanted.length) return [];
  const wantedIds = new Set(wanted.map((item) => item.xPostId));
  const byItem = new Map<string, Map<string, RawSample[]>>();
  for (const snapshot of snapshots) {
    if (!wantedIds.has(snapshot.xPostId)) continue;
    if (!COUNTER_OF[snapshot.metricName]) continue;
    const at = Date.parse(snapshot.sampledAt);
    if (Number.isNaN(at) || at > endMs) continue;
    const observed = byItem.get(snapshot.xPostId) ?? new Map<string, RawSample[]>();
    const list = observed.get(snapshot.metricName) ?? [];
    list.push({ at, value: numeric(snapshot.value) });
    observed.set(snapshot.metricName, list);
    byItem.set(snapshot.xPostId, observed);
  }

  return wanted.map((item) => ({
    publishedAt: item.publishedAt,
    linkedPublicationKey: item.linkedPublicationKey,
    target: item.kind === "standalone" ? "x" : X_CONVERSATION_TARGET,
    samples: alignSamples(byItem.get(item.xPostId) ?? new Map(), item.publishedAt, { views: 0, reactions: 0, replies: 0, reposts: 0 }),
  }));
}

/**
 * Folds per-counter observations into one timeline.
 *
 * Counters are collected together but stored apart, so a timestamp that only one
 * of them reports still has to carry the others' last known value — otherwise a
 * counter would appear to fall back to zero and the day's delta would vanish.
 * With nothing observed at all, the publication's lifetime figure stands as a
 * single reading at its publication time: the same number the dashboard showed
 * before any series existed.
 */
function alignSamples(observed: Map<string, RawSample[]>, publishedAt: string | null, lifetime: ReachCounters): ReachSample[] {
  const timestamps = [...new Set([...observed.values()].flatMap((list) => list.map((sample) => sample.at)))].sort((a, b) => a - b);
  if (!timestamps.length) {
    const at = Date.parse(String(publishedAt ?? ""));
    if (Number.isNaN(at)) return [];
    return [{ at: new Date(at), ...lifetime }];
  }
  for (const list of observed.values()) list.sort((left, right) => left.at - right.at);
  const cursors = new Map<string, number>();
  const carried = new Map<string, number>();
  return timestamps.map((at) => {
    const counters: ReachCounters = { views: 0, reactions: 0, replies: 0, reposts: 0 };
    for (const [name, list] of observed) {
      let index = cursors.get(name) ?? 0;
      let value = carried.get(name) ?? 0;
      while (index < list.length && (list[index]?.at ?? Number.POSITIVE_INFINITY) <= at) {
        value = numeric(list[index]?.value);
        index += 1;
      }
      cursors.set(name, index);
      carried.set(name, value);
      const counter = COUNTER_OF[name];
      // Views fold two collectors — page views and bot views — so each source
      // keeps its own last reading and the counter is their sum, never an
      // overwrite of one by the other.
      if (counter) counters[counter] += value;
    }
    return { at: new Date(at), ...counters };
  });
}

function isPublished(post: PipelinePost, target: string): boolean {
  if (post.targets?.[target]?.status === "published") return true;
  if (target === "telegram" && post.telegram_url) return true;
  if (target === "site_ru" && post.site_ru) return true;
  if (target === "site_en" && post.site_en) return true;
  return false;
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
