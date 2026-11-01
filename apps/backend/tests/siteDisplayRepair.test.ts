import { afterEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { postLocales } from "../src/db/schema.js";
import { repairSiteDisplay, siteEditorialFingerprint } from "../src/operations/site-display-repair.js";
import { loadPublicSiteFeed } from "../src/public/site-read-model.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
it("restores only reviewed dates, removes site decoration and retains social Story assets", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "site-display-repair-"));
  const db = openBackendDb(":memory:");
  cleanup.push(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const card = { type: "image", role: "text_story_card", path: "card.jpg" };
  seedTextPost(db, {
    postId: 1,
    ru: "Text news",
    siteRu: true,
    siteMediaRu: [card],
    storyMediaRu: [card],
    now: "2026-01-01T00:00:00.000Z",
  });
  db.sqlite.run("UPDATE post_locales SET site_updated_at = '2026-11-01T12:00:00.000Z' WHERE draft_id = 1 AND locale = 'ru'");
  const row = db.db.select().from(postLocales).where(eq(postLocales.locale, "ru")).get();
  if (!row) throw new Error("Missing fixture locale");
  const plan = {
    version: 1,
    dates: [
      {
        post_id: 1,
        locale: "ru",
        expected_updated_at: row.siteUpdatedAt,
        restore_updated_at: null,
        content_sha256: siteEditorialFingerprint(row),
      },
    ],
  };
  const file = path.join(directory, "plan.json");
  await Bun.write(file, JSON.stringify(plan));
  expect(loadPublicSiteFeed(db)[0]?.media).toEqual([]);
  expect(await repairSiteDisplay(db, file, false)).toMatchObject({ restored_dates: 1, removed_story_card_locales: 1 });
  expect(db.db.select().from(postLocales).where(eq(postLocales.locale, "ru")).get()?.siteUpdatedAt).toBe(row.siteUpdatedAt);
  expect(await repairSiteDisplay(db, file, true)).toMatchObject({ restored_dates: 1, removed_story_card_locales: 1 });
  const repaired = db.db.select().from(postLocales).where(eq(postLocales.locale, "ru")).get();
  expect(repaired?.siteUpdatedAt).toBeNull();
  expect(repaired?.siteMediaJson).toEqual([]);
  expect(repaired?.storyMediaJson).toEqual([card]);
  expect(repaired?.publishedAt).toBe(row.publishedAt);
  await expect(repairSiteDisplay(db, file, true)).rejects.toThrow("modification date changed");
});

it("rejects changed editorial content before restoring any dates", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "site-display-repair-"));
  const db = openBackendDb(":memory:");
  cleanup.push(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  seedTextPost(db, { postId: 1, ru: "Original", siteRu: true, now: "2026-01-01T00:00:00.000Z" });
  const row = db.db.select().from(postLocales).where(eq(postLocales.locale, "ru")).get();
  if (!row) throw new Error("Missing fixture locale");
  const file = path.join(directory, "plan.json");
  await Bun.write(
    file,
    JSON.stringify({
      version: 1,
      dates: [
        {
          post_id: 1,
          locale: "ru",
          expected_updated_at: "2026-11-01T12:00:00.000Z",
          restore_updated_at: null,
          content_sha256: siteEditorialFingerprint(row),
        },
      ],
    }),
  );
  db.sqlite.run("UPDATE post_locales SET approved_text = 'Real correction' WHERE draft_id = 1 AND locale = 'ru'");
  db.sqlite.run("UPDATE post_locales SET site_updated_at = '2026-11-01T12:00:00.000Z' WHERE draft_id = 1 AND locale = 'ru'");
  await expect(repairSiteDisplay(db, file, true)).rejects.toThrow("Editorial content");
  expect(db.db.select().from(postLocales).where(eq(postLocales.locale, "ru")).get()?.approvedText).toBe("Real correction");
});
