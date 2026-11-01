import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales } from "../db/schema.js";
import { materializeSiteMedia, siteMediaSource } from "../delivery/site-media.js";
import type { BackendConfig } from "../foundation/config.js";
import { publicationSourceFromDb } from "../publishing/source-store.js";

/** Replace the old viewer projections, newest first. Each locale changes only
 * after its complete gallery exists; an unavailable upload leaves it intact. */
export async function backfillSiteMedia(
  backendDb: BackendDb,
  config: BackendConfig,
  apply: boolean,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const db = unsafeDb(backendDb).db;
  const rows = db
    .select({
      draftId: drafts.id,
      postId: drafts.postId,
      draftUpdatedAt: drafts.updatedAt,
      locale: postLocales.locale,
      updatedAt: postLocales.updatedAt,
      publishedAt: postLocales.publishedAt,
      media: postLocales.siteMediaJson,
    })
    .from(drafts)
    .innerJoin(postLocales, and(eq(postLocales.draftId, drafts.id), eq(postLocales.siteEnabled, 1)))
    .where(inArray(drafts.status, ["published", "failed"]))
    .orderBy(desc(drafts.postId))
    .all();
  const work = rows.flatMap((row) => {
    if (!row.postId || (row.locale !== "ru" && row.locale !== "en")) return [];
    const locale: "ru" | "en" = row.locale;
    if (row.publishedAt && new Date(row.publishedAt).getTime() > Date.now()) return [];
    if (!row.media?.some((item) => /-vertical\.(jpg|mp4)(?:[?#]|$)/.test(String(item.path ?? "")))) return [];
    const source = publicationSourceFromDb(db, row.postId).locales[locale];
    if (!source.media.length && !source.thread.some((part) => part.media.length)) return [];
    return [{ ...row, postId: row.postId, locale, source: siteMediaSource(source) }];
  });
  const selectedPosts = new Set<number>();
  for (const item of work) {
    if (selectedPosts.size < limit) selectedPosts.add(item.postId);
  }
  const selected = work.filter((item) => selectedPosts.has(item.postId));
  const plan = selected.map((item) => ({ post_id: item.postId, locale: item.locale, media: item.source.length }));
  let changed = 0;
  const failed: { post_id: number; locale: string; error: string }[] = [];
  if (apply) {
    for (const item of selected) {
      try {
        const media = await materializeSiteMedia(config, item.postId, item.locale, item.source, fetchImpl);
        const result = db
          .update(postLocales)
          .set({ siteMediaJson: media, updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(postLocales.draftId, item.draftId),
              eq(postLocales.locale, item.locale),
              eq(postLocales.siteEnabled, 1),
              eq(postLocales.updatedAt, item.updatedAt),
              sql`EXISTS (SELECT 1 FROM ${drafts} WHERE ${drafts.id} = ${item.draftId}
                AND ${drafts.updatedAt} = ${item.draftUpdatedAt} AND ${drafts.status} IN ('published', 'failed'))`,
            ),
          )
          .returning({ draftId: postLocales.draftId })
          .all();
        if (result.length !== 1) throw new Error("Publication changed while its media was being restored");
        changed += 1;
      } catch (error) {
        failed.push({ post_id: item.postId, locale: item.locale, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return {
    ok: failed.length === 0,
    apply,
    posts: selectedPosts.size,
    locale_projections: selected.length,
    changed,
    remaining: work.length - changed,
    failed,
    plan,
  };
}
