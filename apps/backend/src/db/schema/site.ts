import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { autoId, queueAttempts, timestamps } from "./_shared.js";

export const siteJobs = sqliteTable(
  "site_jobs",
  {
    jobId: autoId(),
    publicationKey: text().notNull(),
    reason: text().notNull(),
    status: text().notNull().default("queued"),
    ...queueAttempts(),
    ...timestamps(),
  },
  (table) => [
    index("idx_site_jobs_due").on(table.status, table.nextAttemptAt, table.createdAt),
    index("idx_site_jobs_lock").on(table.lockedBy, table.lockedAt),
    index("idx_site_jobs_publication").on(table.publicationKey, table.status),
    index("idx_site_jobs_updated_at").on(table.updatedAt),
  ],
);

export const sitePageviews = sqliteTable(
  "site_pageviews",
  {
    day: text().notNull(),
    path: text().notNull(),
    count: integer().notNull().default(0),
    updatedAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.path] }), index("idx_site_pageviews_day").on(table.day)],
);
