import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { firstLine } from "../content/message.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { atomicWriteText } from "../fsUtils.js";

/** Delivery projection used to materialize the public-site content index. */
export function publishContentIndex(config: BackendConfig, backendDb: BackendDb): string[] {
  const ru = alias(postLocales, "ru");
  const en = alias(postLocales, "en");
  const rows = unsafeDb(backendDb)
    .db.select({
      postId: drafts.postId,
      updatedAt: drafts.updatedAt,
      slugRu: ru.slug,
      textRu: sql<string>`coalesce(${ru.approvedText}, ${ru.sourceText}, '')`,
      hasRu: ru.siteEnabled,
      slugEn: en.slug,
      textEn: sql<string>`coalesce(${en.approvedText}, ${en.sourceText}, '')`,
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
  const items = rows.map((row) => ({
    post_id: row.postId,
    title: firstLine(row.textEn || row.textRu, "Post"),
    url_ru: row.hasRu && row.slugRu ? `${base}/ru/${row.postId}/${row.slugRu}/` : null,
    url_en: row.hasEn && row.slugEn ? `${base}/${row.postId}/${row.slugEn}/` : null,
    updated_at: row.updatedAt,
  }));
  const updatedAt = new Date().toISOString();
  // This file is what LLM crawlers read, so the brand on it is whatever this
  // Studio says it is. A Studio that has not named itself is named by its own
  // host rather than by a constant, which would be somebody else's name.
  const brand = config.studio.site("en").name || new URL(base).hostname;
  atomicWriteText(
    path.join(config.SITE_PUBLIC_DIR, "content-index.json"),
    `${JSON.stringify({ updated_at: updatedAt, brand, site: base, items }, null, 2)}\n`,
  );
  const lines = [`# ${brand} Content Memory`, "", `Updated: ${updatedAt}`, ""];
  for (const item of items.slice(0, 80)) {
    lines.push(`## ${item.post_id} - ${item.title}`);
    if (item.url_ru) lines.push(`RU: ${item.url_ru}`);
    if (item.url_en) lines.push(`EN: ${item.url_en}`);
    lines.push("");
  }
  atomicWriteText(path.join(config.SITE_PUBLIC_DIR, "content-memory.md"), `${lines.join("\n").trimEnd()}\n`);
  return [
    `${base}/`,
    `${base}/feed.xml`,
    `${base}/llms.txt`,
    `${base}/content-index.json`,
    `${base}/content-memory.md`,
    ...items.flatMap((item) => [item.url_en, item.url_ru]).filter((url): url is string => Boolean(url)),
  ];
}
