import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import * as z from "zod";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales } from "../db/schema.js";
import { loadPublicSiteFeed } from "../public/site-read-model.js";

const metadataSchema = z
  .object({
    version: z.literal(1),
    items: z
      .array(
        z
          .object({
            post_id: z.number().int().positive(),
            locale: z.enum(["ru", "en"]),
            text_sha256: z.string().regex(/^[a-f0-9]{64}$/),
            seo_title: z.string().trim().min(1).max(65).optional(),
            images: z
              .array(
                z
                  .object({
                    path: z.string().min(1),
                    alt: z.string().trim().min(1).max(500),
                  })
                  .strict(),
              )
              .default([]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export function siteMetadataInventory(backendDb: BackendDb) {
  return {
    version: 1 as const,
    items: loadPublicSiteFeed(backendDb).flatMap((post) =>
      (["ru", "en"] as const).flatMap((locale) => {
        if (!(locale === "ru" ? post.has_ru : post.has_en)) return [];
        const text = locale === "ru" ? post.text : post.text_en;
        const media = locale === "ru" ? post.media : post.media_en;
        return [
          {
            post_id: post.post_id,
            locale,
            text,
            text_sha256: textHash(text),
            seo_title: locale === "ru" ? post.seo_title_ru : post.seo_title_en,
            images: media.filter((item) => item.type !== "video").map((item) => ({ path: item.path, alt: item.alt ?? "" })),
          },
        ];
      }),
    ),
  };
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Import reviewed descriptions and search titles without republishing any target.
 * Every prerequisite is rechecked in the transaction and in the guarded write. */
export function applySiteMetadata(backendDb: BackendDb, raw: unknown, apply: boolean) {
  const input = metadataSchema.parse(raw);
  const db = unsafeDb(backendDb).db;
  const published = new Map(siteMetadataInventory(backendDb).items.map((item) => [`${item.post_id}:${item.locale}`, item]));
  const publicMedia = new Map(
    loadPublicSiteFeed(backendDb).flatMap((post) =>
      (["ru", "en"] as const).map((locale) => [`${post.post_id}:${locale}`, locale === "ru" ? post.media : post.media_en] as const),
    ),
  );
  return db.transaction((tx) => {
    const seen = new Set<string>();
    let changed = 0;
    let images = 0;
    for (const item of input.items) {
      const key: `${number}:${"ru" | "en"}` = `${item.post_id}:${item.locale}`;
      if (seen.has(key)) throw new Error(`Duplicate metadata for ${key}`);
      seen.add(key);
      const current = published.get(key);
      if (!current || current.text_sha256 !== item.text_sha256) throw new Error(`Published text changed for ${key}; regenerate metadata`);
      const row = tx
        .select({
          draftId: postLocales.draftId,
          media: postLocales.siteMediaJson,
          mediaRaw: sql<string | null>`CAST(${postLocales.siteMediaJson} AS TEXT)`,
          seoTitle: postLocales.seoTitle,
          sourceText: postLocales.sourceText,
          approvedText: postLocales.approvedText,
        })
        .from(postLocales)
        .innerJoin(drafts, eq(drafts.id, postLocales.draftId))
        .where(and(eq(drafts.postId, item.post_id), eq(postLocales.locale, item.locale), eq(postLocales.siteEnabled, 1)))
        .get();
      if (!row || textHash(row.approvedText ?? row.sourceText) !== item.text_sha256) throw new Error(`Published text changed for ${key}`);
      if (item.seo_title && row.seoTitle && item.seo_title !== row.seoTitle) throw new Error(`SEO title already edited for ${key}`);
      const media = (row.media?.length ? row.media : (publicMedia.get(key) ?? [])).map((image) => ({ ...image }));
      const paths = new Set<string>();
      for (const image of item.images) {
        const path = image.path.replace(/^\/+/, "");
        if (paths.has(path)) throw new Error(`Duplicate image for ${key}: ${path}`);
        paths.add(path);
        const asset = media.find((asset) => String(asset.path ?? "").replace(/^\/+/, "") === path && asset.type !== "video");
        if (!asset) throw new Error(`Published image changed for ${key}: ${path}`);
        if (asset.alt && asset.alt !== image.alt) throw new Error(`Alt already edited for ${key}: ${path}`);
        if (asset.alt !== image.alt) {
          asset.alt = image.alt;
          images += 1;
        }
      }
      const title = item.seo_title ?? row.seoTitle;
      if (title === row.seoTitle && JSON.stringify(media) === JSON.stringify(row.media ?? [])) continue;
      changed += 1;
      if (apply) {
        const result = tx
          .update(postLocales)
          .set({ seoTitle: title, siteMediaJson: media, updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(postLocales.draftId, row.draftId),
              eq(postLocales.locale, item.locale),
              eq(postLocales.siteEnabled, 1),
              sql`coalesce(${postLocales.approvedText}, ${postLocales.sourceText}) = ${current.text}`,
              sql`${postLocales.siteMediaJson} IS ${row.mediaRaw}`,
              sql`${postLocales.seoTitle} IS ${row.seoTitle}`,
            ),
          )
          .returning({ draftId: postLocales.draftId })
          .all();
        if (result.length !== 1) throw new Error(`Concurrent metadata edit for ${key}`);
      }
    }
    return { ok: true, apply, locales: input.items.length, changed, images };
  });
}

export async function siteMetadata(backendDb: BackendDb, file: string | undefined, apply: boolean) {
  if (!file) {
    if (apply) throw new Error("site-metadata --apply requires --file");
    return siteMetadataInventory(backendDb);
  }
  const content = await readFile(file, "utf8");
  if (content.length > 5_000_000) throw new Error("Site metadata exceeds 5 MB");
  return applySiteMetadata(backendDb, JSON.parse(content), apply);
}
