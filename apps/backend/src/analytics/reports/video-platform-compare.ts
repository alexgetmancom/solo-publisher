import { type BackendDb, unsafeDb } from "../../db/client.js";
import { metricNumber } from "../snapshots/creator-store.js";

/** Below this the comparison is two anecdotes rather than two audiences. */
const CONFIDENT_SAMPLE = 5;
const WEAK_SAMPLE = 3;

type Row = {
  videoDraftId: number;
  target: string;
  game: string | null;
  hook: string | null;
  publishedAt: string;
  metrics: string | null;
};

/**
 * The same video, two audiences, one moment.
 *
 * Nearly every video here goes out to both platforms at the same minute, which
 * is the one condition under which a platform comparison means anything: the
 * content, the topic and the hour are held still, so what is left is the
 * platform. Reported as each video's ratio, and as the median of those ratios
 * -- never as one platform's total against the other's, which is just a
 * comparison of audience sizes.
 */
export function platformComparison(backendDb: BackendDb, options: { days: number }): Record<string, unknown> {
  const since = new Date(Date.now() - options.days * 86_400_000).toISOString();
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT t.video_draft_id AS videoDraftId, t.target AS target, d.game AS game, d.hook AS hook, t.published_at AS publishedAt,
              s.metrics_json AS metrics
         FROM video_targets t
         JOIN video_drafts d ON d.id = t.video_draft_id
         LEFT JOIN video_metric_snapshots s ON s.id = (SELECT MAX(id) FROM video_metric_snapshots WHERE video_target_id = t.id)
        WHERE t.status = 'published' AND t.published_at >= ?`,
    )
    .all(since) as Row[];
  const byDraft = new Map<number, Row[]>();
  for (const row of rows) byDraft.set(row.videoDraftId, [...(byDraft.get(row.videoDraftId) ?? []), row]);
  const pairs = [...byDraft.entries()]
    .map(([videoDraftId, targets]) => {
      const youtube = targets.find((target) => target.target === "youtube_shorts");
      const instagram = targets.find((target) => target.target === "instagram_reels");
      if (!youtube || !instagram) return null;
      const youtubeViews = views(youtube);
      const instagramViews = views(instagram);
      if (!youtubeViews || !instagramViews) return null;
      return {
        ref: `video:${videoDraftId}`,
        game: youtube.game ?? instagram.game,
        hook: youtube.hook ?? instagram.hook,
        publishedAt: youtube.publishedAt,
        youtubeViews,
        instagramViews,
        // Above 1 means the Shorts feed carried it further than the Reels feed.
        youtubePerInstagram: Math.round((youtubeViews / instagramViews) * 100) / 100,
      };
    })
    .filter((pair): pair is NonNullable<typeof pair> => pair != null);
  const ratios = pairs.map((pair) => pair.youtubePerInstagram);
  return {
    window: { days: options.days, since },
    pairedVideos: pairs.length,
    unpaired: byDraft.size - pairs.length,
    medianRatio: median(ratios),
    wonOnYouTube: pairs.filter((pair) => pair.youtubePerInstagram > 1).length,
    wonOnInstagram: pairs.filter((pair) => pair.youtubePerInstagram < 1).length,
    byGenre: grouped(backendDb, pairs),
    widestGaps: [...pairs]
      .sort((left, right) => Math.abs(Math.log(right.youtubePerInstagram)) - Math.abs(Math.log(left.youtubePerInstagram)))
      .slice(0, 10),
    reading: [
      "Only videos published to both platforms are counted, so the content and the hour are held still and the platform is what differs.",
      "`youtubePerInstagram` above 1 means the Shorts feed carried that video further than the Reels feed; the median of the ratios is the honest summary, not one platform's total against the other's.",
      "A genre with fewer than five paired videos is marked and should not be read as a finding.",
    ],
  };
}

function grouped(backendDb: BackendDb, pairs: Array<{ game: string | null; youtubePerInstagram: number }>): Array<Record<string, unknown>> {
  const genres = new Map<string, string[]>();
  for (const row of unsafeDb(backendDb).sqlite.prepare("SELECT name, genres FROM games").all() as Array<{
    name: string;
    genres: string | null;
  }>) {
    try {
      const parsed = row.genres ? (JSON.parse(row.genres) as unknown) : [];
      genres.set(row.name, Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      genres.set(row.name, []);
    }
  }
  const byGenre = new Map<string, number[]>();
  for (const pair of pairs)
    for (const genre of (pair.game ? genres.get(pair.game) : []) ?? [])
      byGenre.set(genre, [...(byGenre.get(genre) ?? []), pair.youtubePerInstagram]);
  return [...byGenre.entries()]
    .map(([genre, ratios]) => ({
      genre,
      videos: ratios.length,
      medianRatio: median(ratios),
      confidence: ratios.length >= CONFIDENT_SAMPLE ? "ok" : ratios.length >= WEAK_SAMPLE ? "low" : "anecdotal",
    }))
    .sort((left, right) => right.medianRatio - left.medianRatio);
}

function views(row: Row): number {
  if (!row.metrics) return 0;
  try {
    return metricNumber((JSON.parse(row.metrics) as Record<string, unknown>).views);
  } catch {
    return 0;
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return Math.round(value * 100) / 100;
}
