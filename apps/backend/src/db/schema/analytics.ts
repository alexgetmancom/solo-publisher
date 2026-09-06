import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { autoId, type JsonObject, type JsonValue, json } from "./_shared.js";

export const postMetrics = sqliteTable(
  "post_metrics",
  {
    publicationKey: text().notNull(),
    target: text().notNull(),
    metricName: text().notNull().default("views"),
    value: integer(),
    unit: text().notNull().default("count"),
    source: text(),
    sampledAt: text(),
    error: text(),
    rawJson: json<JsonValue | null>(),
  },
  (table) => [
    primaryKey({ columns: [table.publicationKey, table.target, table.metricName] }),
    index("idx_post_metrics_sampled_at").on(table.sampledAt),
  ],
);

export const metricSamples = sqliteTable(
  "metric_samples",
  {
    id: autoId(),
    publicationKey: text().notNull(),
    target: text().notNull(),
    metricName: text().notNull().default("views"),
    value: integer(),
    sampledAt: text().notNull(),
    source: text(),
    rawJson: json<JsonValue | null>(),
  },
  (table) => [
    index("idx_metric_samples_lookup").on(table.publicationKey, table.target, table.metricName, table.sampledAt),
    // Retention deletes by age alone. The lookup index above is useless for
    // that predicate — publication_key leads it — so the sweep read the whole table.
    index("idx_metric_samples_sampled_at").on(table.sampledAt),
  ],
);

export const metricSchedule = sqliteTable(
  "metric_schedule",
  {
    publicationKey: text().notNull(),
    target: text().notNull(),
    nextCheckAt: text(),
    lastCheckedAt: text(),
    checkCount: integer().notNull().default(0),
    frozenAt: text(),
    lastError: text(),
    lockedBy: text(),
    lockedAt: text(),
    updatedAt: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.publicationKey, table.target] }),
    index("idx_metric_schedule_lock").on(table.lockedBy, table.lockedAt),
    index("idx_metric_schedule_error_updated_at")
      .on(table.updatedAt)
      .where(sql`${table.lastError} IS NOT NULL AND ${table.lastError} <> ''`),
  ],
);

export const analyticsRollups = sqliteTable("analytics_rollups", {
  rollupKey: text().primaryKey(),
  scope: text().notNull(),
  subject: text().notNull(),
  metricJson: text().notNull(),
  updatedAt: text().notNull(),
});

export const analyticsSync = sqliteTable("analytics_sync", {
  source: text().primaryKey(),
  lastSyncedAt: text().notNull(),
  lastSuccessAt: text(),
  lastError: text(),
  lockedBy: text(),
  lockedAt: text(),
});

export const creatorProfiles = sqliteTable(
  "creator_profiles",
  {
    platform: text().primaryKey(),
    dataJson: json<JsonObject>().notNull(),
    updatedAt: text().notNull(),
  },
  (table) => [index("idx_creator_profiles_updated_at").on(table.updatedAt)],
);

/** Immutable daily audience observations. creatorProfiles remains the latest
 * read model, while this table is the Analytics history. */
export const creatorProfileSnapshots = sqliteTable(
  "creator_profile_snapshots",
  {
    id: autoId(),
    platform: text().notNull(),
    account: text().notNull(),
    sampledOn: text().notNull(),
    metricsJson: json<JsonObject>().notNull(),
    source: text().notNull(),
    sampledAt: text().notNull(),
  },
  (table) => [
    uniqueIndex("idx_creator_profile_snapshots_daily").on(table.platform, table.account, table.sampledOn),
    index("idx_creator_profile_snapshots_history").on(table.platform, table.account, table.sampledAt),
    index("idx_creator_profile_snapshots_sampled_at").on(table.sampledAt),
  ],
);

export const xActivityImports = sqliteTable(
  "x_activity_imports",
  {
    id: autoId(),
    checksum: text().notNull(),
    sourceFile: text().notNull(),
    periodStart: text(),
    periodEnd: text(),
    sampledAt: text().notNull(),
    importedAt: text().notNull(),
    rowCount: integer().notNull(),
  },
  (table) => [uniqueIndex("idx_x_activity_imports_checksum").on(table.checksum)],
);

/** Account-wide X activity is deliberately separate from editorial posts.
 * linkedPublicationKey is optional: replies and posts written directly in X remain
 * analytics-only, while Studio publications can still share one identity. */
export const xActivityItems = sqliteTable(
  "x_activity_items",
  {
    xPostId: text().primaryKey(),
    kind: text().notNull(),
    publishedAt: text(),
    text: text().notNull(),
    url: text().notNull(),
    linkedPublicationKey: text(),
    firstSeenAt: text().notNull(),
    lastSeenAt: text().notNull(),
    rawJson: json<JsonValue | null>(),
  },
  (table) => [
    index("idx_x_activity_items_published").on(table.publishedAt),
    index("idx_x_activity_items_linked_post").on(table.linkedPublicationKey),
    index("idx_x_activity_items_last_seen_at").on(table.lastSeenAt),
  ],
);

export const xActivityMetricSnapshots = sqliteTable(
  "x_activity_metric_snapshots",
  {
    id: autoId(),
    xPostId: text().notNull(),
    metricName: text().notNull(),
    value: integer().notNull(),
    sampledAt: text().notNull(),
    importId: integer(),
    rawJson: json<JsonValue | null>(),
  },
  (table) => [
    uniqueIndex("idx_x_activity_metric_snapshot").on(table.xPostId, table.metricName, table.sampledAt),
    index("idx_x_activity_metric_history").on(table.xPostId, table.sampledAt),
    index("idx_x_activity_metric_sampled_at").on(table.sampledAt),
  ],
);

/** Native audience activity as a platform's own dashboard draws it: when the
 * people who follow this account are awake, by local hour.
 *
 * No API reports this -- it is read off YouTube Studio and Instagram Insights
 * by a browser and handed over. That is why the source, the period it covers
 * and the moment it was captured are columns and not commentary: a heatmap
 * with no capture date is quoted forever as if it were current, and this one
 * describes followers while most Reels views come from people who follow
 * nothing.
 */
export const audienceActivity = sqliteTable(
  "audience_activity",
  {
    id: autoId(),
    platform: text().notNull(),
    account: text().notNull(),
    metric: text().notNull(),
    weekday: text().notNull(),
    hourLocal: integer().notNull(),
    value: integer().notNull(),
    timeZone: text().notNull(),
    periodStart: text(),
    periodEnd: text(),
    capturedAt: text().notNull(),
    source: text(),
  },
  (table) => [
    uniqueIndex("idx_audience_activity_slot").on(
      table.platform,
      table.account,
      table.metric,
      table.capturedAt,
      table.weekday,
      table.hourLocal,
    ),
    index("idx_audience_activity_captured_at").on(table.capturedAt),
  ],
);

/** Who the audience is, as a platform describes it: age bands, cities,
 * countries, gender, captured periodically.
 *
 * Separate from `audienceActivity` on purpose. That table answers when
 * followers are around and is keyed by weekday and hour; this one answers who
 * they are and is keyed by a dimension and a label. One table for both would
 * have to branch on which question it is holding, and a shape that branches is
 * two shapes. */
export const audienceDemographics = sqliteTable(
  "audience_demographics",
  {
    id: autoId(),
    platform: text().notNull(),
    account: text().notNull(),
    metric: text().notNull(),
    dimension: text().notNull(),
    label: text().notNull(),
    value: integer().notNull(),
    timeframe: text().notNull(),
    capturedOn: text().notNull(),
    capturedAt: text().notNull(),
    source: text().notNull(),
  },
  (table) => [
    uniqueIndex("idx_audience_demographics_daily").on(
      table.platform,
      table.account,
      table.metric,
      table.dimension,
      table.label,
      table.capturedOn,
    ),
    index("idx_audience_demographics_captured_at").on(table.capturedAt),
  ],
);

/** What a game is, looked up once and shared by every video about it.
 *
 * The tag on a video is the game's name; this is everything else worth knowing
 * about it. It is a dimension, not an observation: 152 games behind 166 videos
 * means a per-video copy would be 166 lookups of the same handful of facts,
 * and a genre does not change between two videos about the same game. */
export const games = sqliteTable(
  "games",
  {
    name: text().primaryKey(),
    steamAppId: text(),
    genres: json<string[]>(),
    playerModes: json<string[]>(),
    releaseDate: text(),
    developer: text(),
    source: text().notNull(),
    capturedAt: text().notNull(),
  },
  (table) => [index("idx_games_captured_at").on(table.capturedAt)],
);
