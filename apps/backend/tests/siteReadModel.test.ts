import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unsafeDb } from "../src/db/client.js";
import { draftEntityLinks, drafts, knowledgeEntities, postLocales, postMetrics } from "../src/db/schema.js";
import { invalidatePublicSiteFeed, loadPublicSiteFeed } from "../src/public/site-read-model.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";

let backendDb: ReturnType<typeof openBackendDb>;

const feedItem = (postId: number) => loadPublicSiteFeed(backendDb).find((item) => item.post_id === postId);
let rawDb: ReturnType<typeof unsafeDb>;

// Opened per test rather than inside each `it`: a failure before the assignment
// used to leave the previous test's handle in place and close it twice.
beforeEach(() => {
  backendDb = openBackendDb(":memory:");
  rawDb = unsafeDb(backendDb);
});
afterEach(() => backendDb.close());

describe("Drizzle site feed", () => {
  it("reuses an expired feed after quiet polls and unrelated writes but detects a content change without timestamp changes", () => {
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      seedTextPost(backendDb, { postId: 1, en: "Original", siteEn: true });
      const first = loadPublicSiteFeed(backendDb);
      clock.mockReturnValue(now + 3001);
      expect(loadPublicSiteFeed(backendDb)).toBe(first);
      rawDb.db
        .insert(postMetrics)
        .values({ publicationKey: "post:1", target: "other", metricName: "background", value: 2, unit: "count" })
        .run();
      clock.mockReturnValue(now + 6002);
      expect(loadPublicSiteFeed(backendDb)).toBe(first);
      rawDb.sqlite.run("UPDATE post_locales SET approved_text = 'Changed' WHERE draft_id = 1 AND locale = 'en'");
      clock.mockReturnValue(now + 9003);
      expect(loadPublicSiteFeed(backendDb)[0]?.text_en).toBe("Changed");
      rawDb.sqlite.run("UPDATE post_locales SET approved_text = 'Immediate' WHERE draft_id = 1 AND locale = 'en'");
      invalidatePublicSiteFeed(backendDb);
      expect(loadPublicSiteFeed(backendDb)[0]?.text_en).toBe("Immediate");
    } finally {
      clock.mockRestore();
    }
  });

  it("publishes a scheduled locale at its clock boundary without a database write", () => {
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      seedTextPost(backendDb, { postId: 1, en: "Scheduled", siteEn: true, publishedAt: new Date(now + 5000).toISOString() });
      const first = loadPublicSiteFeed(backendDb);
      expect(first).toEqual([]);
      clock.mockReturnValue(now + 3001);
      expect(loadPublicSiteFeed(backendDb)).toBe(first);
      clock.mockReturnValue(now + 6002);
      expect(loadPublicSiteFeed(backendDb)[0]?.text_en).toBe("Scheduled");
    } finally {
      clock.mockRestore();
    }
  });

  it("observes a publication change committed by a separate SQLite connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "site-feed-external-"));
    const file = join(dir, "site.sqlite");
    const db = openBackendDb(file);
    const external = new Database(file);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      seedTextPost(db, { postId: 1, en: "Original", siteEn: true });
      loadPublicSiteFeed(db);
      external.run("UPDATE post_locales SET approved_text = 'External' WHERE draft_id = 1 AND locale = 'en'");
      clock.mockReturnValue(now + 3001);
      expect(loadPublicSiteFeed(db)[0]?.text_en).toBe("External");
    } finally {
      clock.mockRestore();
      external.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads published localized posts and Telegram views from SQLite without feed.json", () => {
    const now = new Date().toISOString();
    rawDb.db
      .insert(drafts)
      .values({
        id: 7,
        actorId: 1,
        status: "published",
        targetsJson: "{}",
        postId: 7,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    rawDb.db
      .insert(postLocales)
      .values([
        {
          draftId: 7,
          locale: "ru",
          slug: "russkiy-post",
          sourceText: "Русский текст",
          html: "<p>Русский текст</p>",
          siteMediaJson: [{ type: "image", path: "media/posts/7-ru.jpg" }],
          siteEnabled: 1,
          publishedAt: now,
          updatedAt: now,
        },
        {
          draftId: 7,
          locale: "en",
          slug: "english-post",
          sourceText: "English text",
          html: "<p>English text</p>",
          siteMediaJson: [{ type: "video", path: "media/posts/7-en.mp4", poster: "media/posts/7-en.jpg" }],
          siteEnabled: 1,
          publishedAt: now,
          updatedAt: now,
        },
      ])
      .run();
    rawDb.db
      .insert(postMetrics)
      .values({ publicationKey: "post:7", target: "telegram", metricName: "views", value: 321, unit: "count" })
      .run();
    const entity = rawDb.db
      .insert(knowledgeEntities)
      .values({ kind: "company", slug: "example-ai", titleRu: "Example AI", titleEn: "Example AI", createdAt: now, updatedAt: now })
      .returning({ id: knowledgeEntities.id })
      .get();
    if (!entity) throw new Error("knowledge entity was not inserted");
    rawDb.db.insert(draftEntityLinks).values({ draftId: 7, entityId: entity.id, createdAt: now }).run();

    expect(loadPublicSiteFeed(backendDb)).toEqual([
      expect.objectContaining({
        id: "post:7",
        post_id: 7,
        text: "Русский текст",
        text_en: "English text",
        slug_ru: "russkiy-post",
        slug_en: "english-post",
        image: "media/posts/7-ru.jpg",
        image_en: null,
        views: 321,
        entities: [expect.objectContaining({ kind: "company", slug: "example-ai" })],
      }),
    ]);
    expect(feedItem(7)).toEqual(expect.objectContaining({ id: "post:7", post_id: 7, text_en: "English text" }));
    expect(feedItem(999)).toBeUndefined();
  });

  it("does not expose scheduled or disabled locales", () => {
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    rawDb.db
      .insert(drafts)
      .values({
        id: 8,
        actorId: 1,
        status: "scheduled",
        targetsJson: "{}",
        postId: 8,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    rawDb.db
      .insert(postLocales)
      .values({
        draftId: 8,
        locale: "en",
        slug: "future",
        sourceText: "Future",
        siteMediaJson: [],
        siteEnabled: 1,
        publishedAt: future,
        updatedAt: now,
      })
      .run();
    expect(loadPublicSiteFeed(backendDb)).toEqual([]);
  });

  it("exposes an EN locale while RU remains scheduled", () => {
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    rawDb.db
      .insert(drafts)
      .values({
        id: 10,
        actorId: 1,
        status: "scheduled",
        targetsJson: "{}",
        postId: 10,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    rawDb.db
      .insert(postLocales)
      .values([
        {
          draftId: 10,
          locale: "ru",
          slug: "ru-future",
          sourceText: "RU future",
          siteMediaJson: [],
          siteEnabled: 1,
          publishedAt: future,
          updatedAt: now,
        },
        {
          draftId: 10,
          locale: "en",
          slug: "en-now",
          sourceText: "EN now",
          siteMediaJson: [],
          siteEnabled: 1,
          publishedAt: now,
          updatedAt: now,
        },
      ])
      .run();

    expect(feedItem(10)).toEqual(expect.objectContaining({ text_en: "EN now", has_en: true, has_ru: false, slug_en: "en-now" }));
    // Nothing of the scheduled RU locale travels in the item. `/feed.json`
    // serialises the whole object, so text withheld anywhere but here reaches
    // the public feed before the post is published.
    expect(feedItem(10)).toEqual(expect.objectContaining({ text: "", text_ru: "", html: "", slug_ru: null, media: [] }));
    // The date of a published post is the date it was published. Taking RU
    // first regardless dated this one a week into the future, which sorted it
    // to the top of the feed and went out as a future RSS pubDate.
    expect(feedItem(10)?.date).toBe(now);
  });

  it("reads the persisted site media manifest", () => {
    const now = new Date().toISOString();
    rawDb.db
      .insert(drafts)
      .values({
        id: 9,
        actorId: 1,
        status: "published",
        targetsJson: "{}",
        postId: 9,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    rawDb.db
      .insert(postLocales)
      .values({
        draftId: 9,
        locale: "en",
        slug: "media-post",
        sourceText: "Media post",
        siteMediaJson: [{ type: "image", path: "media/posts/9-en-0-vertical.jpg?v=1234" }],
        siteEnabled: 1,
        publishedAt: now,
        updatedAt: now,
      })
      .run();

    expect(loadPublicSiteFeed(backendDb)[0]).toEqual(
      expect.objectContaining({
        image_en: "media/posts/9-en-0-vertical.jpg?v=1234",
        media_en: [expect.objectContaining({ path: "media/posts/9-en-0-vertical.jpg?v=1234" })],
      }),
    );
  });
});
