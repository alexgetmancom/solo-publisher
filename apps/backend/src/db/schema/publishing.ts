import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { autoId, type JsonObject, json, queueAttempts, timestamps } from "./_shared.js";

export const publishJobs = sqliteTable(
  "publish_jobs",
  {
    jobId: autoId(),
    publicationKey: text().notNull(),
    target: text().notNull(),
    status: text().notNull().default("queued"),
    currentPhase: text(),
    // Reconciliation asks "did this actually publish?", which is a different
    // budget from "publish it again": a job that burned its publish attempts
    // before turning ambiguous still deserves a full set of verification polls.
    reconcileAttemptCount: integer().notNull().default(0),
    publishAt: text(),
    payloadJson: json<JsonObject | null>(),
    ...queueAttempts(),
    ...timestamps(),
  },
  (table) => [
    // Deduplication key matches what every write path actually keys on: one
    // queued job per target of one publication.
    uniqueIndex("idx_publish_jobs_publication_target_status").on(table.publicationKey, table.target, table.status),
    index("idx_publish_jobs_due").on(table.status, table.publishAt, table.nextAttemptAt, table.createdAt),
    index("idx_publish_jobs_lock").on(table.lockedBy, table.lockedAt),
    index("idx_publish_jobs_updated_at").on(table.updatedAt),
  ],
);

export const drafts = sqliteTable("drafts", {
  id: autoId(),
  actorId: integer().notNull(),
  status: text().notNull(),
  targetsJson: text().notNull(),
  scheduledAt: text(),
  scheduledEnAt: text(),
  publishMode: text(),
  /** Stable public id allocated when this aggregate first enters Delivery.
   * Draft id remains the Studio/card identity; published id remains the public
   * URL and external publication identity. */
  postId: integer().unique(),
  /** A one-off waiver of the 500-character Threads rule for this draft only:
   * the author saw how many posts the chain would take and accepted it. Lives
   * and dies with the draft on purpose — a remembered waiver stops being a rule. */
  threadsChainApproved: integer().notNull().default(0),
  /** Text-only posts always get site cards. This field records only the
   * author's final decision about the three Story delivery targets. */
  storyPublishMode: text(),
  ...timestamps(),
});

/** A text-only draft owns one deterministic rendered card per locale. The row
 * is both the durable asset record and its single-concurrency work item. */
export const draftStoryCards = sqliteTable(
  "draft_story_cards",
  {
    draftId: integer().notNull(),
    locale: text().notNull(),
    sourceHash: text().notNull(),
    headline: text().notNull(),
    emoji: text(),
    status: text().notNull().default("queued"),
    localPath: text(),
    attemptCount: integer().notNull().default(0),
    nextAttemptAt: text(),
    lockedBy: text(),
    lockedAt: text(),
    lastError: text(),
    templateVersion: text().notNull(),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.locale] }),
    index("idx_draft_story_cards_due").on(table.status, table.nextAttemptAt, table.createdAt),
    index("idx_draft_story_cards_lock").on(table.lockedBy, table.lockedAt),
  ],
);

export const pendingAlbums = sqliteTable("pending_albums", {
  id: text().primaryKey(),
  actorId: integer().notNull(),
  chatId: integer().notNull(),
  mediaGroupId: text().notNull(),
  step: text(),
  stepDataJson: json<JsonObject>().notNull().default({}),
  draftId: integer(),
  stateRevision: integer(),
  textRu: text().notNull().default(""),
  textEntitiesJson: text(),
  mediaJson: text().notNull(),
  notified: integer().notNull().default(0),
  attemptCount: integer().notNull().default(0),
  updatedAt: text().notNull(),
});

/** One draft's machine translation, waiting to be made. The row is the pending
 * state itself: it exists while the English text is being produced and is gone
 * once the draft carries it, so the card can say which of "no English yet" and
 * "no English at all" the operator is looking at. */
export const draftTranslations = sqliteTable(
  "draft_translations",
  {
    draftId: integer().primaryKey(),
    status: text().notNull().default("queued"),
    ...queueAttempts(),
    ...timestamps(),
  },
  (table) => [index("idx_draft_translations_due").on(table.status, table.nextAttemptAt, table.createdAt)],
);
