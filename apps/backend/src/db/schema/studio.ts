import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { LocalizedProfiles, LocalizedText } from "../../application/ports.js";
import { DEFAULT_MILESTONE_THRESHOLDS, DEFAULT_STUDIO_PROFILE } from "../../studio.js";
import { autoId, type JsonObject, type JsonValue, json, timestamps } from "./_shared.js";

/** What this Studio is and how its deployment behaves: the identity it publishes
 * under, its display time zone, whether it serves a public site, and video
 * timing. One row per Studio instance, because the database is the Studio.
 * Defaults describe a fresh install and never anyone else's identity. */
export const studioProfile = sqliteTable("studio_profile", {
  id: integer().primaryKey().default(1),
  timezone: text().notNull().default(DEFAULT_STUDIO_PROFILE.timezone),
  timezoneLabel: text().notNull().default(DEFAULT_STUDIO_PROFILE.timezoneLabel),
  siteEnabled: integer().notNull().default(DEFAULT_STUDIO_PROFILE.siteEnabled),
  videoPrepareLeadMinutes: integer().notNull().default(DEFAULT_STUDIO_PROFILE.videoPrepareLeadMinutes),
  videoRetentionHours: integer().notNull().default(DEFAULT_STUDIO_PROFILE.videoRetentionHours),
  /** Localized identity, keyed by the locales this Studio serves. */
  nameJson: json<LocalizedText>().notNull().default(DEFAULT_STUDIO_PROFILE.nameJson),
  taglineJson: json<LocalizedText>().notNull().default(DEFAULT_STUDIO_PROFILE.taglineJson),
  aboutJson: json<LocalizedText>().notNull().default(DEFAULT_STUDIO_PROFILE.aboutJson),
  /** The long-form self-description the public About page renders. `aboutJson`
   * is the one-paragraph summary feeds, meta descriptions and structured data
   * carry; a page-length text in that field would wreck every one of them. */
  bioJson: json<LocalizedText>().notNull().default(DEFAULT_STUDIO_PROFILE.bioJson),
  profilesJson: json<LocalizedProfiles>().notNull().default(DEFAULT_STUDIO_PROFILE.profilesJson),
  /** Which platforms a new draft starts with, as target ids. Every Studio
   * publishes to its own subset of what it has connected — the hand-driven
   * platforms are the ones an operator wants off by default — so this is a
   * setting, not a constant. Targets no longer connected are ignored on read. */
  defaultTargetsJson: json<string[]>().notNull().default(DEFAULT_STUDIO_PROFILE.defaultTargetsJson),
  updatedAt: text().notNull(),
});

/** Owner-level notification policy. It belongs to Studio, not to any interface. */
export const studioNotificationSettings = sqliteTable("studio_notification_settings", {
  actorId: integer().primaryKey(),
  videoRemindersEnabled: integer().notNull().default(1),
  postRemindersEnabled: integer().notNull().default(1),
  reminderMinutes: integer().notNull().default(5),
  completionEnabled: integer().notNull().default(1),
  updatedAt: text().notNull(),
});

/** One weekly digest policy per Studio instance, shared by every administrator. */
export const studioWeeklyDigestSettings = sqliteTable("studio_weekly_digest_settings", {
  id: integer().primaryKey().default(1),
  enabled: integer().notNull().default(1),
  weekday: integer().notNull().default(0),
  updatedAt: text().notNull(),
});

/** Which audience achievements this Studio announces, and at which follower
 * counts. One row per Studio instance: the milestone is a fact about the
 * audience, not about the administrator who happens to read it.
 * Every scope on and the full ladder by default — a fresh install announces
 * what it always announced. */
export const studioMilestoneSettings = sqliteTable("studio_milestone_settings", {
  id: integer().primaryKey().default(1),
  channelEnabled: integer().notNull().default(1),
  groupLocaleEnabled: integer().notNull().default(1),
  localeEnabled: integer().notNull().default(1),
  projectEnabled: integer().notNull().default(1),
  /** Follower counts worth announcing, ascending. */
  thresholdsJson: json<number[]>()
    .notNull()
    .default([...DEFAULT_MILESTONE_THRESHOLDS]),
  updatedAt: text().notNull(),
});

/** One daily database backup policy per Studio instance. Enabled by default:
 * the operator who never opens settings is exactly the one who needs it. */
export const studioBackupSettings = sqliteTable("studio_backup_settings", {
  id: integer().primaryKey().default(1),
  enabled: integer().notNull().default(1),
  updatedAt: text().notNull(),
});

/** One daily Grok news digest policy per Studio instance, shared by every administrator. */
export const studioNewsDigestSettings = sqliteTable("studio_news_digest_settings", {
  id: integer().primaryKey().default(1),
  enabled: integer().notNull().default(0),
  hour: integer().notNull().default(10),
  minute: integer().notNull().default(0),
  prompt: text().notNull().default(""),
  /** How hard Grok thinks on every attempt. One value, not a ladder: a report
   * that arrives at one effort and a stub at another is not a retry policy,
   * it is two different jobs wearing one name. */
  effort: text().notNull().default("xhigh"),
  updatedAt: text().notNull(),
});

/** Durable, interface-neutral scheduled notification work. */
export const studioNotificationJobs = sqliteTable(
  "studio_notification_jobs",
  {
    id: autoId(),
    actorId: integer().notNull(),
    ref: text().notNull(),
    kind: text().notNull(),
    runAt: text().notNull(),
    status: text().notNull().default("queued"),
    payloadJson: json<JsonObject>().notNull().default({}),
    ...timestamps(),
  },
  (table) => [
    index("idx_studio_notification_jobs_due").on(table.status, table.runAt),
    uniqueIndex("idx_studio_notification_jobs_ref_kind").on(table.ref, table.kind),
  ],
);

/** Durable interface-neutral files. Telegram file ids are only one possible source. */
export const studioMediaAssets = sqliteTable(
  "studio_media_assets",
  {
    id: autoId(),
    actorId: integer().notNull(),
    kind: text().notNull(),
    mimeType: text().notNull(),
    filename: text().notNull(),
    localPath: text().notNull(),
    byteSize: integer().notNull(),
    sha256: text().notNull(),
    source: text().notNull(),
    createdAt: text().notNull(),
  },
  (table) => [
    index("idx_studio_media_assets_owner").on(table.actorId, table.createdAt),
    index("idx_studio_media_assets_hash").on(table.sha256),
    // Media is content-addressed per owner. The uniqueness is what makes the
    // import path's "reuse the existing row" lookup safe under concurrency.
    uniqueIndex("idx_studio_media_assets_owner_hash").on(table.actorId, table.sha256),
  ],
);

/** The signature appended to every YouTube description. One per Studio, like
 * the channel it publishes to: held per administrator, it left videos owned by
 * the other one going out to that same channel unsigned. */
export const studioYoutubeSettings = sqliteTable("studio_youtube_settings", {
  id: integer().primaryKey().default(1),
  signature: text().notNull().default(""),
  updatedAt: text().notNull(),
});

export const botUiSettings = sqliteTable("bot_ui_settings", {
  actorId: integer().primaryKey(),
  locale: text().notNull().default("en"),
  timezone: text(),
  updatedAt: text().notNull(),
});

/** Canonical registry of publishing routes. */
export const channelConnections = sqliteTable(
  "channel_connections",
  {
    id: text().primaryKey(),
    platform: text().notNull(),
    locale: text().notNull(),
    provider: text().notNull(),
    providerAccountId: text(),
    /** Publishing target id for channels handled by the text-post pipeline. */
    targetId: text(),
    label: text().notNull(),
    enabled: integer().notNull().default(1),
    source: text().notNull().default("config"),
    ...timestamps(),
  },
  (table) => [
    index("idx_channel_connections_enabled").on(table.enabled, table.platform),
    uniqueIndex("idx_channel_connections_route").on(table.platform, table.locale, table.provider, table.providerAccountId),
    uniqueIndex("idx_channel_connections_target").on(table.targetId),
  ],
);

/** Interface-owned presentation references. Domain aggregates never store UI message ids. */
export const interfaceBindings = sqliteTable(
  "interface_bindings",
  {
    interfaceId: text().notNull(),
    entityType: text().notNull(),
    entityId: integer().notNull(),
    conversationId: text().notNull(),
    messageId: text().notNull(),
    stateJson: json<Record<string, JsonValue>>().notNull().default({}),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.interfaceId, table.entityType, table.entityId] }),
    index("idx_interface_bindings_lookup").on(table.entityType, table.entityId),
  ],
);
