import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { publicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales, publicationTargets } from "../db/schema.js";

/** How many posts back the "usual" target set is learned from. Wide enough that
 * one skipped delivery cannot remove a target from the baseline, short enough
 * that a target retired months ago stops being noted as absent. */
const BASELINE_POSTS = 20;

type DeliveredTarget = { target: string; status: string; url: string | null };

type PublicationRow = {
  ref: string;
  postId: number | null;
  at: string | null;
  status: string;
  headline: string;
  targets: DeliveredTarget[];
  /** Targets that were created for this post and did not reach the audience. */
  undelivered: DeliveredTarget[];
  /** Usual targets this post never had a job for — a choice at composition time,
   * not a delivery gap. Reported so an unusual set is visible, never as a fault. */
  absentTargets: string[];
};

type RecentPublications = { expectedTargets: string[]; posts: PublicationRow[] };

type PublicationMatches = { query: string; expectedTargets: string[]; matches: PublicationRow[] };

/** Recent publications with their per-target delivery state. Answers "which post
 * is this, and where did it not go" — the question that otherwise takes a handful
 * of ad-hoc SQL queries against production before any repair can be scoped.
 *
 * Two different facts, kept apart. A target that was created and did not publish
 * is a failure and reads as one. A target this post never had is a decision made
 * when it was composed — most posts go everywhere, some deliberately go to one
 * channel — and calling that missing made every deliberate choice look like a
 * fault: eight such reports in one fortnight, all of them intentional, which is
 * how a report stops being read before the fortnight that matters. */
export function recentPublications(backendDb: BackendDb, limit: number): RecentPublications {
  const rows = publicationRows(backendDb, Math.max(limit, BASELINE_POSTS));
  const expectedTargets = usualTargets(rows);
  return { expectedTargets, posts: rows.slice(0, limit).map((row) => describe(row, expectedTargets)) };
}

/** Resolves a post by a fragment of its text, so a repair can be scoped from the
 * copy at hand instead of a post id nobody memorises. Missing targets are
 * measured against the same baseline `recent` uses: a match reported as "ok"
 * here and as a gap there would be two answers to one question. */
export function findPublication(backendDb: BackendDb, query: string): PublicationMatches {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("--query must not be empty");
  const expectedTargets = usualTargets(publicationRows(backendDb, BASELINE_POSTS));
  const matches = publicationRows(backendDb, 400)
    .filter((row) => row.text.toLowerCase().includes(needle))
    .slice(0, 10)
    .map((row) => describe(row, expectedTargets));
  return { query, expectedTargets, matches };
}

type RawRow = {
  publicationKey: string;
  postId: number | null;
  dateUtc: string | null;
  status: string;
  text: string;
  targets: DeliveredTarget[];
};

function publicationRows(backendDb: BackendDb, limit: number): RawRow[] {
  const ru = alias(postLocales, "recent_ru");
  const rows = unsafeDb(backendDb)
    .db.select({
      postId: drafts.postId,
      dateUtc: sql<string>`coalesce(${ru.publishedAt}, ${drafts.updatedAt})`,
      status: drafts.status,
      text: sql<string>`coalesce(${ru.approvedText}, ${ru.sourceText}, '')`,
    })
    .from(drafts)
    .leftJoin(ru, and(eq(ru.draftId, drafts.id), eq(ru.locale, "ru")))
    .where(sql`${drafts.postId} is not null`)
    .orderBy(desc(sql`coalesce(${ru.publishedAt}, ${drafts.updatedAt})`))
    .limit(limit)
    .all();
  if (rows.length === 0) return [];
  const delivered = unsafeDb(backendDb)
    .db.select({
      publicationKey: publicationTargets.publicationKey,
      target: publicationTargets.target,
      status: publicationTargets.status,
      url: publicationTargets.url,
    })
    .from(publicationTargets)
    .where(
      inArray(
        publicationTargets.publicationKey,
        rows.map((row) => publicationRef("post", row.postId as number)),
      ),
    )
    .orderBy(publicationTargets.target)
    .all();
  const byPost = new Map<string, DeliveredTarget[]>();
  for (const row of delivered) {
    const list = byPost.get(row.publicationKey) ?? [];
    list.push({ target: row.target, status: row.status, url: row.url });
    byPost.set(row.publicationKey, list);
  }
  return rows.map((row) => {
    const publicationKey = publicationRef("post", row.postId as number);
    return { ...row, publicationKey, text: row.text ?? "", targets: byPost.get(publicationKey) ?? [] };
  });
}

/** A target counts as expected once most of the recent posts carried it, so a
 * post that legitimately went to one channel only does not drag the baseline. */
function usualTargets(rows: RawRow[]): string[] {
  const baseline = rows.slice(0, BASELINE_POSTS);
  const seen = new Map<string, number>();
  for (const row of baseline) for (const target of row.targets) seen.set(target.target, (seen.get(target.target) ?? 0) + 1);
  const quorum = Math.max(Math.ceil(baseline.length / 2), 1);
  return [...seen]
    .filter(([, count]) => count >= quorum)
    .map(([target]) => target)
    .sort();
}

function describe(row: RawRow, expectedTargets: string[]): PublicationRow {
  const present = new Set(row.targets.map((target) => target.target));
  return {
    ref: row.publicationKey,
    postId: row.postId,
    at: row.dateUtc,
    status: row.status,
    headline: headline(row.text),
    targets: row.targets,
    undelivered: row.targets.filter((target) => target.status !== "published"),
    absentTargets: expectedTargets.filter((target) => !present.has(target)),
  };
}

/** The first line is the post's own headline; anything past it is body copy the
 * operator does not need to identify the post. */
function headline(text: string): string {
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/** One line per post. The JSON form carries every target and url and runs past
 * two hundred lines for five posts, which buries the one fact being looked for:
 * which post, and what did not go out. */
export function formatRecentPublications(report: RecentPublications): string {
  return [`expected targets: ${report.expectedTargets.join(", ") || "none"}`, "", ...report.posts.map(publicationLine)].join("\n");
}

export function formatPublicationMatches(report: PublicationMatches): string {
  if (report.matches.length === 0) return `no post matches ${JSON.stringify(report.query)}`;
  return report.matches.map(publicationLine).join("\n");
}

function publicationLine(post: PublicationRow): string {
  const failed = post.undelivered.map((target) => `${target.target}=${target.status}`);
  const trailer = [
    failed.length > 0 ? `FAILED ${failed.join(" ")}` : "ok",
    post.absentTargets.length > 0 ? `not sent: ${post.absentTargets.join(",")}` : "",
  ]
    .filter(Boolean)
    .join("  ");
  return `${post.ref.padEnd(9)} ${(post.at ?? "").slice(0, 16).replace("T", " ")}  ${post.targets.length} targets  ${trailer}\n            ${post.headline}`;
}
