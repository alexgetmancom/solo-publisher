import type { BackendDb } from "../../db/client.js";
import { audienceDemographicsReport } from "../collection/instagram-demographics.js";
import { videoDigest } from "./video-digest.js";
import { videoKeywordReport } from "./video-keywords.js";
import { videoPerformanceReport } from "./video-performance.js";
import { platformComparison } from "./video-platform-compare.js";

/** A slot or a keyword with fewer videos than this is not said out loud here.
 * The full reports still carry it, marked; a brief that repeats every thin
 * number is a brief nobody can act on. */
const MIN_SAMPLE = 5;

/** How many of each kind of thing the brief names. */
const TOP = 3;

type Facet = { taggedShare?: number; values?: Array<{ value: string; videos: number; medianViews: number; confidence: string }> };

/**
 * Everything worth knowing in one call, for someone who asks once a week.
 *
 * It is a composition of the reports beneath it, not a new calculation: each
 * section names the command that shows its full working, so a question that
 * starts here can be finished there. Only findings that clear a sample bar
 * appear; the rest is deliberately left in the detailed reports.
 */
export function studioBrief(backendDb: BackendDb, options: { days: number; timeZone: string }): Record<string, unknown> {
  const digest = videoDigest(backendDb, { days: options.days, timeZone: options.timeZone });
  const performance = videoPerformanceReport(backendDb, { days: 30, limit: 5, timeZone: options.timeZone });
  const keywords = videoKeywordReport(backendDb, { days: 30, limit: 40 });
  const demographics = audienceDemographicsReport(backendDb);
  const comparison = platformComparison(backendDb, { days: 30 });
  const byTag = performance.byTag as Record<string, Facet>;
  return {
    window: { digestDays: options.days, analysisDays: 30, timeZone: options.timeZone },
    week: { platforms: digest.platforms, best: digest.best, breakingOut: digest.breakingOut, source: "digest" },
    whenToPublish: {
      weekday: bestSlots(performance, "weekday"),
      weekend: bestSlots(performance, "weekend"),
      source: "video-report → publishHours",
      note: `Only slots with ${MIN_SAMPLE} or more videos are listed here.`,
    },
    whatToPublish: {
      genre: topValues(byTag.genre),
      playerMode: topValues(byTag.playerMode),
      taggedShare: { game: byTag.game?.taggedShare ?? 0, genre: byTag.genre?.taggedShare ?? 0, hook: byTag.hook?.taggedShare ?? 0 },
      source: "video-report → byTag, games",
    },
    words: {
      youtube: topKeywords(keywords, "youtube_tags"),
      instagram: topKeywords(keywords, "instagram_hashtags"),
      source: "keywords",
    },
    platforms: {
      pairedVideos: comparison.pairedVideos,
      medianYouTubePerInstagram: comparison.medianRatio,
      wonOnYouTube: comparison.wonOnYouTube,
      wonOnInstagram: comparison.wonOnInstagram,
      source: "platform-compare",
    },
    audience: (demographics.captures as Array<Record<string, unknown>>).map((capture) => ({
      platform: capture.platform,
      metric: capture.metric,
      capturedOn: capture.capturedOn,
      top: topDimensions(capture.dimensions as Record<string, Array<{ label: string; value: number; share: number }>>),
      source: "audience-demographics",
    })),
    collection: performance.collection,
    nextSteps: nextSteps(byTag, performance, demographics),
    reading: [
      "A summary of the reports underneath it: each section names the command that shows its full working.",
      "Anything thin has already been dropped here rather than shown with a warning — for the whole picture, including the uncertain parts, read the named report.",
      "Nothing in here is a cause: these are the numbers of what was published, not an experiment.",
    ],
  };
}

function bestSlots(performance: Record<string, unknown>, mode: "weekday" | "weekend"): Array<Record<string, unknown>> {
  const hours = (performance.publishHours as Record<string, Record<string, Array<Record<string, unknown>>>>)[mode] ?? {};
  return Object.entries(hours)
    .flatMap(([platform, slots]) =>
      slots
        .filter((slot) => Number(slot.videos) >= MIN_SAMPLE && !slot.dominatedBySingleVideo)
        .map((slot) => ({ platform, hourLocal: slot.hourLocal, videos: slot.videos, medianViews: slot.medianViews })),
    )
    .sort((left, right) => Number(right.medianViews) - Number(left.medianViews))
    .slice(0, TOP);
}

function topValues(facet: Facet | undefined): Array<Record<string, unknown>> {
  return (facet?.values ?? [])
    .filter((value) => value.videos >= MIN_SAMPLE)
    .slice(0, TOP)
    .map((value) => ({ value: value.value, videos: value.videos, medianViews: value.medianViews }));
}

function topKeywords(keywords: Record<string, unknown>, surface: string): Array<Record<string, unknown>> {
  const data = (keywords.surfaces as Record<string, { best?: Array<Record<string, unknown>> }>)[surface];
  return (data?.best ?? [])
    .filter((entry) => Number(entry.videos) >= MIN_SAMPLE && !entry.onEveryVideo)
    .slice(0, TOP)
    .map((entry) => ({ keyword: entry.keyword, videos: entry.videos, lift: entry.lift }));
}

function topDimensions(
  dimensions: Record<string, Array<{ label: string; value: number; share: number }>>,
): Record<string, Array<Record<string, unknown>>> {
  return Object.fromEntries(
    Object.entries(dimensions).map(([dimension, values]) => [
      dimension,
      values.slice(0, 2).map((value) => ({ label: value.label, share: value.share })),
    ]),
  );
}

/** What is missing rather than what is known. A weekly reader cannot see that
 * a field is empty; the brief has to say it. */
function nextSteps(byTag: Record<string, Facet>, performance: Record<string, unknown>, demographics: Record<string, unknown>): string[] {
  const steps: string[] = [];
  if ((byTag.hook?.taggedShare ?? 0) < 20)
    steps.push("Hooks are not tagged, so nothing here can answer which opening holds viewers. `video-tag --ref video:N --hook …`");
  if ((byTag.game?.taggedShare ?? 0) < 80) steps.push("Some videos carry no game, so genre grouping covers less than the window.");
  if (!(performance.heatmaps as unknown[])?.length)
    steps.push(
      "No audience heatmap has been captured: read one in YouTube Studio or Instagram Insights and store it with `audience-heatmap-import`.",
    );
  if (!(demographics.captures as unknown[])?.length) steps.push("No audience breakdown has been collected yet.");
  const failing = (performance.collection as { failing?: number } | undefined)?.failing ?? 0;
  if (failing > 0) steps.push(`${failing} targets are failing metric collection — see \`video-report\` → collection.`);
  return steps;
}
