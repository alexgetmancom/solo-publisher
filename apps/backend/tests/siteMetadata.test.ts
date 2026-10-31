import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { postLocales } from "../src/db/schema.js";
import { applySiteMetadata, siteMetadataInventory, textHash } from "../src/operations/site-metadata.js";
import { loadPublicSiteFeed } from "../src/public/site-read-model.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";

const databases: ReturnType<typeof openBackendDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const db = openBackendDb(":memory:");
  databases.push(db);
  seedTextPost(db, {
    postId: 1,
    ru: "Текст статьи",
    en: "Article text",
    siteRu: true,
    siteEn: true,
    siteMediaRu: [{ type: "image", path: "media/ru.jpg?v=one" }],
    siteMediaEn: [{ type: "image", path: "media/en.jpg?v=one", responsive: [{ path: "media/en.webp", width: 640 }] }],
  });
  const item = {
    post_id: 1,
    locale: "en",
    text_sha256: textHash("Article text"),
    seo_title: "A concise search title",
    images: [{ path: "media/en.jpg?v=one", alt: "A chart comparing model performance on mathematics problems." }],
  };
  return { db, item, plan: { version: 1, items: [item] } };
}
describe("reviewed site metadata", () => {
  it("previews, saves and exposes localized metadata without changing publication text", () => {
    const { db, plan } = setup();
    expect(applySiteMetadata(db, plan, false)).toMatchObject({ changed: 1, images: 1 });
    expect(loadPublicSiteFeed(db)[0]?.seo_title_en).toBeNull();
    expect(applySiteMetadata(db, plan, true)).toMatchObject({ changed: 1, images: 1 });
    const post = loadPublicSiteFeed(db)[0];
    if (!post) throw new Error("Published post missing");
    expect(post.text_en).toBe("Article text");
    expect(post.seo_title_en).toBe("A concise search title");
    expect(post.seo_title_ru).toBeNull();
    expect(post.media_en[0]).toMatchObject({ alt: plan.items[0]?.images[0]?.alt, responsive: [{ path: "media/en.webp", width: 640 }] });
    expect(post.media[0]?.alt).toBeUndefined();
    expect(applySiteMetadata(db, plan, true)).toMatchObject({ changed: 0, images: 0 });
  });
  it("refuses stale text, replaced media and overwriting an editorial description", () => {
    const { db, item, plan } = setup();
    expect(() => applySiteMetadata(db, { version: 1, items: [{ ...item, text_sha256: textHash("Old text") }] }, true)).toThrow(
      "text changed",
    );
    expect(() =>
      applySiteMetadata(
        db,
        { version: 1, items: [{ ...item, images: [{ path: "media/en.jpg?v=old", alt: "Old image description" }] }] },
        true,
      ),
    ).toThrow("image changed");
    applySiteMetadata(db, plan, true);
    expect(() =>
      applySiteMetadata(
        db,
        { version: 1, items: [{ ...item, images: [{ ...item.images[0], alt: "An unrelated new description" }] }] },
        true,
      ),
    ).toThrow("Alt already edited");
  });
  it("rolls back the whole import when a later locale conflicts", () => {
    const { db, item } = setup();
    expect(() => applySiteMetadata(db, { version: 1, items: [item, { ...item, locale: "ru" }] }, true)).toThrow("text changed");
    expect(loadPublicSiteFeed(db)[0]?.seo_title_en).toBeNull();
  });
  it("corrects reviewed existing metadata only while its expected copy still matches", () => {
    const { db, item, plan } = setup();
    applySiteMetadata(db, plan, true);
    const corrected = {
      ...item,
      seo_title: "Corrected search title",
      expected_seo_title: item.seo_title,
      images: [{ ...item.images[0], alt: "A corrected image description.", expected_alt: item.images[0]?.alt }],
    };
    expect(() => applySiteMetadata(db, { version: 1, items: [{ ...corrected, expected_seo_title: "Stale title" }] }, true)).toThrow(
      "SEO title changed",
    );
    expect(() =>
      applySiteMetadata(
        db,
        { version: 1, items: [{ ...corrected, images: [{ ...corrected.images[0], expected_alt: "Stale description" }] }] },
        true,
      ),
    ).toThrow("Alt changed");
    expect(loadPublicSiteFeed(db)[0]?.seo_title_en).toBe(item.seo_title);
    expect(applySiteMetadata(db, { version: 1, items: [corrected] }, false)).toMatchObject({ changed: 1, images: 1 });
    expect(applySiteMetadata(db, { version: 1, items: [corrected] }, true)).toMatchObject({ changed: 1, images: 1 });
    expect(applySiteMetadata(db, { version: 1, items: [corrected] }, true)).toMatchObject({ changed: 0, images: 0 });
    expect(loadPublicSiteFeed(db)[0]).toMatchObject({ text_en: "Article text", seo_title_en: corrected.seo_title });
  });
  it("does not export a locale that has not been published", () => {
    const { db } = setup();
    db.db.update(postLocales).set({ publishedAt: "2099-01-01T00:00:00.000Z" }).where(eq(postLocales.locale, "en")).run();
    expect(siteMetadataInventory(db).items.map((item) => item.locale)).toEqual(["ru"]);
  });
});
