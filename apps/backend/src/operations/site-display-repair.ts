import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as z from "zod";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales } from "../db/schema.js";

type LocaleRow = typeof postLocales.$inferSelect;
const planSchema = z
  .object({
    version: z.literal(1),
    dates: z.array(
      z
        .object({
          post_id: z.number().int().positive(),
          locale: z.enum(["ru", "en"]),
          expected_updated_at: z.string().datetime({ offset: true }),
          restore_updated_at: z.string().datetime({ offset: true }).nullable(),
          content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .strict();

/** Editorial identity excludes derivative paths, dimensions and generated cards. */
export function siteEditorialFingerprint(row: LocaleRow): string {
  const media = (row.siteMediaJson ?? [])
    .filter((item) => item.role !== "text_story_card")
    .map((item) => [
      item.asset_id ??
        item.file_id ??
        item.fileId ??
        item.local_path ??
        item.localPath ??
        String(item.path ?? "")
          .split("?")[0]
          ?.replace(/-vertical\.(jpg|mp4)$/, ".$1"),
      String(item.type ?? "image").toLowerCase() === "video" ? "video" : "image",
      item.alt ?? "",
    ]);
  return createHash("sha256")
    .update(JSON.stringify([row.approvedText ?? row.sourceText, row.html, row.slug, row.seoTitle, media]))
    .digest("hex");
}

/** A reviewed restoration is atomic and refuses intervening editorial changes. */
export async function repairSiteDisplay(backendDb: BackendDb, file: string | undefined, apply: boolean) {
  const db = unsafeDb(backendDb).db;
  const read = () =>
    db
      .select({ postId: drafts.postId, locale: postLocales })
      .from(postLocales)
      .innerJoin(drafts, eq(drafts.id, postLocales.draftId))
      .where(and(eq(postLocales.siteEnabled, 1), inArray(drafts.status, ["published", "failed"])))
      .all()
      .filter((row) => row.postId && (row.locale.locale === "ru" || row.locale.locale === "en"));
  if (!file) {
    if (apply) throw new Error("site-display-repair --apply requires a reviewed --file plan");
    const rows = read();
    return {
      ok: true,
      apply: false,
      dates: rows.map(({ postId, locale }) => ({
        post_id: postId,
        locale: locale.locale,
        updated_at: locale.siteUpdatedAt,
        content_sha256: siteEditorialFingerprint(locale),
      })),
      story_card_locales: rows.filter(({ locale }) => locale.siteMediaJson?.some((item) => item.role === "text_story_card")).length,
    };
  }
  const plan = planSchema.parse(await Bun.file(file).json());
  return db.transaction((tx) => {
    const rows = read();
    const byKey = new Map(rows.map((row) => [`${row.postId}:${row.locale.locale}`, row.locale]));
    const seen = new Set<string>();
    let restored = 0;
    for (const item of plan.dates) {
      const key = `${item.post_id}:${item.locale}`;
      if (seen.has(key)) throw new Error(`Duplicate date restoration: ${key}`);
      seen.add(key);
      const row = byKey.get(key);
      if (!row || row.siteUpdatedAt !== item.expected_updated_at || siteEditorialFingerprint(row) !== item.content_sha256)
        throw new Error(`Editorial content or modification date changed for ${key}`);
      if (item.restore_updated_at && row.publishedAt && Date.parse(item.restore_updated_at) < Date.parse(row.publishedAt))
        throw new Error(`Restored date precedes publication for ${key}`);
      if (apply) {
        const changed = tx
          .update(postLocales)
          .set({ siteUpdatedAt: item.restore_updated_at })
          .where(
            and(
              eq(postLocales.draftId, row.draftId),
              eq(postLocales.locale, item.locale),
              eq(postLocales.siteEnabled, 1),
              eq(postLocales.updatedAt, row.updatedAt),
              eq(postLocales.siteUpdatedAt, item.expected_updated_at),
            ),
          )
          .returning({ draftId: postLocales.draftId })
          .all();
        if (changed.length !== 1) throw new Error(`Concurrent date change for ${key}`);
      }
      restored += 1;
    }
    let cards = 0;
    for (const { locale: row } of rows) {
      const media = row.siteMediaJson?.filter((item) => item.role !== "text_story_card");
      if (!media || media.length === row.siteMediaJson?.length) continue;
      if (apply) {
        const changed = tx
          .update(postLocales)
          .set({ siteMediaJson: media, updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(postLocales.draftId, row.draftId),
              eq(postLocales.locale, row.locale),
              eq(postLocales.siteEnabled, 1),
              eq(postLocales.updatedAt, row.updatedAt),
              sql`${postLocales.siteMediaJson} IS ${JSON.stringify(row.siteMediaJson)}`,
            ),
          )
          .returning({ draftId: postLocales.draftId })
          .all();
        if (changed.length !== 1) throw new Error(`Concurrent gallery change for ${row.draftId}:${row.locale}`);
      }
      cards += 1;
    }
    return { ok: true, apply, restored_dates: restored, removed_story_card_locales: cards };
  });
}
