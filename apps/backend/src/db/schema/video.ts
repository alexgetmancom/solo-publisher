import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { autoId, type JsonObject, json, queueAttempts, timestamps } from "./_shared.js";
import { studioMediaAssets } from "./studio.js";

export const videoDrafts = sqliteTable(
  "video_drafts",
  {
    id: autoId(),
    actorId: integer().notNull(),
    locale: text().notNull().default("ru"),
    label: text().notNull().default(""),
    studioMediaAssetId: integer()
      .notNull()
      .references(() => studioMediaAssets.id),
    status: text().notNull().default("draft"),
    scheduledAt: text(),
    retentionUntil: text(),
    /** Set once the source file has been reclaimed. Retention deadlines are
     * recomputed on every target change, so they cannot say whether the file is
     * already gone; without this marker the retention sweep keeps re-selecting
     * long-finished drafts forever. */
    sourcePrunedAt: text(),
    controlChatId: integer(),
    controlMessageId: integer(),
    /** What the video is about and how it opens, written by whoever publishes
     * it. Two fields rather than the dozen an analyst would ask for: a slot
     * comparison is only as good as the share of videos that carry the field,
     * and a field nobody fills in describes nothing. */
    game: text(),
    hook: text(),
    /** What was written to be said in the video, as its author wrote it.
     * The opening lines of this are the hook, which is the one thing that
     * decides a Short and the one thing no API reports. */
    script: text(),
    /** Where the script came from. What was written to be said and what a
     * machine heard afterwards are both text in one column, and only this
     * says which: one is the plan, the other is the record, and they are worth
     * different amounts. */
    scriptSource: text(),
    /** The words the video opens with: the first paragraph of a script, or the
     * first sentence of a transcript. Stored rather than derived on read
     * because where the opening ends is only knowable from the shape of the
     * text it arrived in, and that shape is gone once it is one column. */
    openingLine: text(),
    ...timestamps(),
  },
  (table) => [
    index("idx_video_drafts_status_schedule").on(table.status, table.scheduledAt),
    index("idx_video_drafts_studio_media_asset").on(table.studioMediaAssetId),
    index("idx_video_drafts_updated_at").on(table.updatedAt),
  ],
);

export const videoTargets = sqliteTable(
  "video_targets",
  {
    id: autoId(),
    videoDraftId: integer()
      .notNull()
      .references(() => videoDrafts.id, { onDelete: "cascade" }),
    target: text().notNull(),
    metadataJson: json<JsonObject>().notNull(),
    scheduledAt: text(),
    status: text().notNull().default("draft"),
    deliveryProvider: text().notNull().default("native"),
    providerAccountId: text(),
    providerPostId: text(),
    externalId: text(),
    externalUrl: text(),
    preparedAt: text(),
    publishedAt: text(),
    confirmationSource: text(),
    verifiedAt: text(),
    lastError: text(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("idx_video_targets_draft_target").on(table.videoDraftId, table.target),
    index("idx_video_targets_status_schedule").on(table.status, table.scheduledAt),
  ],
);

export const videoJobs = sqliteTable(
  "video_jobs",
  {
    id: autoId(),
    videoDraftId: integer()
      .notNull()
      .references(() => videoDrafts.id, { onDelete: "cascade" }),
    videoTargetId: integer().references(() => videoTargets.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    runAt: text().notNull(),
    status: text().notNull().default("queued"),
    // See publish_jobs.reconcile_attempt_count: verification polls have their
    // own budget, separate from publish retries.
    reconcileAttemptCount: integer().notNull().default(0),
    ...queueAttempts(),
    ...timestamps(),
  },
  (table) => [
    index("idx_video_jobs_due").on(table.status, table.runAt, table.nextAttemptAt),
    index("idx_video_jobs_lock").on(table.status, table.lockedAt),
    uniqueIndex("idx_video_jobs_unique").on(table.videoDraftId, table.videoTargetId, table.kind),
  ],
);

export const videoMetricSnapshots = sqliteTable(
  "video_metric_snapshots",
  {
    id: autoId(),
    videoTargetId: integer()
      .notNull()
      .references(() => videoTargets.id, { onDelete: "cascade" }),
    platform: text().notNull(),
    metricsJson: json<JsonObject>().notNull(),
    checkpointIndex: integer(),
    sampledAt: text().notNull(),
  },
  (table) => [
    index("idx_video_metric_snapshots_target_sampled").on(table.videoTargetId, table.sampledAt),
    index("idx_video_metric_snapshots_sampled_at").on(table.sampledAt),
    uniqueIndex("idx_video_metric_snapshots_checkpoint")
      .on(table.videoTargetId, table.checkpointIndex)
      .where(sql`${table.checkpointIndex} IS NOT NULL`),
  ],
);

export const videoMetricSchedule = sqliteTable(
  "video_metric_schedule",
  {
    videoTargetId: integer()
      .primaryKey()
      .references(() => videoTargets.id, { onDelete: "cascade" }),
    checkpointIndex: integer().notNull().default(0),
    nextCheckAt: text().notNull(),
    lastCheckedAt: text(),
    lastError: text(),
    /** Consecutive non-terminal failures since the last successful check; reset to 0 on success. */
    errorCount: integer().notNull().default(0),
    frozenAt: text(),
    lockedBy: text(),
    lockedAt: text(),
    updatedAt: text().notNull(),
  },
  (table) => [index("idx_video_metric_schedule_lock").on(table.lockedBy, table.lockedAt)],
);

export const socialComments = sqliteTable(
  "social_comments",
  {
    platform: text().notNull(),
    commentId: text().notNull(),
    videoTargetId: integer()
      .notNull()
      .references(() => videoTargets.id, { onDelete: "cascade" }),
    author: text(),
    text: text().notNull(),
    likeCount: integer().notNull().default(0),
    publishedAt: text(),
    fetchedAt: text().notNull(),
    /** The thread this is an answer inside, or null for a thread's own root.
     * A platform counts an answer as a comment, so a store that kept only
     * roots could never reconcile with the counter it is read beside. */
    parentCommentId: text(),
  },
  (table) => [
    primaryKey({ columns: [table.platform, table.commentId] }),
    index("idx_social_comments_target").on(table.videoTargetId, table.publishedAt),
  ],
);

/** What the opening of a video looks like, measured from its own frames.
 *
 * One row per video per moment, because the question is about the video and
 * not about the copy that went to one platform: both platforms carry the same
 * file. Stored rather than computed on read -- the frames come from a download
 * that is gone by the time anyone asks. */
export const videoFrameFeatures = sqliteTable(
  "video_frame_features",
  {
    videoDraftId: integer()
      .notNull()
      .references(() => videoDrafts.id, { onDelete: "cascade" }),
    atSeconds: integer().notNull(),
    featuresJson: json<JsonObject>().notNull(),
    /** The frame itself, kept at the size it was published at. */
    imagePath: text(),
    source: text().notNull(),
    capturedAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.videoDraftId, table.atSeconds] })],
);
