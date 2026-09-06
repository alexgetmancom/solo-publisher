import { type BackendDb, unsafeDb } from "../../db/client.js";

/** Below this a grouping is arithmetic, not evidence. */
const CONFIDENT_SAMPLE = 5;
const WEAK_SAMPLE = 3;

/** A post this far above the median of its window is not a better post, it is a
 * different event: it reached a room nobody else in the window was in. */
const OUTLIER_MULTIPLE = 5;

/** Who a reply is written under, as X puts it in the text: an answer opens with
 * the handles it answers. The first is the post being answered; the rest are
 * everyone else already in the thread. */
const ANSWERS = /^@([A-Za-z0-9_]{1,15})/u;

/** A link X shortened, a hashtag, a mention — the three things a post carries
 * besides its words. */
const SHORTENED_LINK = /https:\/\/t\.co\/\w+/u;
const HASHTAG = /(^|\s)#\w/u;

/** Where the length of a post stops being a length and becomes a different kind
 * of post. Read off the account's own distribution rather than chosen: a line,
 * a paragraph, and everything longer. */
const ONE_LINER_CHARS = 90;
const PARAGRAPH_CHARS = 240;

type Row = {
  xPostId: string;
  kind: string;
  text: string;
  openingKind: string | null;
  openingLine: string | null;
  publishedAt: string | null;
  ageDays: number;
  views: number;
  likes: number;
  replies: number;
  follows: number;
  profileVisits: number;
};

export type PostReportOptions = { days: number; limit: number };

/**
 * What the account's own posts did, grouped by the choices their author made.
 *
 * The same question the videos are asked, put to the thing a reader decides on:
 * a post is chosen or scrolled past on its first line. And one axis the videos
 * do not have — whether the post was written under someone else's or as its
 * own, which are different acts with different returns.
 *
 * Everything here is a reading taken at a moment. X's own export is where these
 * numbers come from and it is taken by hand, so a post's figures are as fresh
 * as the last export and no fresher.
 */
export function postPerformanceReport(backendDb: BackendDb, options: PostReportOptions): Record<string, unknown> {
  const since = new Date(Date.now() - options.days * 86_400_000).toISOString();
  const rows = loadRows(backendDb, since);
  const standalone = rows.filter((row) => row.kind === "standalone");
  const replies = rows.filter((row) => row.kind === "reply");
  return {
    window: { days: options.days, since },
    coverage: {
      posts: rows.length,
      standalone: standalone.length,
      replies: replies.length,
      openingKindKnown: standalone.filter((row) => row.openingKind).length,
      lastReadingAt: rows.reduce<string | null>((latest, row) => (row.publishedAt && (!latest || row.publishedAt > latest) ? row.publishedAt : latest), null),
    },
    // Writing under someone else's post and writing your own are different
    // acts, and only one of them is answered by an opening at all.
    howItWasWritten: [
      describe("standalone", standalone),
      describe("reply", replies),
    ],
    // What the post is made of, beside what it says. Every one of these is a
    // choice its author makes and none of them was ever grouped by.
    howItWasBuilt: {
      length: [...group(standalone, (row) => lengthOf(row.text)).values()].map((slot) => describeSlot(slot.value, slot.rows)),
      carries: [
        describeSlot("with a link", standalone.filter((row) => SHORTENED_LINK.test(row.text))),
        describeSlot("no link", standalone.filter((row) => !SHORTENED_LINK.test(row.text))),
        describeSlot("with a hashtag", standalone.filter((row) => HASHTAG.test(row.text))),
      ],
    },
    // A reply is written under someone, and under whom is the whole choice.
    repliedTo: [...group(replies, (row) => row.text.match(ANSWERS)?.[1]).values()]
      .map((slot) => describeSlot(`@${slot.value}`, slot.rows))
      .sort((left, right) => Number(right.follows ?? 0) - Number(left.follows ?? 0) || Number(right.posts) - Number(left.posts))
      .slice(0, options.limit),
    openings: [...group(standalone, (row) => row.openingKind ?? undefined).values()]
      .map((slot): Record<string, unknown> => ({
        ...describeSlot(slot.value, slot.rows),
        // A kind is a label until you read the lines under it. These are the
        // ones that brought the most followers, which is the question a kind
        // is usually being asked.
        broughtMost: [...slot.rows]
          .sort((left, right) => right.follows - left.follows)
          .slice(0, 3)
          .map((row) => ({ post: row.xPostId, opening: row.openingLine?.slice(0, 100) ?? null, views: row.views, follows: row.follows })),
      }))
      .sort((left, right) => Number(right.medianViews ?? 0) - Number(left.medianViews ?? 0)),
    outliers: outliers(standalone).slice(0, options.limit),
    top: [...standalone]
      .sort((left, right) => right.views - left.views)
      .slice(0, options.limit)
      .map((row) => ({
        post: row.xPostId,
        publishedAt: row.publishedAt,
        ageDays: row.ageDays,
        openingKind: row.openingKind,
        opening: row.openingLine?.slice(0, 90) ?? null,
        views: row.views,
        likes: row.likes,
        follows: row.follows,
      })),
    reading: [
      "Figures come from X's own export, which is taken by hand: a post's numbers are as fresh as the last export and no fresher, and a post published since it has none at all.",
      "A post keeps gaining views for days, so a young post and an old one are not comparable by total views — `ageDays` is on every row for that reason.",
      "`howItWasWritten` compares a reply with a post of its own. A reply borrows the audience of whatever it answers, so its views say more about that post than about this one.",
      "`openings` covers standalone posts only: the first line of a reply was not written to stop a scroll.",
    "`repliedTo` groups replies by the account they were written under, ordered by the followers they brought. A reply's views belong to the post above it, so read this as which rooms are worth standing in, never as which reply was better written.",
    "`howItWasBuilt` groups by what a post is made of rather than what it says: how long it is and whether it carries a link. A link sends the reader away, and a platform that ranks by time spent sees that.",
    "How many lines a post was written in is not here, and cannot be: X's own export flattens every post into one line, so the newlines the author typed are gone. `openingLine` falls back to the first sentence for those, which is a proxy and is why the kind on them is a judgement about a sentence rather than a line.",
    "`followsPerPost` is the one figure that says what a kind is for: views are the room a post reached, and this is how many stayed. A kind can lead on one and trail on the other.",
      "An opening's kind is a model's judgement about one line, not a measurement — `post-openings-classify` prints the line beside the label.",
      `A post above ${OUTLIER_MULTIPLE}× the window's median is reported as an outlier rather than as a better post: it reached a room the others were not in, and averaging it back in describes nothing.`,
    ],
  };
}

function describe(value: string, rows: Row[]): Record<string, unknown> {
  return describeSlot(value, rows);
}

/** How long a post is, as one of three kinds rather than a number: a line, a
 * paragraph, or something longer. */
function lengthOf(text: string): string {
  if (text.length <= ONE_LINER_CHARS) return `a line (≤${ONE_LINER_CHARS} chars)`;
  if (text.length <= PARAGRAPH_CHARS) return `a paragraph (≤${PARAGRAPH_CHARS} chars)`;
  return `longer than a paragraph`;
}

function describeSlot(value: string, rows: Row[]): Record<string, unknown> {
  const views = rows.map((row) => row.views).filter((value) => value > 0);
  return {
    value,
    posts: rows.length,
    medianViews: views.length ? median(views) : null,
    medianLikes: rows.length ? median(rows.map((row) => row.likes)) : null,
    // What a post is for, on an account that grows one: how many people it put
    // in front of the profile, and how many stayed.
    medianProfileVisits: rows.length ? median(rows.map((row) => row.profileVisits)) : null,
    follows: rows.reduce((total, row) => total + row.follows, 0),
    followsPerPost: rows.length ? Math.round((rows.reduce((total, row) => total + row.follows, 0) / rows.length) * 100) / 100 : null,
    confidence: rows.length >= CONFIDENT_SAMPLE ? "ok" : rows.length >= WEAK_SAMPLE ? "low" : "anecdotal",
  };
}

function group(rows: Row[], of: (row: Row) => string | undefined): Map<string, { value: string; rows: Row[] }> {
  const groups = new Map<string, { value: string; rows: Row[] }>();
  for (const row of rows) {
    const key = of(row);
    if (!key) continue;
    const slot = groups.get(key) ?? { value: key, rows: [] };
    slot.rows.push(row);
    groups.set(key, slot);
  }
  return groups;
}

/** The posts that did not do better than the rest — they happened to something
 * else. Reported apart so the medians above stay about ordinary posts. */
function outliers(rows: Row[]): Array<Record<string, unknown>> {
  const views = rows.map((row) => row.views).filter((value) => value > 0);
  if (views.length < CONFIDENT_SAMPLE) return [];
  const typical = median(views);
  return rows
    .filter((row) => row.views >= typical * OUTLIER_MULTIPLE)
    .sort((left, right) => right.views - left.views)
    .map((row) => ({
      post: row.xPostId,
      publishedAt: row.publishedAt,
      openingKind: row.openingKind,
      opening: row.openingLine?.slice(0, 90) ?? null,
      views: row.views,
      typicalInWindow: typical,
      times: Math.round((row.views / Math.max(1, typical)) * 10) / 10,
      follows: row.follows,
    }));
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (!sorted.length) return 0;
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Every post of the window with its latest reading of each metric. */
function loadRows(backendDb: BackendDb, since: string): Row[] {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT item.x_post_id AS xPostId, item.kind AS kind, item.text AS text, item.opening_kind AS openingKind,
              item.opening_line AS openingLine, item.published_at AS publishedAt,
              snapshot.metric_name AS metricName, snapshot.value AS value
         FROM x_activity_items item
         JOIN x_activity_metric_snapshots snapshot ON snapshot.x_post_id = item.x_post_id
        WHERE item.published_at >= ?
          AND snapshot.sampled_at = (
            SELECT MAX(latest.sampled_at) FROM x_activity_metric_snapshots latest
             WHERE latest.x_post_id = item.x_post_id AND latest.metric_name = snapshot.metric_name)`,
    )
    .all(since) as Array<{
    xPostId: string;
    kind: string;
    openingKind: string | null;
    openingLine: string | null;
    publishedAt: string | null;
    metricName: string;
    value: number;
    text: string;
  }>;
  const byPost = new Map<string, Row>();
  const now = Date.now();
  for (const row of rows) {
    const post = byPost.get(row.xPostId) ?? {
      xPostId: row.xPostId,
      kind: row.kind,
      text: row.text,
      openingKind: row.openingKind,
      openingLine: row.openingLine,
      publishedAt: row.publishedAt,
      ageDays: row.publishedAt ? Math.round(((now - Date.parse(row.publishedAt)) / 86_400_000) * 10) / 10 : 0,
      views: 0,
      likes: 0,
      replies: 0,
      follows: 0,
      profileVisits: 0,
    };
    if (row.metricName === "views") post.views = row.value;
    if (row.metricName === "likes") post.likes = row.value;
    if (row.metricName === "replies") post.replies = row.value;
    if (row.metricName === "follows") post.follows = row.value;
    if (row.metricName === "profile_visits") post.profileVisits = row.value;
    byPost.set(row.xPostId, post);
  }
  return [...byPost.values()];
}
