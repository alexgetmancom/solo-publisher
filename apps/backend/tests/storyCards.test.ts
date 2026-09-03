import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { storyCardUse } from "../src/botTargets.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { draftStoryCards, drafts, postLocales, publicationEvents, publishJobs, siteJobs } from "../src/db/schema.js";
import { backfillTextStoryCards } from "../src/operations/story-card-backfill.js";
import { localizeTargetPayload } from "../src/publishing/payload.js";
import { createPublicationPlan } from "../src/publishing/publication-plan.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { publicationSourceFromDb } from "../src/publishing/source-store.js";
import { buildStoryCardCopy, MAX_LINES, TEMPLATE_VERSION } from "../src/story-cards/copy.js";
import { discardDraftStoryCards, readyStoryCardMedia, setStoryPublishMode, storyCardsForDraft } from "../src/story-cards/store.js";
import { emojiAssetFile, STORY_CARD_EMOJI_LEFT, STORY_CARD_EMOJI_SIZE, storyCardEmojiTop } from "../src/story-cards/svg.js";
import { runStoryCardCycle, STORY_CARD_MAX_ATTEMPTS } from "../src/story-cards/worker.js";
import { postService } from "../src/studio/services/posts.js";
import { registerTestChannels, TEXT_TEST_CHANNELS } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

let backendDb: UnsafeBackendDb | null = null;

function openStoryDb(): UnsafeBackendDb {
  const memory = ":memory:";
  const db = openBackendDb(memory);
  registerTestChannels(db, TEXT_TEST_CHANNELS);
  return db;
}
const temporaryDirectories: string[] = [];
const storyCardAssets = fileURLToPath(new URL("../assets/story-card/", import.meta.url));
const storyCardRenderer = fileURLToPath(new URL("../src/story-cards/renderer-process.ts", import.meta.url));
const testStoryCardRenderer = fileURLToPath(new URL("./fixtures/story-card-renderer.ts", import.meta.url));

afterEach(() => {
  backendDb?.close();
  backendDb = null;
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("text Story cards", () => {
  it("extracts a leading emoji and wraps the headline within the line budget", () => {
    const copy = buildStoryCardCopy(
      "🚨 СЛИВ: Две модели OpenAI с кодовыми именами Zinc и Magnesium были замечены в DesignArena. Остальной пост не нужен.",
    );
    expect(copy.emoji).toBe("🚨");
    expect(copy.headline).toEndWith("DesignArena.");
    expect(copy.lines.length).toBeGreaterThan(2);
    expect(copy.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(copy.boldLineCount).toBe(2);
  });

  // A word wider than the line box used to be accepted whole, and SVG text does
  // not clip: the tail was drawn past the 1080px edge instead of being wrapped.
  it("breaks a word that is wider than one line instead of overflowing the card", () => {
    const copy = buildStoryCardCopy(`Ссылка ${"a".repeat(120)} внутри поста.`);
    expect(copy.lines.length).toBeGreaterThan(1);
    const fullWordSegments = copy.lines.filter((line) => /^a+$/u.test(line));
    expect(fullWordSegments).toHaveLength(6);
    for (const line of fullWordSegments) expect(line).toHaveLength(19);
  });

  // The renderer's schema and the copy rules must agree by construction: they were
  // two hand-kept literals, and raising one shipped a prod failure on the other.
  it("keeps every generated headline inside the renderer's accepted shape", () => {
    for (const text of ["Одно слово", "🔥 ".concat("длинное слово ".repeat(40)), "a".repeat(400)]) {
      const copy = buildStoryCardCopy(text);
      expect(copy.lines.length).toBeLessThanOrEqual(MAX_LINES);
      expect(copy.boldLineCount).toBeLessThanOrEqual(MAX_LINES);
      expect(copy.templateVersion).toBe(TEMPLATE_VERSION);
    }
  });

  it("names the Twemoji asset for an emoji whether or not it ships today", () => {
    expect(emojiAssetFile("🚨")).toBe("1f6a8.svg");
    expect(emojiAssetFile("⚡️")).toBe("26a1.svg");
    expect(emojiAssetFile("🔥")).toBe("1f525.svg");
    expect(emojiAssetFile(null)).toBeNull();
  });

  it("queues RU and EN automatically and renders both through the isolated process", async () => {
    backendDb = openStoryDb();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "story-card-test-"));
    temporaryDirectories.push(directory);
    const config = loadTestConfig({
      DATA_DIR: directory,
      STORY_CARD_DIR: directory,
      STORY_CARD_ASSETS_DIR: storyCardAssets,
      STORY_CARD_RENDERER_ENTRY: storyCardRenderer,
    });
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "⚡ ChatGPT достиг примерно миллиарда еженедельно активных пользователей.",
      textEn: "⚡ ChatGPT reached approximately one billion weekly active users.",
      entities: [],
      media: [],
    });

    expect(storyCardsForDraft(backendDb.db, draftId).map((card) => card.status)).toEqual(["queued", "queued"]);
    expect(await runStoryCardCycle(config, backendDb)).toBe(1);
    expect(await runStoryCardCycle(config, backendDb)).toBe(1);
    const media = readyStoryCardMedia(backendDb.db, draftId);
    expect(media?.ru.role).toBe("text_story_card");
    const metadata = await sharp(String(media?.ru.localPath)).metadata();
    expect(metadata).toMatchObject({ width: 1080, height: 1920, format: "jpeg" });
    // The probe follows the layout helpers rather than a copied constant: the
    // emoji is composited against the same baseline the copy is drawn on, so a
    // hard-coded box silently starts sampling background after a layout tweak.
    const box = {
      left: STORY_CARD_EMOJI_LEFT,
      top: storyCardEmojiTop(buildStoryCardCopy("⚡ ChatGPT достиг примерно миллиарда еженедельно активных пользователей.")),
      width: STORY_CARD_EMOJI_SIZE,
      height: STORY_CARD_EMOJI_SIZE,
    };
    const emojiStats = await sharp(String(media?.ru.localPath)).extract(box).stats();
    expect(emojiStats.channels[0]?.max).toBeGreaterThan(emojiStats.channels[1]?.max ?? 255);
  }, 20_000);

  it("asks about Stories only when a Story platform is on", () => {
    // The site takes the card either way, so a site-only Studio has nothing to
    // answer: the question exists to decide whether Stories get it too.
    expect(storyCardUse({ telegram: true, site_ru: true })).toEqual({ stories: false, site: true });
    expect(storyCardUse({ telegram: true, telegram_stories: true })).toEqual({ stories: true, site: false });
    expect(storyCardUse({ telegram: true, threads_ru: true })).toEqual({ stories: false, site: false });
  });

  it("renders a card only for a Studio that has somewhere to put it", () => {
    backendDb = openStoryDb();
    // Story platforms publish the card; a site page uses it as its own
    // illustration. A selection with neither -- Telegram and Threads, say, or a
    // Studio with no site at all -- has nothing to render it for, and used to
    // get two rendering jobs and a question about nobody.
    const withStories = createDraftFromMessage(backendDb, 42, {
      text: "Есть куда положить",
      textEn: "Somewhere to put it",
      entities: [],
      media: [],
    });
    expect(storyCardsForDraft(backendDb.db, withStories)).not.toHaveLength(0);

    const plainTargets = JSON.stringify({ telegram: true, threads_ru: true });
    const withoutStories = createDraftFromMessage(
      backendDb,
      42,
      { text: "Некуда", textEn: "Nowhere", entities: [], media: [] },
      { targetsJson: plainTargets },
    );
    expect(storyCardsForDraft(backendDb.db, withoutStories)).toHaveLength(0);
  });

  it("keeps generated cards out of ordinary targets and gates all Story targets with one decision", () => {
    const storyCards = {
      ru: { type: "IMAGE", localPath: "/cards/ru.jpg", storyLocalPath: "/cards/ru.jpg" },
      en: { type: "IMAGE", localPath: "/cards/en.jpg", storyLocalPath: "/cards/en.jpg" },
    };
    const draft = {
      text_ru: "Русский текст",
      text_en_machine: "English text",
      text_en_approved: null,
      targets_json: JSON.stringify({
        telegram: true,
        site_ru: true,
        site_en: true,
        telegram_stories: true,
        instagram_stories_ru: true,
        instagram_stories: true,
      }),
      media_ru_json: null,
      media_en_json: null,
      text_ru_entities_json: "[]",
      text_en_entities_json: "[]",
      story_publish_mode: "site_only",
    };
    const siteOnly = createPublicationPlan(
      draft as never,
      1,
      2,
      { mode: "immediate", ruAt: "2026-07-29T10:00:00.000Z", enAt: "2026-07-29T10:00:00.000Z" },
      "2026-07-29T10:00:00.000Z",
      undefined,
      storyCards,
    );
    expect(siteOnly.targets).toMatchObject({
      telegram: true,
      site_ru: true,
      site_en: true,
      telegram_stories: false,
      instagram_stories_ru: false,
      instagram_stories: false,
    });
    expect(siteOnly.locales[0]?.source.siteMedia).toEqual([storyCards.ru]);
    expect(localizeTargetPayload(siteOnly.payload, "telegram").media).toEqual([]);

    const withStories = createPublicationPlan(
      { ...draft, story_publish_mode: "all" } as never,
      1,
      2,
      { mode: "immediate", ruAt: "2026-07-29T10:00:00.000Z", enAt: "2026-07-29T10:00:00.000Z" },
      "2026-07-29T10:00:00.000Z",
      undefined,
      storyCards,
    );
    expect(withStories.targets.telegram_stories).toBe(true);

    const withoutCards = createPublicationPlan(
      { ...draft, story_publish_mode: "all" } as never,
      1,
      2,
      { mode: "scheduled", ruAt: "2026-07-29T10:00:00.000Z", enAt: "2026-07-29T10:00:00.000Z" },
      "2026-07-29T10:00:00.000Z",
    );
    expect(withoutCards.targets).toMatchObject({
      telegram: true,
      telegram_stories: false,
      instagram_stories_ru: false,
      instagram_stories: false,
    });

    // "Publish everywhere" narrows the editor's selection; it must not switch a
    // Story target back on that the editor had deliberately switched off.
    const disabled = createPublicationPlan(
      {
        ...draft,
        story_publish_mode: "all",
        targets_json: JSON.stringify({ ...JSON.parse(draft.targets_json), telegram_stories: false }),
      } as never,
      1,
      2,
      { mode: "immediate", ruAt: "2026-07-29T10:00:00.000Z", enAt: "2026-07-29T10:00:00.000Z" },
      "2026-07-29T10:00:00.000Z",
      undefined,
      storyCards,
    );
    expect(disabled.targets.telegram_stories).toBe(false);
    expect(disabled.targets.instagram_stories_ru).toBe(true);

    expect(localizeTargetPayload(withStories.payload, "telegram_stories").media).toEqual([
      expect.objectContaining({ localPath: "/cards/ru.jpg", storyLocalPath: "/cards/ru.jpg" }),
    ]);
  });

  it("replans a scheduled text post after edited Story cards are ready", async () => {
    backendDb = openStoryDb();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-story-edit-test-"));
    temporaryDirectories.push(directory);
    const config = loadTestConfig({
      CONTROLLER_ADMIN_IDS: "42",
      DATA_DIR: directory,
      STORY_CARD_DIR: directory,
      STORY_CARD_RENDERER_ENTRY: testStoryCardRenderer,
    });
    const posts = postService(backendDb, config);
    const draftId = posts.create(42, { text: "Before", textEn: "Before", entities: [], media: [] });
    await runStoryCardCycle(config, backendDb);
    await runStoryCardCycle(config, backendDb);
    posts.setStoryPublishMode(42, draftId, "all");
    const postId = posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 5 * 60_000), enAt: null });

    posts.edit(42, draftId, { locale: "ru", text: "After", entities: [], media: [] });
    expect(publicationSourceFromDb(backendDb.db, postId).locales.ru).toMatchObject({ text: "After" });
    expect(backendDb.db.select().from(drafts).where(eq(drafts.id, draftId)).get()?.storyPublishMode).toBe("all");

    await runStoryCardCycle(config, backendDb);
    await runStoryCardCycle(config, backendDb);
    expect(publicationSourceFromDb(backendDb.db, postId).locales.ru).toMatchObject({ text: "After" });
  }, 20_000);

  it("skips Story delivery and notifies the inbox after a card exhausts retries", async () => {
    backendDb = openStoryDb();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "failed-story-card-test-"));
    temporaryDirectories.push(directory);
    const config = loadTestConfig({
      CONTROLLER_ADMIN_IDS: "42",
      DATA_DIR: directory,
      STORY_CARD_DIR: directory,
      STORY_CARD_ASSETS_DIR: storyCardAssets,
      STORY_CARD_RENDERER_ENTRY: path.join(directory, "missing-renderer.ts"),
    });
    const posts = postService(backendDb, config);
    const draftId = posts.create(42, { text: "Text", textEn: "Text", entities: [], media: [] });
    setStoryPublishMode(backendDb.db, draftId, "all");
    const postId = posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 60_000), enAt: null });

    // Every attempt fails on a renderer that is not there; the card is only
    // given up once the retry budget itself is spent.
    for (let attempt = 0; attempt < STORY_CARD_MAX_ATTEMPTS; attempt += 1) {
      expect(await runStoryCardCycle(config, backendDb)).toBe(1);
      // Each failure parks the card behind its retry backoff; the test is about
      // the budget running out, not about waiting for the clock.
      backendDb.db.update(draftStoryCards).set({ nextAttemptAt: null }).where(eq(draftStoryCards.draftId, draftId)).run();
    }

    expect(backendDb.db.select().from(draftStoryCards).where(eq(draftStoryCards.draftId, draftId)).get()?.status).toBe("failed");
    expect(
      backendDb.db
        .select()
        .from(publishJobs)
        .where(eq(publishJobs.publicationKey, `post:${postId}`))
        .all()
        .some((job) => job.target.includes("stories")),
    ).toBe(false);
    expect(
      backendDb.db.select().from(publicationEvents).where(eq(publicationEvents.eventType, "studio.notification.story-cards.failed")).all(),
    ).toHaveLength(1);
  }, 20_000);

  it("stores the final bundle decision durably", () => {
    backendDb = openStoryDb();
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Text", textEn: "Text", entities: [], media: [] });
    setStoryPublishMode(backendDb.db, draftId, "all");
    expect(backendDb.db.select().from(drafts).where(eq(drafts.id, draftId)).get()?.storyPublishMode).toBe("all");
  });

  it("backfills a published site's empty media without requeueing social delivery", async () => {
    backendDb = openStoryDb();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "story-card-backfill-test-"));
    temporaryDirectories.push(directory);
    const config = loadTestConfig({
      DATA_DIR: directory,
      STORY_CARD_DIR: directory,
      STORY_CARD_ASSETS_DIR: storyCardAssets,
      STORY_CARD_RENDERER_ENTRY: testStoryCardRenderer,
    });
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "🚨 СЛИВ: Две модели OpenAI появились в DesignArena.",
      textEn: "🚨 LEAK: Two OpenAI models appeared in DesignArena.",
      entities: [],
      media: [],
    });
    discardDraftStoryCards(backendDb.db, draftId);
    const postId = publishDraftToQueue(backendDb, draftId);
    const socialJobsBefore = backendDb.db.select().from(publishJobs).all().length;

    const dryRun = await backfillTextStoryCards(backendDb, config, `post:${postId}`, false);
    expect(dryRun).toMatchObject({ applied: false, count: 2 });
    expect(storyCardsForDraft(backendDb.db, draftId)).toHaveLength(0);

    const applied = await backfillTextStoryCards(backendDb, config, `post:${postId}`, true);
    expect(applied).toMatchObject({ applied: true, count: 2 });
    expect(backendDb.db.select().from(postLocales).where(eq(postLocales.draftId, draftId)).all()).toSatisfy((locales) =>
      locales.every((locale) => Array.isArray(locale.siteMediaJson) && locale.siteMediaJson.length === 1),
    );
    expect(backendDb.db.select().from(publishJobs).all()).toHaveLength(socialJobsBefore);
    expect(
      backendDb.db
        .select()
        .from(siteJobs)
        .where(eq(siteJobs.publicationKey, `post:${postId}`))
        .all()
        .at(-1)?.reason,
    ).toBe("text_story_card_backfill");

    const forced = await backfillTextStoryCards(backendDb, config, `post:${postId}`, false, true);
    expect(forced).toMatchObject({ applied: false, count: 2, force: true });
  }, 20_000);
});
