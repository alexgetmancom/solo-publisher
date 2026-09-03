import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { draftEntityLinks, knowledgeEntities } from "../src/db/schema.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { registerTestChannels } from "./helpers/channels.js";
import { withDb } from "./helpers/db.js";
import { openBackendDb } from "./helpers/open-db.js";

function insertVideoAsset(backendDb: ReturnType<typeof openBackendDb>): void {
  const now = new Date().toISOString();
  backendDb.sqlite
    .query(
      "INSERT INTO studio_media_assets(id,actor_id,kind,mime_type,filename,local_path,byte_size,sha256,source,created_at) VALUES (1,1,'video','video/mp4','test.mp4','/tmp/test.mp4',1,'test','test',?)",
    )
    .run(now);
}

describe("openBackendDb", () => {
  it("enables WAL, busy timeout and foreign keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-backend-"));
    const backendDb = openBackendDb(join(dir, "pipeline.db"), 5000);
    try {
      expect(backendDb.sqlite.query("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      expect(backendDb.sqlite.query("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5000 });
      expect(backendDb.sqlite.query("PRAGMA synchronous").get()).toMatchObject({ synchronous: 1 });
      expect(backendDb.sqlite.query("PRAGMA cache_size").get()).toMatchObject({ cache_size: -16_384 });
      expect(backendDb.sqlite.query("PRAGMA mmap_size").get()).toMatchObject({ mmap_size: 33_554_432 });
      expect(backendDb.sqlite.query("PRAGMA wal_autocheckpoint").get()).toMatchObject({ wal_autocheckpoint: 4_000 });
      expect(backendDb.sqlite.query("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    } finally {
      backendDb.close();
    }
  });

  it("does not replay the squashed baseline on a database that passed the old chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-squashed-baseline-"));
    const dbPath = join(dir, "pipeline.db");
    const sqlite = new Database(dbPath);
    // A real predecessor is the whole baseline, not a stub: a migration that
    // rebuilds a table is only proven by a database that has every table it
    // touches. What the baseline cannot express is what the old chain left
    // behind — the analytics foreign keys to `posts`, and the pre-Drizzle
    // migration table — so those are added on top.
    sqlite.exec(readFileSync(new URL("../drizzle/0000_baseline.sql", import.meta.url), "utf8"));
    sqlite.exec(`
      CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric);
      INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('old-chain', 1787280000000);
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY);
      CREATE TABLE old_chain_marker (id integer PRIMARY KEY);
      DROP TABLE metric_samples;
      CREATE TABLE metric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, publication_key TEXT NOT NULL, target TEXT NOT NULL,
        metric_name TEXT NOT NULL DEFAULT 'views', value INTEGER, sampled_at TEXT NOT NULL, source TEXT, raw_json TEXT,
        FOREIGN KEY (publication_key) REFERENCES posts(publication_key) ON DELETE CASCADE
      );
      DROP TABLE publication_targets;
      CREATE TABLE publication_targets (
        publication_key TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unknown',
        external_id TEXT, external_ids_json TEXT, url TEXT, error TEXT, skipped INTEGER NOT NULL DEFAULT 0,
        published_at TEXT, updated_at TEXT NOT NULL, raw_json TEXT, confirmation_source TEXT, verified_at TEXT,
        PRIMARY KEY (publication_key, target),
        FOREIGN KEY (publication_key) REFERENCES posts(publication_key) ON DELETE CASCADE
      );
      INSERT INTO posts (post_id, publication_key, message_id, status, created_at, updated_at)
      VALUES (1, 'post:1', 11, 'active', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      INSERT INTO metric_samples (publication_key, target, sampled_at) VALUES ('post:1', 'telegram', '2026-08-01T00:00:00.000Z');
      INSERT INTO publication_targets (publication_key, target, updated_at) VALUES ('post:1', 'telegram', '2026-08-01T00:00:00.000Z');
      INSERT INTO worker_state (name, state_json, updated_at) VALUES ('site', '{}', '2026-08-01T00:00:00.000Z');
    `);
    sqlite.close();

    const backendDb = openBackendDb(dbPath);
    try {
      expect(backendDb.sqlite.query("SELECT name FROM sqlite_master WHERE name='old_chain_marker'").get()).toBeDefined();
      expect(backendDb.sqlite.query("SELECT name FROM sqlite_master WHERE name='posts'").get()).toBeNull();
      // The pre-Drizzle migration table is gone and no foreign key is left
      // pointing at a table the aggregate migration dropped.
      expect(backendDb.sqlite.query("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get()).toBeNull();
      expect(backendDb.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
      // Rows survive the rebuilds, and every write the workers make now lands
      // instead of failing on the dropped parent.
      expect(backendDb.sqlite.query("SELECT count(*) c FROM metric_samples").get()).toMatchObject({ c: 1 });
      expect(backendDb.sqlite.query("SELECT count(*) c FROM publication_targets").get()).toMatchObject({ c: 1 });
      expect(backendDb.sqlite.query("SELECT count(*) c FROM worker_state").get()).toMatchObject({ c: 1 });
      expect(backendDb.sqlite.query("SELECT name FROM pragma_table_info('drafts') WHERE name='channel_message_id'").get()).toBeNull();
      expect(backendDb.sqlite.query("SELECT name FROM pragma_table_info('site_jobs') WHERE name='message_id'").get()).toBeNull();
      backendDb.sqlite.query("DELETE FROM metric_samples").run();
      backendDb.sqlite.query("UPDATE publication_targets SET status = 'published'").run();
      // An index the baseline grew after the squash reaches an old database too.
      expect(backendDb.sqlite.query("SELECT name FROM sqlite_master WHERE name='idx_publish_jobs_updated_at'").get()).toBeDefined();
    } finally {
      backendDb.close();
    }
  });

  it("moves historical text posts into one aggregate without losing published content", () => {
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-post-aggregate-"));
    const dbPath = join(dir, "pipeline.db");
    const sqlite = new Database(dbPath);
    sqlite.exec(readFileSync(new URL("../drizzle/0000_baseline.sql", import.meta.url), "utf8"));
    sqlite.exec(`
      CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric);
      INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('baseline', 1783727704995);
      INSERT INTO drafts (
        id, actor_id, status, text_ru, text_en_machine, text_en_approved, targets_json,
        media_ru_json, media_en_json, channel_message_id, scheduled_at, scheduled_en_at,
        publish_mode, post_id, text_ru_entities_json, text_en_entities_json,
        threads_chain_approved, story_publish_mode, created_at, updated_at
      ) VALUES (
        7, 42, 'ready', 'Draft RU', 'Machine EN', 'Approved EN', '{"telegram":true}',
        '[{"type":"photo","local_path":"ru.jpg"}]', '[{"type":"photo","local_path":"en.jpg"}]',
        99, '2026-08-20T09:00:00.000Z', '2026-08-20T10:00:00.000Z', 'scheduled', 42,
        '[{"type":"bold","offset":0,"length":5}]', '[]', 1, 'publish',
        '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
      );
      INSERT INTO publications (post_id, draft_id, status, telegram_message_id, created_at, updated_at)
      VALUES (42, 7, 'published', 100, '2026-08-19T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
      INSERT INTO drafts (
        id, actor_id, status, text_ru, targets_json, post_id, threads_chain_approved, created_at, updated_at
      ) VALUES (
        8, 42, 'draft', 'Duplicate draft', '{}', 42, 0,
        '2026-08-20T00:00:00.000Z', '2026-08-22T00:00:00.000Z'
      );
      INSERT INTO publications (post_id, draft_id, status, telegram_message_id, created_at, updated_at)
      VALUES (43, 7, 'failed', 101, '2026-08-20T00:00:00.000Z', '2026-08-22T00:00:00.000Z');
      INSERT INTO posts (
        publication_key, post_id, channel, message_id, text, text_en, media_json, status, created_at, updated_at
      ) VALUES (
        'telegram:100', 42, 'telegram', 100, 'Published RU', 'Published EN', '[{"type":"photo"}]', 'active',
        '2026-08-19T00:00:00.000Z', '2026-08-21T01:00:00.000Z'
      );
      INSERT INTO publication_plans (post_id, plan_json, created_at, updated_at)
      VALUES (42, '{"targets":{"telegram":true}}', '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
      INSERT INTO publication_sources (post_id, item_json, created_at, updated_at)
      VALUES (42, '{"story_media_ru":[{"type":"photo","local_path":"story.jpg"}],"site_media_en":[{"type":"photo","local_path":"site.jpg"}]}', '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
      INSERT INTO post_locales (post_id, locale, slug, text, html, entities_json, media_json, site_enabled, published_at, updated_at)
      VALUES
        (42, 'ru', 'ru-slug', 'Site RU', '<p>RU</p>', '[]', '[{"type":"photo","url":"ru.webp"}]', 1, '2026-08-20T09:01:00.000Z', '2026-08-21T00:00:00.000Z'),
        (42, 'en', 'en-slug', 'Site EN', '<p>EN</p>', '[]', '[{"type":"photo","url":"en.webp"}]', 1, '2026-08-20T10:01:00.000Z', '2026-08-21T00:00:00.000Z');
      INSERT INTO posts (publication_key, post_id, channel, message_id, text, text_en, status, created_at, updated_at)
      VALUES ('telegram:200', 55, 'telegram', 200, 'Orphan RU', 'Orphan EN', 'active', '2026-08-18T00:00:00.000Z', '2026-08-18T01:00:00.000Z');
    `);
    sqlite.close();

    const backendDb = openBackendDb(dbPath);
    try {
      expect(
        backendDb.sqlite
          .prepare("SELECT id, actor_id, status, post_id, threads_chain_approved, story_publish_mode FROM drafts WHERE post_id=42")
          .get(),
      ).toEqual({
        id: 7,
        actor_id: 42,
        status: "published",
        post_id: 42,
        threads_chain_approved: 1,
        story_publish_mode: "publish",
      });
      expect(
        backendDb.sqlite
          .prepare(
            "SELECT source_text, approved_text, media_json, story_media_json, site_media_json, slug, site_enabled, publish_at, published_at FROM post_locales WHERE draft_id=7 AND locale='en'",
          )
          .get(),
      ).toEqual({
        source_text: "Machine EN",
        approved_text: "Approved EN",
        media_json: '[{"type":"photo","local_path":"en.jpg"}]',
        story_media_json: null,
        site_media_json: '[{"type":"photo","url":"en.webp"}]',
        slug: "en-slug",
        site_enabled: 1,
        publish_at: "2026-08-20T10:00:00.000Z",
        published_at: "2026-08-20T10:01:00.000Z",
      });
      expect(
        backendDb.sqlite
          .prepare("SELECT source_text FROM post_locales JOIN drafts ON drafts.id=post_locales.draft_id WHERE post_id=55 AND locale='ru'")
          .get(),
      ).toEqual({ source_text: "Orphan RU" });
      expect(backendDb.sqlite.prepare("SELECT count(*) AS count FROM drafts WHERE post_id=42").get()).toEqual({ count: 1 });
      expect(backendDb.sqlite.prepare("SELECT post_id FROM drafts WHERE id=8").get()).toEqual({ post_id: null });
      expect(backendDb.sqlite.prepare("SELECT actor_id, status FROM drafts WHERE post_id=43").get()).toEqual({
        actor_id: 0,
        status: "failed",
      });
      for (const table of ["posts", "publications", "publication_plans", "publication_sources"])
        expect(backendDb.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeNull();
    } finally {
      backendDb.close();
    }
  });

  /** Required persisted state is explicit: a destructive migration still
   * applies cleanly, so behavioural tests cannot detect an unrelated drop. */
  it("keeps every required persisted table after applying Drizzle migrations", () =>
    withDb(async (backendDb) => {
      const tables = new Set(
        backendDb.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row: { name: string }) => row.name),
      );
      for (const table of [
        "conversation_sessions",
        "alert_dedup",
        "analytics_rollups",
        "credential_checks",
        "drafts",
        "media_test_cases",
        "metric_samples",
        "metric_schedule",
        "pending_albums",
        "format_support",
        "publication_events",
        "post_locales",
        "post_metrics",
        "publication_targets",
        "publish_jobs",
        "runtime_usage",
        "site_jobs",
        "studio_media_assets",
        "studio_news_digest_settings",
        "studio_weekly_digest_settings",
        "worker_state",
        "x_activity_imports",
        "x_activity_items",
        "x_activity_metric_snapshots",
      ])
        expect(tables, table).toContain(table);

      const indexes = new Set(
        backendDb.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='index'")
          .all()
          .map((row: { name: string }) => row.name),
      );
      for (const index of ["idx_knowledge_entities_parent", "idx_video_drafts_studio_media_asset", "idx_x_activity_imports_checksum"])
        expect(indexes, index).toContain(index);
    }));

  it("cascades video dependencies at the database level", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      insertVideoAsset(backendDb);
      backendDb.sqlite
        .prepare(
          "INSERT INTO video_drafts (actor_id, label, studio_media_asset_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(1, "", 1, "draft", now, now);
      backendDb.sqlite
        .prepare(
          "INSERT INTO video_targets (video_draft_id, target, metadata_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(1, "youtube_shorts", "{}", "draft", now, now);
      backendDb.sqlite
        .prepare(
          "INSERT INTO video_jobs (video_draft_id, video_target_id, kind, run_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(1, 1, "publish", now, "queued", now, now);
      backendDb.sqlite
        .prepare("INSERT INTO video_metric_snapshots (video_target_id, platform, metrics_json, sampled_at) VALUES (?, ?, ?, ?)")
        .run(1, "youtube_shorts", "{}", now);
      backendDb.sqlite
        .prepare("INSERT INTO video_metric_schedule (video_target_id, next_check_at, updated_at) VALUES (?, ?, ?)")
        .run(1, now, now);
      backendDb.sqlite
        .prepare("INSERT INTO social_comments (platform, comment_id, video_target_id, text, fetched_at) VALUES (?, ?, ?, ?, ?)")
        .run("youtube", "comment", 1, "x", now);

      backendDb.sqlite.prepare("DELETE FROM video_drafts WHERE id=?").run(1);

      for (const table of ["video_targets", "video_jobs", "video_metric_snapshots", "video_metric_schedule", "social_comments"])
        expect(backendDb.sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }));

  it("enforces one video metric snapshot per checkpoint while allowing uncheckpointed rows", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      insertVideoAsset(backendDb);
      backendDb.sqlite
        .prepare(
          "INSERT INTO video_drafts (actor_id, label, studio_media_asset_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(1, "", 1, "draft", now, now);
      backendDb.sqlite
        .prepare(
          "INSERT INTO video_targets (video_draft_id, target, metadata_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(1, "youtube_shorts", "{}", "draft", now, now);

      const insert = backendDb.sqlite.prepare(
        "INSERT INTO video_metric_snapshots (video_target_id, platform, metrics_json, checkpoint_index, sampled_at) VALUES (?, ?, ?, ?, ?)",
      );
      insert.run(1, "youtube_shorts", "{}", 1, now);
      expect(() => insert.run(1, "youtube_shorts", "{}", 1, now)).toThrow();
      insert.run(1, "youtube_shorts", "{}", null, now);
      insert.run(1, "youtube_shorts", "{}", null, now);
    }));

  it("links a published model to its company without an editor confirmation", () =>
    withDb(async (backendDb) => {
      registerTestChannels(backendDb, ["threads_en"]);
      const draftId = createDraftFromMessage(backendDb, 42, {
        text: "Claude received a new update",
        textEn: "Claude received a new update",
        entities: [],
        media: [],
      });
      publishDraftToQueue(backendDb, draftId);
      const linked = backendDb.db
        .select({ slug: knowledgeEntities.slug, role: draftEntityLinks.linkRole })
        .from(draftEntityLinks)
        .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, draftEntityLinks.entityId))
        .where(eq(draftEntityLinks.draftId, draftId))
        .all()
        .sort((left, right) => left.slug.localeCompare(right.slug));
      expect(linked).toEqual([
        { slug: "anthropic", role: "mention" },
        { slug: "claude", role: "focus" },
      ]);
    }));

  it("keeps a comparison as a mention instead of making it a hub update", () =>
    withDb(async (backendDb) => {
      registerTestChannels(backendDb, ["threads_en"]);
      const draftId = createDraftFromMessage(backendDb, 42, {
        text: "Qwen announced a new flagship\n\nIt competes with Claude Fable.",
        textEn: "Qwen announced a new flagship\n\nIt competes with Claude Fable.",
        entities: [],
        media: [],
      });
      publishDraftToQueue(backendDb, draftId);
      const links = backendDb.db
        .select({ slug: knowledgeEntities.slug, role: draftEntityLinks.linkRole })
        .from(draftEntityLinks)
        .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, draftEntityLinks.entityId))
        .where(eq(draftEntityLinks.draftId, draftId))
        .all();
      expect(links).toContainEqual({ slug: "claude", role: "mention" });
      expect(links).toContainEqual({ slug: "fable-5", role: "mention" });
    }));

  it("does not treat a competitor headline as a Claude hub update", () =>
    withDb(async (backendDb) => {
      registerTestChannels(backendDb, ["threads_en"]);
      const draftId = createDraftFromMessage(backendDb, 42, {
        text: "Grok 4.5 is a new competitor to GPT and Claude\n\nThe release is now available.",
        textEn: "Grok 4.5 is a new competitor to GPT and Claude\n\nThe release is now available.",
        entities: [],
        media: [],
      });
      publishDraftToQueue(backendDb, draftId);
      const link = backendDb.db
        .select({ role: draftEntityLinks.linkRole })
        .from(draftEntityLinks)
        .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, draftEntityLinks.entityId))
        .where(and(eq(draftEntityLinks.draftId, draftId), eq(knowledgeEntities.slug, "claude")))
        .get();
      expect(link).toEqual({ role: "mention" });
    }));

  it("recognizes Codex as the focus only when it is the subject or the tool used", () =>
    withDb(async (backendDb) => {
      registerTestChannels(backendDb, ["threads_en"]);
      const directDraft = createDraftFromMessage(backendDb, 42, {
        text: "GPT ported RollerCoaster Tycoon to iPad\n\nThe developer built it with Codex.",
        textEn: "GPT ported RollerCoaster Tycoon to iPad\n\nThe developer built it with Codex.",
        entities: [],
        media: [],
      });
      publishDraftToQueue(backendDb, directDraft);
      const direct = backendDb.db
        .select({ role: draftEntityLinks.linkRole })
        .from(draftEntityLinks)
        .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, draftEntityLinks.entityId))
        .where(and(eq(draftEntityLinks.draftId, directDraft), eq(knowledgeEntities.slug, "codex")))
        .get();
      expect(direct).toEqual({ role: "focus" });

      const asideDraft = createDraftFromMessage(backendDb, 42, {
        text: "Claude reset limits\n\nI was too busy using Codex to notice.",
        textEn: "Claude reset limits\n\nI was too busy using Codex to notice.",
        entities: [],
        media: [],
      });
      publishDraftToQueue(backendDb, asideDraft);
      const aside = backendDb.db
        .select({ role: draftEntityLinks.linkRole })
        .from(draftEntityLinks)
        .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, draftEntityLinks.entityId))
        .where(and(eq(draftEntityLinks.draftId, asideDraft), eq(knowledgeEntities.slug, "codex")))
        .get();
      expect(aside).toEqual({ role: "mention" });
    }));
});
