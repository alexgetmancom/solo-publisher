import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { draftEntityLinks, drafts, knowledgeEntities, postLocales } from "../db/schema.js";
import { truncateUnicode } from "../foundation/text.js";
import { decisionCounters } from "./store.js";

/** What this Studio publishes, and what its editor keeps saying yes and no to.
 *
 * One object, built from the database and readable in full, is what both
 * producers are given and what the ranking scores against. The alternative --
 * a learned weight vector -- would be neither readable nor correctable, on a
 * few decisions a day. */

export type PublishedPost = { id: number; date: string; textRu: string; textEn: string };
export type EntityCluster = { slug: string; titleRu: string; titleEn: string | null; count: number };

export type EditorialProfile = {
  posts: PublishedPost[];
  clusters: EntityCluster[];
  /** Subjects with a decision history, best-received first. */
  favoured: string[];
  declined: string[];
};

/** Enough archive to see what this Studio is about without paying for a year of it. */
const PROFILE_POST_LIMIT = 24;
const PROFILE_CLUSTER_LIMIT = 12;
const PROFILE_SUBJECT_LIMIT = 8;
/** Below this many decisions a subject's rate is noise, and naming it in a
 * prompt would harden one accident into an editorial line. */
const MIN_DECISIONS_TO_NAME = 3;

export function editorialProfile(backendDb: BackendDb): EditorialProfile {
  const counters = decisionCounters(backendDb);
  const rated = [...counters.bySlug.entries()]
    .filter(([, entry]) => entry.accepted + entry.skipped >= MIN_DECISIONS_TO_NAME)
    .map(([slug, entry]) => ({ slug, rate: entry.accepted / (entry.accepted + entry.skipped) }))
    .sort((left, right) => right.rate - left.rate);
  return {
    posts: publishedPosts(backendDb),
    clusters: entityClusters(backendDb),
    favoured: rated
      .filter((entry) => entry.rate > 0.5)
      .slice(0, PROFILE_SUBJECT_LIMIT)
      .map((entry) => entry.slug),
    declined: rated
      .filter((entry) => entry.rate < 0.25)
      .slice(-PROFILE_SUBJECT_LIMIT)
      .map((entry) => entry.slug),
  };
}

/** The published archive, most recent first. This is the same read the editorial
 * inbox made before the radar absorbed it: a post is what it says, and its
 * publication date is whichever locale went out. */
function publishedPosts(backendDb: BackendDb): PublishedPost[] {
  const ru = alias(postLocales, "profile_ru");
  const en = alias(postLocales, "profile_en");
  return unsafeDb(backendDb)
    .db.select({
      postId: drafts.postId,
      date: sql<string>`coalesce(${ru.publishedAt}, ${en.publishedAt}, ${drafts.updatedAt})`,
      text: sql<string>`coalesce(${ru.approvedText}, ${ru.sourceText}, '')`,
      textEn: sql<string>`coalesce(${en.approvedText}, ${en.sourceText}, '')`,
    })
    .from(drafts)
    .leftJoin(ru, and(eq(ru.draftId, drafts.id), eq(ru.locale, "ru")))
    .leftJoin(en, and(eq(en.draftId, drafts.id), eq(en.locale, "en")))
    .where(eq(drafts.status, "published"))
    .orderBy(desc(sql`coalesce(${ru.publishedAt}, ${en.publishedAt}, ${drafts.updatedAt})`), desc(drafts.createdAt))
    .limit(PROFILE_POST_LIMIT)
    .all()
    .flatMap((post) => {
      const textRu = (post.text ?? "").trim();
      const textEn = (post.textEn ?? "").trim();
      return post.postId != null && (textRu || textEn)
        ? [{ id: post.postId, date: post.date, textRu: truncateUnicode(textRu, 900), textEn: truncateUnicode(textEn, 900) }]
        : [];
    });
}

function entityClusters(backendDb: BackendDb): EntityCluster[] {
  return unsafeDb(backendDb)
    .db.select({
      slug: knowledgeEntities.slug,
      titleRu: knowledgeEntities.titleRu,
      titleEn: knowledgeEntities.titleEn,
      count: sql<number>`count(*)`,
    })
    .from(draftEntityLinks)
    .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, draftEntityLinks.entityId))
    .groupBy(knowledgeEntities.id)
    .orderBy(desc(sql<number>`count(*)`))
    .limit(PROFILE_CLUSTER_LIMIT)
    .all();
}

/** Matches a finding to the subjects this Studio already writes about, by the
 * entity titles and slugs it holds. A finding that matches nothing is not
 * penalised: it is how a new subject enters. */
export function matchEntitySlugs(title: string, summary: string, clusters: EntityCluster[]): string[] {
  const haystack = `${title} ${summary}`.toLowerCase();
  return clusters
    .filter((cluster) => {
      const names = [cluster.slug.replace(/-/g, " "), cluster.titleRu, cluster.titleEn ?? ""].filter(Boolean);
      return names.some((name) => name.length >= 3 && haystack.includes(name.toLowerCase()));
    })
    .map((cluster) => cluster.slug);
}
