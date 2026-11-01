import { afterEach, expect, it } from "bun:test";
import { loadPublicSiteFeed } from "../src/public/site-read-model.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";

const dbs: ReturnType<typeof openBackendDb>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
it("dates actual public locale changes without re-dating publication or private bookkeeping", () => {
  const db = openBackendDb(":memory:");
  dbs.push(db);
  seedTextPost(db, { postId: 1, ru: "Original", en: "Original", siteRu: true, siteEn: true, now: "2026-01-01T00:00:00.000Z" });
  const original = loadPublicSiteFeed(db)[0]!;
  expect(original.updated_at_en).toBeNull();
  db.sqlite.run("UPDATE post_locales SET updated_at = '2026-02-01T00:00:00.000Z', entities_json = '[]' WHERE draft_id = 1");
  expect(loadPublicSiteFeed(db)[0]!.updated_at_en).toBeNull();
  db.sqlite.run("UPDATE post_locales SET approved_text = 'Published correction' WHERE draft_id = 1 AND locale = 'en'");
  const edited = loadPublicSiteFeed(db)[0]!;
  expect(edited.date).toBe(original.date);
  expect(Date.parse(edited.updated_at_en!)).toBeGreaterThan(Date.parse(original.date));
  expect(edited.updated_at_ru).toBeNull();
  db.sqlite.run("UPDATE post_locales SET source_text = 'Private translation changed' WHERE draft_id = 1 AND locale = 'en'");
  expect(loadPublicSiteFeed(db)[0]!.updated_at_en).toBe(edited.updated_at_en);
  db.sqlite.run("BEGIN");
  db.sqlite.run("UPDATE post_locales SET html = '<p>Correction</p>' WHERE draft_id = 1 AND locale = 'en'");
  db.sqlite.run("ROLLBACK");
  expect(loadPublicSiteFeed(db)[0]!.updated_at_en).toBe(edited.updated_at_en);
  expect(() => db.sqlite.run("UPDATE post_locales SET site_updated_at = 'yesterday' WHERE draft_id = 1")).toThrow("ISO instant");
});

it("does not date derivative regeneration or Story decoration as an editorial change", () => {
  const db = openBackendDb(":memory:");
  dbs.push(db);
  const before = [{ type: "image", asset_id: 10, path: "media/post-vertical.jpg?v=old", alt: "A chart" }];
  seedTextPost(db, { postId: 2, ru: "News", siteRu: true, siteMediaRu: before, now: "2026-01-01T00:00:00.000Z" });
  const write = (media: unknown) =>
    db.sqlite.run("UPDATE post_locales SET site_media_json = ? WHERE draft_id = 2 AND locale = 'ru'", [JSON.stringify(media)]);
  const date = () =>
    db.sqlite.query("SELECT site_updated_at AS date FROM post_locales WHERE draft_id = 2 AND locale = 'ru'").get() as {
      date: string | null;
    };
  write([{ ...before[0], path: "media/post.jpg?v=new", width: 1200, height: 600, responsive: [{ path: "small.webp" }] }]);
  expect(date().date).toBeNull();
  write([
    { ...before[0], path: "media/post.jpg?v=new" },
    { type: "image", role: "text_story_card", path: "card.jpg" },
  ]);
  expect(date().date).toBeNull();
  write(before);
  expect(date().date).toBeNull();
  write([{ ...before[0], alt: "A corrected chart description" }]);
  expect(date().date).not.toBeNull();
  db.sqlite.run("UPDATE post_locales SET site_updated_at = NULL WHERE draft_id = 2 AND locale = 'ru'");
  write([{ ...before[0], alt: "A corrected chart description", asset_id: 11 }]);
  expect(date().date).not.toBeNull();
});
