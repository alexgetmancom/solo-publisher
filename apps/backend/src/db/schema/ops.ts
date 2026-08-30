import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { autoId, type JsonValue, json, timestamps } from "./_shared.js";

export const publicationEvents = sqliteTable(
  "publication_events",
  {
    id: autoId(),
    publicationKey: text(),
    eventType: text().notNull(),
    severity: text().notNull().default("info"),
    target: text(),
    message: text().notNull(),
    detailsJson: text(),
    createdAt: text().notNull(),
    ackedAt: text(),
  },
  (table) => [
    index("idx_publication_events_lookup").on(table.publicationKey, table.target, table.createdAt),
    index("idx_publication_events_created_at").on(table.createdAt),
  ],
);

export const workerState = sqliteTable("worker_state", {
  name: text().primaryKey(),
  stateJson: json<Record<string, JsonValue>>().notNull(),
  updatedAt: text().notNull(),
});

/** Daily aggregates for product and runtime operations. The key is deliberately
 * a curated operation boundary, not an individual function, so this table can
 * answer usage questions without producing a row for every invocation. */
export const runtimeUsage = sqliteTable(
  "runtime_usage",
  {
    featureKey: text().notNull(),
    bucketDay: text().notNull(),
    calls: integer().notNull().default(0),
    successes: integer().notNull().default(0),
    failures: integer().notNull().default(0),
    totalDurationMs: integer().notNull().default(0),
    firstSeenAt: text().notNull(),
    lastSeenAt: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.featureKey, table.bucketDay] }),
    index("idx_runtime_usage_bucket_day").on(table.bucketDay),
    index("idx_runtime_usage_feature_last_seen").on(table.featureKey, table.lastSeenAt),
  ],
);

export const alertDedup = sqliteTable("alert_dedup", {
  alertKey: text().primaryKey(),
  lastSentAt: text().notNull(),
  suppressedCount: integer().notNull().default(0),
});

export const maintenanceLocks = sqliteTable("maintenance_locks", {
  name: text().primaryKey(),
  owner: text().notNull(),
  expiresAt: text().notNull(),
  createdAt: text().notNull(),
});

export const credentialChecks = sqliteTable(
  "credential_checks",
  {
    target: text().primaryKey(),
    status: text().notNull(),
    requiredEnvJson: text().notNull(),
    missingEnvJson: text().notNull(),
    expiresAt: text(),
    lastCheckedAt: text().notNull(),
    nextCheckAt: text(),
    lastError: text(),
    detailsJson: text(),
  },
  (table) => [index("idx_credential_checks_last_checked_at").on(table.lastCheckedAt)],
);

/** Which media formats each destination is proven to carry, and the post that
 * proved it. Distinct from a credential being ready: this is about what the
 * platform accepts, not about whether this Studio can reach it. */
export const formatSupport = sqliteTable(
  "format_support",
  {
    target: text().notNull(),
    formatKey: text().notNull(),
    status: text().notNull().default("unknown"),
    evidenceTestId: text(),
    evidenceMessageId: integer(),
    evidenceUrl: text(),
    notes: text(),
    updatedAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.target, table.formatKey] })],
);

export const mediaTestCases = sqliteTable("media_test_cases", {
  testId: text().primaryKey(),
  formatKey: text().notNull(),
  title: text().notNull(),
  inputRecipe: text().notNull(),
  expectedTargetsJson: text().notNull(),
  status: text().notNull().default("pending"),
  lastMessageId: integer(),
  notes: text(),
  ...timestamps(),
});

/** Platform credentials this Studio renews for itself.
 *
 * The value is sealed: this table travels in the daily backup, and a live
 * access token is not something to hand around in a chat. `envFingerprint`
 * records which .env value the stored one grew from, so an operator replacing a
 * lapsed token by hand is newer intent than anything kept here. */
export const platformTokens = sqliteTable("platform_tokens", {
  target: text().primaryKey(),
  sealedToken: text().notNull(),
  /** Present only when the credential was seeded from env. A token issued by
   * the browser OAuth flow belongs to the database and has no env ancestor. */
  seedFingerprint: text(),
  accountId: text(),
  sealedRefreshToken: text(),
  expiresAt: text(),
  refreshedAt: text().notNull(),
  updatedAt: text().notNull(),
});

/** A device authorization this Studio is waiting on.
 *
 * Google's device flow hands out a code the operator types on another screen,
 * and the approval arrives by polling — which used to mean a terminal blocked
 * for five minutes, the one connect flow no interface but a shell could offer.
 * Keeping the pending authorization here lets any surface start it and the
 * credentials worker finish it. The device code is sealed: it is what redeems
 * the grant until the operator approves or it expires. */
export const deviceAuthorizations = sqliteTable("device_authorizations", {
  target: text().primaryKey(),
  sealedDeviceCode: text().notNull(),
  userCode: text().notNull(),
  verificationUrl: text().notNull(),
  intervalSeconds: integer().notNull(),
  expiresAt: text().notNull(),
  ...timestamps(),
});
