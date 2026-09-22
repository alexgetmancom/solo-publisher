import { asc, eq } from "drizzle-orm";
import { type LocalizedThreadPart, localizedThread } from "../content/thread.js";
import { drafts, draftThreadParts, postLocales } from "../db/schema.js";
import type { BackendDatabase } from "../db/types.js";
import { jsonRecordArray } from "../json.js";
import { effectivePublicationTargets } from "./publication-plan.js";
import type { PublicationLocaleSource, PublicationSource } from "./publication-source.js";
import { parseTargets } from "./targets.js";

type SourceDb = BackendDatabase;

export function publicationSourceFromDb(db: SourceDb, postId: number): PublicationSource {
  const root = db
    .select({
      draftId: drafts.id,
      postId: drafts.postId,
      targetsJson: drafts.targetsJson,
    })
    .from(drafts)
    .where(eq(drafts.postId, postId))
    .get();
  if (!root?.postId) throw new Error(`publication source not found: post:${postId}`);
  const rows = db.select().from(postLocales).where(eq(postLocales.draftId, root.draftId)).all();
  const byLocale = new Map(rows.map((row) => [row.locale, row]));
  const thread = db
    .select()
    .from(draftThreadParts)
    .where(eq(draftThreadParts.draftId, root.draftId))
    .orderBy(asc(draftThreadParts.position))
    .all()
    .map((part) => ({
      position: part.position,
      textRu: part.textRu,
      entitiesRu: part.entitiesRuJson ?? [],
      textEn: part.textEn,
      media: (part.mediaJson ?? []) as Record<string, unknown>[],
    }));
  const ru = localeSource(byLocale.get("ru"), [], localizedThread(thread, "ru"));
  const en = localeSource(byLocale.get("en"), ru.media, localizedThread(thread, "en"));
  return {
    draftId: root.draftId,
    postId: root.postId,
    targets: parseTargets(root.targetsJson),
    locales: { ru, en },
  };
}

export function publicationPlanFromDb(
  db: SourceDb,
  postId: number,
  registeredTargets: ReadonlySet<string>,
): Record<string, unknown> | null {
  const row = db
    .select({ mode: drafts.publishMode, ruAt: drafts.scheduledAt, enAt: drafts.scheduledEnAt, storyMode: drafts.storyPublishMode })
    .from(drafts)
    .where(eq(drafts.postId, postId))
    .get();
  if (!row) return null;
  const source = publicationSourceFromDb(db, postId);
  return {
    mode: row.mode,
    targets: effectivePublicationTargets(
      source.targets,
      registeredTargets.size ? registeredTargets : undefined,
      { ru: source.locales.ru.media, en: source.locales.en.media },
      source.locales.ru.storyMedia.length > 0 || source.locales.en.storyMedia.length > 0,
      row.storyMode,
    ),
    scheduled_at: row.ruAt,
    scheduled_en_at: row.enAt,
  };
}

function localeSource(
  row: typeof postLocales.$inferSelect | undefined,
  fallbackMedia: Record<string, unknown>[],
  thread: LocalizedThreadPart[],
): PublicationLocaleSource {
  const ownMedia = jsonRecordArray(row?.mediaJson);
  return {
    text: row?.approvedText ?? row?.sourceText ?? "",
    entities: jsonRecordArray(row?.entitiesJson),
    media: ownMedia.length ? ownMedia : fallbackMedia,
    storyMedia: jsonRecordArray(row?.storyMediaJson),
    siteMedia: jsonRecordArray(row?.siteMediaJson),
    slug: row?.slug ?? "",
    publishAt: row?.publishAt ?? null,
    siteEnabled: row?.siteEnabled === 1,
    thread,
  };
}
