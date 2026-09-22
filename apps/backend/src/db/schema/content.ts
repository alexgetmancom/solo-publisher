import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, type MediaPayload } from "./_shared.js";

export const postLocales = sqliteTable(
  "post_locales",
  {
    draftId: integer().notNull(),
    locale: text().notNull(),
    /** Authoring source. For English this is the latest machine translation;
     * approvedText is the author's replacement when one exists. */
    sourceText: text().notNull().default(""),
    approvedText: text(),
    html: text(),
    entitiesJson: text(),
    /** Original editorial media, before any target-specific rendering. */
    mediaJson: json<MediaPayload[] | null>(),
    storyMediaJson: json<MediaPayload[] | null>(),
    siteMediaJson: json<MediaPayload[] | null>(),
    slug: text(),
    siteEnabled: integer().notNull().default(0),
    publishAt: text(),
    publishedAt: text(),
    updatedAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.draftId, table.locale] }), index("idx_post_locales_published_at").on(table.publishedAt)],
);

export const publicationTargets = sqliteTable(
  "publication_targets",
  {
    publicationKey: text().notNull(),
    target: text().notNull(),
    status: text().notNull().default("unknown"),
    externalId: text(),
    externalIdsJson: json<string[] | null>(),
    url: text(),
    error: text(),
    skipped: integer().notNull().default(0),
    publishedAt: text(),
    confirmationSource: text(),
    verifiedAt: text(),
    updatedAt: text().notNull(),
    rawJson: text(),
  },
  (table) => [
    primaryKey({ columns: [table.publicationKey, table.target] }),
    index("idx_publication_targets_updated_at").on(table.updatedAt),
  ],
);

/** The posts after the first in a thread. The first post is the draft itself —
 * its locales, media and translation — so a draft with no rows here is an
 * ordinary post and nothing that reads one has to know threads exist. Each
 * later post carries its own words and media; the English is
 * the machine translation, made with the draft's. */
export const draftThreadParts = sqliteTable(
  "draft_thread_parts",
  {
    draftId: integer().notNull(),
    /** 2 for the first reply, and so on without gaps: removal renumbers. */
    position: integer().notNull(),
    textRu: text().notNull(),
    entitiesRuJson: json<Record<string, unknown>[] | null>(),
    textEn: text(),
    mediaJson: json<MediaPayload[] | null>(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.draftId, table.position] })],
);
