import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";

/** The public URLs a site materialization may have changed, for IndexNow.
 *
 * This used to also write `content-index.json` and `content-memory.md` into the
 * site directory, and list them here. Nothing ever served that directory's
 * root, so search engines were told about two addresses that answered 404; the
 * site's own llms.txt, sitemap and search index say the same thing and are
 * served. */
export function siteUrlsForIndexNow(config: BackendConfig, backendDb: BackendDb): string[] {
  const ru = alias(postLocales, "ru");
  const en = alias(postLocales, "en");
  const rows = unsafeDb(backendDb)
    .db.select({
      postId: drafts.postId,
      slugRu: ru.slug,
      hasRu: ru.siteEnabled,
      slugEn: en.slug,
      hasEn: en.siteEnabled,
    })
    .from(drafts)
    .leftJoin(ru, and(eq(ru.draftId, drafts.id), eq(ru.locale, "ru")))
    .leftJoin(en, and(eq(en.draftId, drafts.id), eq(en.locale, "en")))
    .where(eq(drafts.status, "published"))
    .orderBy(desc(drafts.postId))
    .limit(200)
    .all();
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  return [
    `${base}/`,
    `${base}/feed.xml`,
    `${base}/llms.txt`,
    ...rows
      .flatMap((row) => [
        row.hasEn && row.slugEn ? `${base}/${row.postId}/${row.slugEn}/` : null,
        row.hasRu && row.slugRu ? `${base}/ru/${row.postId}/${row.slugRu}/` : null,
      ])
      .filter((url): url is string => Boolean(url)),
  ];
}
