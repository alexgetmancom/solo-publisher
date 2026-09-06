import { type BackendDb, unsafeDb } from "../../db/client.js";
import { metricNumber } from "../snapshots/creator-store.js";

/** Below this a keyword's average is one video wearing a label. */
const CONFIDENT_SAMPLE = 5;
const WEAK_SAMPLE = 3;

/** How many keywords to report per surface. The tail is thousands of words
 * used once, and it says nothing. */
const TOP_KEYWORDS = 40;

type Surface = "youtube_tags" | "instagram_hashtags";

type Row = { videoDraftId: number; target: string; metadata: string; views: number; publishedAt: string | null };

type Tagged = { videoDraftId: number; surface: Surface; keyword: string; views: number };

const HASHTAG = /#([\p{L}\p{N}_]{2,40})/gu;

/**
 * What the words published with a video are worth.
 *
 * Two surfaces, kept apart because they are different systems: YouTube's tags
 * are invisible metadata the recommender reads, Instagram's hashtags are text
 * a viewer sees. Comparing a word's videos against the platform's own median
 * is the only fair reading -- an absolute average just ranks the words that
 * happened to sit on the hits.
 */
export function videoKeywordReport(backendDb: BackendDb, options: { days: number; limit: number }): Record<string, unknown> {
  const since = new Date(Date.now() - options.days * 86_400_000).toISOString();
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT t.video_draft_id AS videoDraftId, t.target AS target, t.metadata_json AS metadata, t.published_at AS publishedAt,
              CAST(COALESCE(json_extract(s.metrics_json, '$.views'), 0) AS INTEGER) AS views
         FROM video_targets t
         LEFT JOIN video_metric_snapshots s ON s.id = (SELECT MAX(id) FROM video_metric_snapshots WHERE video_target_id = t.id)
        WHERE t.status = 'published' AND t.published_at >= ?`,
    )
    .all(since) as Row[];
  const tagged: Tagged[] = [];
  const viewsByTarget = { youtube_tags: [] as number[], instagram_hashtags: [] as number[] };
  for (const row of rows) {
    const surface: Surface | null =
      row.target === "youtube_shorts" ? "youtube_tags" : row.target === "instagram_reels" ? "instagram_hashtags" : null;
    if (!surface) continue;
    viewsByTarget[surface].push(row.views);
    for (const keyword of new Set(keywords(row.metadata, surface)))
      tagged.push({ videoDraftId: row.videoDraftId, surface, keyword, views: row.views });
  }
  return {
    window: { days: options.days, since },
    surfaces: Object.fromEntries(
      (["youtube_tags", "instagram_hashtags"] as const).map((surface) => [
        surface,
        summarise(
          tagged.filter((entry) => entry.surface === surface),
          viewsByTarget[surface],
          options.limit,
        ),
      ]),
    ),
    shared: shared(tagged),
    reading: [
      "`lift` is the keyword's median views against the platform's own median for the window: 1.0 is average, 2.0 is twice the median video.",
      "A keyword riding on every video (the account's standard set) has a lift near 1.0 by construction and says nothing — read the ones that are used on some videos and not others.",
      "Correlation only: these words were chosen for videos, not assigned at random, so a high lift says which topics did well, not that the word caused it.",
      "YouTube tags are metadata nobody sees; Instagram hashtags are text in the caption. They reach different systems and are not comparable to each other.",
    ],
  };
}

function summarise(entries: Tagged[], allViews: number[], limit: number): Record<string, unknown> {
  const baseline = median(allViews);
  const byKeyword = new Map<string, number[]>();
  for (const entry of entries) byKeyword.set(entry.keyword, [...(byKeyword.get(entry.keyword) ?? []), entry.views]);
  const keywords = [...byKeyword.entries()]
    .map(([keyword, views]) => ({
      keyword,
      videos: views.length,
      medianViews: median(views),
      lift: baseline > 0 ? Math.round((median(views) / baseline) * 100) / 100 : null,
      confidence: views.length >= CONFIDENT_SAMPLE ? "ok" : views.length >= WEAK_SAMPLE ? "low" : "anecdotal",
      onEveryVideo: views.length === allViews.length && allViews.length > 0,
    }))
    .sort((left, right) => (right.lift ?? 0) - (left.lift ?? 0));
  return {
    videos: allViews.length,
    medianViews: baseline,
    distinctKeywords: byKeyword.size,
    keywordsPerVideo: allViews.length ? Math.round((entries.length / allViews.length) * 10) / 10 : 0,
    best: keywords.filter((entry) => entry.videos >= WEAK_SAMPLE).slice(0, Math.min(limit, TOP_KEYWORDS)),
    worst: keywords
      .filter((entry) => entry.videos >= WEAK_SAMPLE)
      .slice(-Math.min(limit, TOP_KEYWORDS))
      .reverse(),
  };
}

/** Words that a video carries on both surfaces at once. A hashtag written into
 * the caption and the same word set as a YouTube tag is one editorial choice
 * made twice, and this is where the two systems can be compared on it. */
function shared(tagged: Tagged[]): Array<Record<string, unknown>> {
  const youtube = new Map<string, number[]>();
  const instagram = new Map<string, number[]>();
  for (const entry of tagged) {
    const bucket = entry.surface === "youtube_tags" ? youtube : instagram;
    const key = normalise(entry.keyword);
    bucket.set(key, [...(bucket.get(key) ?? []), entry.views]);
  }
  return [...youtube.entries()]
    .filter(([keyword]) => instagram.has(keyword))
    .map(([keyword, youtubeViews]) => ({
      keyword,
      youtube: { videos: youtubeViews.length, medianViews: median(youtubeViews) },
      instagram: {
        videos: (instagram.get(keyword) ?? []).length,
        medianViews: median(instagram.get(keyword) ?? []),
      },
    }))
    .sort((left, right) => right.youtube.videos + right.instagram.videos - (left.youtube.videos + left.instagram.videos))
    .slice(0, TOP_KEYWORDS);
}

function keywords(metadata: string, surface: Surface): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (surface === "youtube_tags") {
    const tags = parsed.tags;
    return Array.isArray(tags) ? tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean) : [];
  }
  const caption = typeof parsed.caption === "string" ? parsed.caption : "";
  return [...caption.matchAll(HASHTAG)].map((match) => `#${(match[1] ?? "").toLowerCase()}`);
}

/** A hashtag and a tag spell the same word differently: `#коопвыживач` against
 * `кооп выживач`. Comparing the two surfaces needs one spelling. */
function normalise(keyword: string): string {
  return keyword
    .replace(/^#/u, "")
    .replace(/[\s_-]/gu, "")
    .toLowerCase();
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return Math.round(metricNumber(value));
}
