import { and, eq, inArray, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales, postMetrics } from "../db/schema.js";
import { candidatesAwaitingOutcome, recordOutcome } from "./store.js";

/** What the stories this radar offered actually did, kept for good.
 *
 * Detailed samples are swept at 35 days. These two marks are not, because the
 * question they answer is asked over years and cannot be reconstructed later.
 *
 * They are read by the report and by nobody else. Ranking on them is the
 * obvious next step and the wrong one: at one or two publications a day, a
 * post's numbers are moved far more by its platform, its hour and the audience
 * that week than by its subject, so a ranker fed these would be learning the
 * schedule -- and would drift towards whatever is widest, which is the one
 * thing an editorial radar must not do. Changing the editorial line stays a
 * decision the operator makes after reading this, not one the radar makes for
 * them. */

const HORIZONS = { "24h": 24 * 3_600_000, "7d": 7 * 86_400_000 } as const;
type OutcomeHorizon = keyof typeof HORIZONS;

/** Measures every accepted candidate whose publication has passed a horizon. */
export function captureOutcomes(backendDb: BackendDb): number {
  const now = backendDb.clock.now();
  let captured = 0;
  for (const [horizon, span] of Object.entries(HORIZONS) as [OutcomeHorizon, number][]) {
    const before = new Date(now.getTime() - span).toISOString();
    for (const candidate of candidatesAwaitingOutcome(backendDb, horizon, before)) {
      if (candidate.draftId == null) continue;
      const publication = publishedPost(backendDb, candidate.draftId);
      if (!publication || publication.publishedAt >= before) continue;
      recordOutcome(backendDb, candidate.id, horizon, publicationMetrics(backendDb, publication.postId));
      captured += 1;
    }
  }
  return captured;
}

function publishedPost(backendDb: BackendDb, draftId: number): { postId: number; publishedAt: string } | null {
  const row = unsafeDb(backendDb)
    .db.select({
      postId: drafts.postId,
      publishedAt: sql<string | null>`min(${postLocales.publishedAt})`,
    })
    .from(drafts)
    .innerJoin(postLocales, eq(postLocales.draftId, drafts.id))
    .where(and(eq(drafts.id, draftId), sql`${postLocales.publishedAt} is not null`))
    .get();
  return row?.postId != null && row.publishedAt ? { postId: row.postId, publishedAt: row.publishedAt } : null;
}

/** Totals across every target the post went to. Comparing one platform's
 * absolute views with another's is meaningless; the sum is what "this story
 * reached people" means for a publication that goes to all of them at once. */
function publicationMetrics(backendDb: BackendDb, postId: number): { views: number; reactions: number; shares: number; replies: number } {
  const rows = unsafeDb(backendDb)
    .db.select({ metric: postMetrics.metricName, value: sql<number>`coalesce(sum(${postMetrics.value}), 0)` })
    .from(postMetrics)
    .where(
      and(
        eq(postMetrics.publicationKey, `post:${postId}`),
        inArray(postMetrics.metricName, ["views", "likes", "reposts", "shares", "replies", "comments"]),
      ),
    )
    .groupBy(postMetrics.metricName)
    .all();
  const total = (...names: string[]) => rows.filter((row) => names.includes(row.metric)).reduce((sum, row) => sum + row.value, 0);
  return { views: total("views"), reactions: total("likes"), shares: total("reposts", "shares"), replies: total("replies", "comments") };
}
