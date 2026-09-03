import { afterEach, describe, expect, it } from "bun:test";
import crypto from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { registerChannel } from "../src/channels/registry.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { channelConnections, drafts, postLocales, publishJobs, siteJobs } from "../src/db/schema.js";
import { mutateScheduledDraft } from "../src/publishing/scheduled-draft-mutation.js";
import { publicationSourceFromDb } from "../src/publishing/source-store.js";
import { postService } from "../src/studio/services/posts.js";
import { registerTestChannels, TEXT_TEST_CHANNELS } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

let backendDb: UnsafeBackendDb | null = null;

function openPostDb(): UnsafeBackendDb {
  const memory = ":memory:";
  const db = openBackendDb(memory);
  registerTestChannels(db, TEXT_TEST_CHANNELS);
  return db;
}

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

describe("Studio post commands", () => {
  it("previews EN entities and falls back to RU media exactly like delivery", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, {
      text: "Russian text",
      textEn: "English text",
      entities: [],
      media: [{ type: "photo", asset_id: 7 }],
    });
    posts.edit(42, draftId, {
      locale: "en",
      text: "English text",
      entities: [{ type: "bold", offset: 0, length: 7 }],
      media: [],
    });

    const preview = posts.preview(42, draftId);
    expect(preview.locales).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ locale: "en", text: "English text", entities: [{ type: "bold", offset: 0, length: 7 }] }),
      ]),
    );
    expect(preview.locales.find((locale) => locale.locale === "en")?.media).toEqual([{ type: "photo", asset_id: 7 }]);
  });

  it("shares draft commands with configured Studio admins and rejects outsiders", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42,7" }));
    const draftId = posts.create(42, { text: "Private draft", textEn: "Private draft", entities: [], media: [] });

    expect(posts.get(7, draftId).id).toBe(draftId);
    posts.toggleTarget(7, draftId, "telegram");
    expect(() => posts.get(9, draftId)).toThrow("err.post-not-yours");
    expect(() => posts.publish(9, draftId)).toThrow("err.post-not-yours");
    expect(() => posts.cancel(9, draftId)).toThrow("err.post-not-yours");

    expect(posts.get(42, draftId).id).toBe(draftId);
    expect(posts.progress(42, draftId).targets.length).toBeGreaterThan(0);
  });

  it("resolves manual schedule plans before publishing them", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Schedule", textEn: "Schedule", entities: [], media: [] });

    const manual = posts.manualSchedule(42, draftId, "both", "23:15");
    expect(manual.ruAt?.getMinutes()).toBe(15);
    expect(manual.enAt?.getMinutes()).toBe(15);
  });

  it("replans unfinished targets when a scheduled post's platforms change", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Targets", textEn: "Targets", entities: [], media: [] });
    posts.toggleTarget(42, draftId, "threads_en");
    const ruAt = new Date(Date.now() + 5 * 60_000);
    const enAt = new Date(Date.now() + 6 * 60_000);
    const postId = posts.schedule(42, draftId, { ruAt, enAt });

    expect(
      backendDb.sqlite
        .prepare("SELECT COUNT(*) AS count FROM publish_jobs WHERE publication_key='post:'||? AND target='threads_en'")
        .get(postId),
    ).toEqual({
      count: 0,
    });

    posts.toggleTarget(42, draftId, "threads_en");
    expect(
      backendDb.sqlite.prepare("SELECT publish_at FROM publish_jobs WHERE publication_key='post:'||? AND target='threads_en'").get(postId),
    ).toEqual({
      publish_at: enAt.toISOString(),
    });

    posts.toggleTarget(42, draftId, "threads_en");
    expect(
      backendDb.sqlite
        .prepare("SELECT COUNT(*) AS count FROM publish_jobs WHERE publication_key='post:'||? AND target='threads_en'")
        .get(postId),
    ).toEqual({
      count: 0,
    });
  });

  it("rejects a post schedule that is already in the past", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Past", textEn: "Past", entities: [], media: [] });

    expect(() => posts.schedule(42, draftId, { ruAt: new Date(Date.now() - 1_000), enAt: null })).toThrow("err.schedule-time-past");
  });

  it("replans the durable payload when a scheduled post is edited", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Before", textEn: "Before", entities: [], media: [] });
    const postId = posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 5 * 60_000), enAt: null });

    posts.edit(42, draftId, { locale: "ru", text: "After", entities: [], media: [] });

    const source = publicationSourceFromDb(backendDb.db, postId);
    const job = backendDb.db
      .select()
      .from(publishJobs)
      .where(eq(publishJobs.publicationKey, `post:${postId}`))
      .get();
    expect(source.locales.ru).toMatchObject({ text: "After" });
    expect(job?.payloadJson).toMatchObject({ locale: "ru", text: "After" });
  });

  it("rolls a scheduled content edit back when the replacement plan is invalid", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const original = "Исходный русский текст";
    const draftId = posts.create(42, { text: original, textEn: "Before", entities: [], media: [] });
    posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 5 * 60_000), enAt: null });

    expect(() =>
      posts.edit(42, draftId, {
        locale: "ru",
        text: "This text is definitely written only in English.",
        entities: [],
        media: [],
      }),
    ).toThrow("err.post-preflight");
    expect(posts.get(42, draftId).text_ru).toBe(original);
  });

  it("does not overwrite a scheduled draft after its revision changed", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Before", textEn: "Before", entities: [], media: [] });
    posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 5 * 60_000), enAt: null });
    const stale = posts.get(42, draftId);
    backendDb.drafts.update(draftId, { textRu: "Winner", updatedAt: new Date(Date.now() + 1_000).toISOString() });

    expect(
      mutateScheduledDraft(backendDb, stale, { patch: { textRu: "Loser", updatedAt: new Date(Date.now() + 2_000).toISOString() } }),
    ).toBe(false);
    expect(posts.get(42, draftId).text_ru).toBe("Winner");
  });

  it("refuses English copy for a Studio that publishes no English", () => {
    backendDb = openBackendDb(":memory:");
    registerTestChannels(backendDb, ["telegram", "instagram_stories_ru"]);
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));

    // Every transport creates drafts here, so MCP and the CLI are told the same
    // thing the Telegram screens already stopped offering, instead of storing
    // English nothing can publish.
    expect(() => posts.create(42, { text: "RU", textEn: "EN", entities: [], media: [] })).toThrow("err.post-locale-not-served");
    expect(() => posts.create(42, { text: "RU", textEnApproved: "EN", entities: [], media: [] })).toThrow("err.post-locale-not-served");
    const draftId = posts.create(42, { text: "RU", entities: [], media: [] });
    expect(draftId).toBeGreaterThan(0);
    expect(() => posts.edit(42, draftId, { locale: "en", text: "EN", entities: [], media: [] })).toThrow("err.post-locale-not-served");
    expect(() => posts.edit(42, draftId, { locale: "ru", text: "RU again", entities: [], media: [] })).not.toThrow();
  });

  it("counts Story cards ready when every card the draft has is rendered", () => {
    backendDb = openBackendDb(":memory:");
    registerTestChannels(backendDb, ["telegram", "instagram_stories_ru"]);
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Только RU", entities: [], media: [] });
    const card = join(tmpdir(), `story-card-${crypto.randomUUID()}.png`);
    writeFileSync(card, "ru");
    try {
      // A one-language draft has one card. Waiting for an EN card the queue
      // never renders left the publication choice unsent forever.
      expect(backendDb.storyCards.forDraft(draftId).map((entry) => entry.locale)).toEqual(["ru"]);
      backendDb.sqlite
        .query("UPDATE draft_story_cards SET status='ready',local_path=?,updated_at=? WHERE draft_id=?")
        .run(card, new Date().toISOString(), draftId);
      const projection = posts.preview(42, draftId).delivery.projections.find((item) => item.locale === "ru");
      expect(projection?.unavailableTargets).not.toContain("instagram_stories_ru");
      expect(projection?.targets).toContain("instagram_stories_ru");
    } finally {
      rmSync(card, { force: true });
    }
  });

  it("uses effective targets when deciding whether a Story-card replan must wait", () => {
    backendDb = openPostDb();
    backendDb.db.delete(channelConnections).run();
    registerChannel(backendDb, {
      platform: "site",
      locale: "ru",
      provider: "internal",
      targetId: "site_ru",
      source: "test",
    });
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Before", entities: [], media: [] });
    posts.setStoryPublishMode(42, draftId, "all");
    const postId = posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 5 * 60_000), enAt: null });

    posts.edit(42, draftId, { locale: "ru", text: "After", entities: [], media: [] });

    expect(publicationSourceFromDb(backendDb.db, postId).locales.ru).toMatchObject({ text: "After" });
  });

  it("restores an unapproved EN translation as null when a replan rejects the edit", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Before", textEn: "Before", entities: [], media: [] });
    posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 5 * 60_000), enAt: null });

    expect(() =>
      posts.edit(42, draftId, {
        locale: "en",
        text: "x".repeat(501),
        entities: [],
        media: [],
      }),
    ).toThrow();
    expect(
      backendDb.db
        .select({ textEnApproved: postLocales.approvedText })
        .from(postLocales)
        .where(eq(postLocales.draftId, draftId))
        .all()
        .find((row) => row.textEnApproved === null),
    ).toEqual({
      textEnApproved: null,
    });
  });

  it("blocks material edits inside the publication lock window", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Before", textEn: "Before", entities: [], media: [] });
    posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 60_000), enAt: null });

    expect(() => posts.edit(42, draftId, { locale: "ru", text: "After", entities: [], media: [] })).toThrow(
      "err.post-too-close-to-publish",
    );
    expect(() => posts.toggleTarget(42, draftId, "telegram")).toThrow("err.post-too-close-to-publish");
  });

  it("blocks content mutations after the publication is settled but allows rescheduling", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Settled", textEn: "Settled", entities: [], media: [] });
    backendDb.db.update(drafts).set({ status: "published" }).where(eq(drafts.id, draftId)).run();

    expect(() => posts.edit(42, draftId, { locale: "ru", text: "Changed", entities: [], media: [] })).toThrow("err.post-locked");
    expect(() => posts.toggleTarget(42, draftId, "telegram")).toThrow("err.post-locked");
    expect(() => posts.publish(42, draftId)).toThrow("err.post-locked");
    expect(() => posts.cancel(42, draftId)).toThrow("err.post-locked");
    posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 60_000), enAt: null });
  });

  it("does not duplicate final jobs when a settled post is rescheduled", () => {
    backendDb = openPostDb();
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
    const posts = postService(backendDb, config);
    const draftId = posts.create(42, { text: "Settled", textEn: "Settled", entities: [], media: [] });
    const firstAt = new Date(Date.now() + 5 * 60_000);
    const postId = posts.schedule(42, draftId, { ruAt: firstAt, enAt: firstAt });
    const socialBefore = backendDb.db
      .select({ jobId: publishJobs.jobId })
      .from(publishJobs)
      .where(eq(publishJobs.publicationKey, `post:${postId}`))
      .all();
    const siteBefore = backendDb.db
      .select({ jobId: siteJobs.jobId })
      .from(siteJobs)
      .where(eq(siteJobs.publicationKey, `post:${postId}`))
      .all();

    backendDb.db
      .update(publishJobs)
      .set({ status: "published" })
      .where(eq(publishJobs.publicationKey, `post:${postId}`))
      .run();
    backendDb.db
      .update(siteJobs)
      .set({ status: "published" })
      .where(eq(siteJobs.publicationKey, `post:${postId}`))
      .run();
    backendDb.db.update(drafts).set({ status: "published" }).where(eq(drafts.id, draftId)).run();

    const nextAt = new Date(Date.now() + 10 * 60_000);
    posts.schedule(42, draftId, { ruAt: nextAt, enAt: nextAt });
    expect(
      backendDb.db
        .select({ jobId: publishJobs.jobId })
        .from(publishJobs)
        .where(eq(publishJobs.publicationKey, `post:${postId}`))
        .all(),
    ).toEqual(socialBefore);
    expect(
      backendDb.db
        .select({ jobId: siteJobs.jobId })
        .from(siteJobs)
        .where(eq(siteJobs.publicationKey, `post:${postId}`))
        .all(),
    ).toEqual(siteBefore);
    expect(
      backendDb.db
        .select({ status: publishJobs.status })
        .from(publishJobs)
        .where(eq(publishJobs.publicationKey, `post:${postId}`))
        .all()
        .every((job) => job.status === "published"),
    ).toBe(true);
    expect(posts.get(42, draftId)).toMatchObject({
      status: "published",
      scheduled_at: nextAt.toISOString(),
      scheduled_en_at: nextAt.toISOString(),
    });
  });
});
