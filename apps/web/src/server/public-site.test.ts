import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type BackendDb, openBackendDb, unsafeDb } from "../../../backend/src/db/client.js";
import { draftEntityLinks, drafts, knowledgeEntities, postLocales, postMetrics } from "../../../backend/src/db/schema.js";
import { loadPublicSiteFeed, loadPublicSiteItem } from "../../../backend/src/public/site-read-model.js";

let backendDb: BackendDb;
let rawDb: ReturnType<typeof unsafeDb>;

// Opened per test rather than inside each `it`: a failure before the assignment
// used to leave the previous test's handle in place and close it twice.
beforeEach(() => {
  backendDb = openBackendDb(":memory:");
  rawDb = unsafeDb(backendDb);
});
afterEach(() => backendDb.close());

describe("Drizzle site feed", () => {
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
    expect(loadPublicSiteItem(backendDb, 7)).toEqual(expect.objectContaining({ id: "post:7", post_id: 7, text_en: "English text" }));
    expect(loadPublicSiteItem(backendDb, 999)).toBeUndefined();
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

    expect(loadPublicSiteItem(backendDb, 10)).toEqual(
      expect.objectContaining({ text_en: "EN now", has_en: true, has_ru: false, slug_en: "en-now" }),
    );
    // Nothing of the scheduled RU locale travels in the item. `/feed.json`
    // serialises the whole object, so text withheld anywhere but here reaches
    // the public feed before the post is published.
    expect(loadPublicSiteItem(backendDb, 10)).toEqual(
      expect.objectContaining({ text: "", text_ru: "", html: "", slug_ru: null, media: [] }),
    );
    // The date of a published post is the date it was published. Taking RU
    // first regardless dated this one a week into the future, which sorted it
    // to the top of the feed and went out as a future RSS pubDate.
    expect(loadPublicSiteItem(backendDb, 10)?.date).toBe(now);
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
