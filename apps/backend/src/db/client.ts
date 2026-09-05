import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { ApplicationPorts } from "../application/ports.js";
import { queueDraftStoryCards, readyStoryCardMedia, setStoryPublishMode, storyCardsForDraft } from "../story-cards/store.js";
import { installDateGuards } from "./date-guards.js";
import { createActionableIssueStore } from "./repositories/actionable-issues.js";
import { createChannelStore } from "./repositories/channels.js";
import { createConversationSessionStore } from "./repositories/conversation-sessions.js";
import { createDraftTranslationStore } from "./repositories/draft-translations.js";
import { createDraftStore } from "./repositories/drafts.js";
import { createEntityEnrichmentStore } from "./repositories/entity-enrichment.js";
import { createEventStore } from "./repositories/events.js";
import { createStudioMediaAssetStore } from "./repositories/studio-media-assets.js";
import { createStudioPostStore } from "./repositories/studio-posts.js";
import { createStudioQueueStore } from "./repositories/studio-queue.js";
import { createStudioSettingsStore } from "./repositories/studio-settings.js";
import { createStudioVideoStore } from "./repositories/studio-videos.js";
import * as schema from "./schema.js";
import type { RawBackendDb, RawSqlite } from "./unsafe.js";

export { unsafeDb } from "./unsafe.js";

/** Public runtime handle exposed to application services and interfaces. */
export type BackendDb = ApplicationPorts & {
  close: () => void;
};

/**
 * Explicit escape hatch for infrastructure code that still needs raw SQLite.
 * Keep this type out of Studio and Content application services.
 */
export type UnsafeBackendDb = BackendDb & {
  sqlite: RawBackendDb["sqlite"];
  db: RawBackendDb["db"];
};

export function openBackendDb(path: string, timeout = 30_000): BackendDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path, { create: true, strict: true }) as RawSqlite;
  sqlite.backup = async (target: string) => {
    // serialize() only snapshots the main .db file; in WAL mode, recently
    // committed data can still be sitting in .db-wal and would be silently
    // missing from the backup. VACUUM INTO merges the WAL first and writes
    // a single consistent file — the target must not already exist.
    if (existsSync(target)) unlinkSync(target);
    sqlite.run("VACUUM INTO ?", [target]);
  };
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run(`PRAGMA busy_timeout = ${timeout}`);
  // Read latency under concurrent writes is dominated by the writers' fsyncs
  // and by page reads missing a tiny cache. In WAL mode NORMAL keeps commits
  // durable across process crashes and only risks the last commits on a host
  // power loss, which is the right trade for this workload.
  sqlite.run("PRAGMA synchronous = NORMAL");
  sqlite.run("PRAGMA cache_size = -16384"); // 16 MB per connection
  sqlite.run("PRAGMA mmap_size = 33554432"); // 32 MB
  sqlite.run("PRAGMA wal_autocheckpoint = 4000"); // ~16 MB, off the read path more often
  const db = drizzle(sqlite, { schema, casing: "snake_case" });
  // The baseline creates children before their parents, so foreign keys stay
  // off until it has run.
  sqlite.run("PRAGMA foreign_keys = OFF");
  migrate(db, { migrationsFolder: migrationsFolder() });
  sqlite.run("PRAGMA foreign_keys = ON");
  // After the migrations, so a column created by one is guarded from the start.
  installDateGuards(sqlite);
  const clock = { now: () => new Date() };
  const backendDb: UnsafeBackendDb = {
    sqlite,
    db,
    clock,
    drafts: createDraftStore(db, clock),
    draftTranslations: createDraftTranslationStore(db, clock),
    events: createEventStore(db, clock),
    entityEnrichment: createEntityEnrichmentStore(db),
    channels: createChannelStore(db),
    studioSettings: createStudioSettingsStore(db),
    studioMediaAssets: createStudioMediaAssetStore(db),
    studioPosts: createStudioPostStore(db),
    conversationSessions: createConversationSessionStore(db),
    studioQueue: createStudioQueueStore(db),
    actionableIssues: createActionableIssueStore(db),
    studioVideos: createStudioVideoStore(db),
    storyCards: {
      queue: (draftId) => queueDraftStoryCards(db, draftId),
      forDraft: (draftId) => storyCardsForDraft(db, draftId),
      readyMedia: (draftId) => readyStoryCardMedia(db, draftId),
      setPublishMode: (draftId, mode) => setStoryPublishMode(db, draftId, mode),
    },
    close: () => sqlite.close(),
  };
  return backendDb;
}

function migrationsFolder(): string {
  return process.env.DRIZZLE_MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
}
