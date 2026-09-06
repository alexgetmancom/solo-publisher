import { type BackendDb, unsafeDb } from "../../db/client.js";

/** Below this a video's comment ratios are one or two people, and a ratio of
 * two is not a measurement. */
const MIN_COMMENTS_FOR_RATIOS = 10;

/** A comment that asks something. Russian and English question words plus the
 * mark itself: a Reels audience often drops the punctuation. */
const QUESTION = /[?？]|\b(как|что|где|когда|почему|зачем|какая|какой|сколько|кто|what|where|how|when|why|which)\b/iu;

/** The question that means the video failed to say what it was about. */
const WHICH_GAME = /(как|что)\s+(называется|за)\s+(игра|игру)|название\s+игры|what.{0,12}game|game\s+name/iu;

/** Someone asking for the next video. This is a content plan written by the
 * audience, and it was previously buried in a wall of comments nobody read. */
const REQUEST = /\b(сделай|снимай|сними|поиграй|обзор на|хочу|давай|попробуй|запили)\b/iu;

type CommentRow = {
  videoDraftId: number;
  label: string | null;
  game: string | null;
  platform: string;
  text: string;
  author: string | null;
  parentCommentId: string | null;
  publishedAt: string | null;
  views: number;
};

/**
 * What the comments say about a video, counted rather than judged.
 *
 * The channel collects a few hundred comments a month across a hundred and
 * seventy videos, so most videos have one or two. Averaging a language model's
 * opinion over two comments produces an opinion, not a measurement -- these
 * are the signals that survive small numbers, and the ones that do not are
 * only reported where there are enough comments to carry them.
 */
export function commentQuality(backendDb: BackendDb, options: { days: number; limit: number }): Record<string, unknown> {
  const since = new Date(Date.now() - options.days * 86_400_000).toISOString();
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT t.video_draft_id AS videoDraftId, d.label AS label, d.game AS game, c.platform AS platform,
              c.text AS text, c.author AS author, c.parent_comment_id AS parentCommentId, c.published_at AS publishedAt,
              CAST(COALESCE(json_extract(s.metrics_json, '$.views'), 0) AS INTEGER) AS views
         FROM social_comments c
         JOIN video_targets t ON t.id = c.video_target_id
         JOIN video_drafts d ON d.id = t.video_draft_id
         LEFT JOIN video_metric_snapshots s ON s.id = (SELECT MAX(id) FROM video_metric_snapshots WHERE video_target_id = t.id)
        WHERE t.published_at >= ?`,
    )
    .all(since) as CommentRow[];
  const byVideo = new Map<number, CommentRow[]>();
  for (const row of rows) byVideo.set(row.videoDraftId, [...(byVideo.get(row.videoDraftId) ?? []), row]);
  const videos = [...byVideo.entries()]
    .map(([videoDraftId, comments]) => {
      const views = Math.max(...comments.map((comment) => comment.views), 0);
      const questions = comments.filter((comment) => QUESTION.test(comment.text));
      return {
        ref: `video:${videoDraftId}`,
        label: comments[0]?.label ?? null,
        game: comments[0]?.game ?? null,
        comments: comments.length,
        uniqueAuthors: new Set(comments.map((comment) => comment.author ?? "")).size,
        replies: comments.filter((comment) => comment.parentCommentId).length,
        questions: questions.length,
        askedWhichGame: comments.filter((comment) => WHICH_GAME.test(comment.text)).length,
        views,
        // Comments per thousand views is the only way to compare a video that
        // reached two thousand people with one that reached a hundred thousand.
        commentsPerThousandViews: views ? Math.round((comments.length / views) * 1000 * 100) / 100 : null,
        ratiosMeaningful: comments.length >= MIN_COMMENTS_FOR_RATIOS,
      };
    })
    .sort((left, right) => right.comments - left.comments);
  const all = rows.length;
  return {
    window: { days: options.days, since },
    totals: {
      comments: all,
      videos: byVideo.size,
      uniqueAuthors: new Set(rows.map((row) => row.author ?? "")).size,
      replies: rows.filter((row) => row.parentCommentId).length,
      questions: rows.filter((row) => QUESTION.test(row.text)).length,
      askedWhichGame: rows.filter((row) => WHICH_GAME.test(row.text)).length,
      byPlatform: Object.fromEntries(
        ["youtube", "instagram"].map((platform) => [platform, rows.filter((row) => row.platform === platform).length]),
      ),
    },
    videos: videos.slice(0, options.limit),
    requests: rows
      .filter((row) => REQUEST.test(row.text))
      .slice(0, 40)
      .map((row) => ({ ref: `video:${row.videoDraftId}`, platform: row.platform, text: row.text.slice(0, 200) })),
    reading: [
      `A video with fewer than ${MIN_COMMENTS_FOR_RATIOS} comments carries \`ratiosMeaningful: false\`: its counts are real, its ratios are not.`,
      "`askedWhichGame` is the useful one: someone asking what the game is means the video did not say it clearly, whatever the views did.",
      "`requests` is what the audience asked for in its own words — a content plan written by the people who watched.",
      "Comments are a fraction of a percent of viewers everywhere; they say what a few people thought, never what the audience thought.",
    ],
  };
}
