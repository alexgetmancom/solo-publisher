import { describe, expect, it, setSystemTime } from "bun:test";
import type { Context } from "grammy";
import { queueScreen, showQueue } from "../src/bot/queue.js";
import { draftStoryCards, publicationTargets, publishJobs, videoDrafts, videoTargets } from "../src/db/schema.js";
import type { StudioQueueSnapshot } from "../src/studio/services/queue.js";
import { queueService } from "../src/studio/services/queue.js";
import { registerTestChannels } from "./helpers/channels.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoAsset } from "./helpers/video.js";

describe("Telegram work queue", () => {
  it("keeps a scheduled publication whose time has passed, marked as overdue", () =>
    withDb(async (backendDb) => {
      registerTestChannels(backendDb, ["telegram"]);
      const past = new Date(Date.now() - 60 * 60_000).toISOString();
      seedTextPost(backendDb, {
        draftId: 11,
        actorId: 7,
        status: "scheduled",
        targets: { telegram: true },
        ru: "Nobody sent this",
        scheduledAt: past,
      });

      // Filtering the queue to future times made a publication that never went
      // out disappear from every screen there is.
      const snapshot = queueService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "7" })).snapshot(7);
      expect(snapshot.upcoming).toMatchObject([{ id: 11, kind: "post", overdue: true }]);
      expect(JSON.stringify(queueScreen(snapshot, "en", "UTC"))).toContain("Nobody sent this");
    }));

  it("finds the latest successful publication across posts and videos", () =>
    withDb(async (backendDb) => {
      const postPublishedAt = "2026-08-12T12:00:00.000Z";
      const videoPublishedAt = "2026-08-11T12:00:00.000Z";
      seedTextPost(backendDb, {
        postId: 10,
        actorId: 7,
        ru: "Published post\nTogether with a body that must stay out of the menu",
        now: postPublishedAt,
      });
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:10",
          target: "telegram",
          status: "published",
          publishedAt: postPublishedAt,
          updatedAt: postPublishedAt,
        })
        .run();
      const video = backendDb.db
        .insert(videoDrafts)
        .values({
          actorId: 7,
          studioMediaAssetId: createTestVideoAsset(backendDb, 7),
          label: "Published video",
          status: "published",
          createdAt: videoPublishedAt,
          updatedAt: videoPublishedAt,
        })
        .returning({ id: videoDrafts.id })
        .get();
      if (!video) throw new Error("video draft missing");
      backendDb.db
        .insert(videoTargets)
        .values({
          videoDraftId: video.id,
          target: "youtube_shorts",
          metadataJson: {},
          status: "published",
          publishedAt: videoPublishedAt,
          createdAt: videoPublishedAt,
          updatedAt: videoPublishedAt,
        })
        .run();

      expect(queueService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "7" })).headline(7).published).toEqual({
        id: 10,
        label: "Published post",
        kind: "post",
        time: new Date(postPublishedAt),
      });
    }));

  it("separates upcoming work, unfinished drafts and actual failed targets", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
      seedTextPost(backendDb, {
        draftId: 1,
        postId: 101,
        actorId: 7,
        status: "scheduled",
        ru: "Запланированный пост",
        targets: { telegram_ru: true, telegram_en: true },
        scheduledAt,
        now,
      });
      seedTextPost(backendDb, { draftId: 2, actorId: 7, status: "needs_review", ru: "Черновик поста", now });
      seedTextPost(backendDb, { draftId: 3, actorId: 8, status: "needs_review", ru: "Чужой черновик", now });
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:101",
          target: "telegram_ru",
          status: "failed",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(draftStoryCards)
        .values({
          draftId: 1,
          locale: "ru",
          sourceHash: "failed-card",
          headline: "Failed card",
          status: "failed",
          templateVersion: "test",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const video = backendDb.db
        .insert(videoDrafts)
        .values({
          actorId: 7,
          studioMediaAssetId: createTestVideoAsset(backendDb, 7),
          label: "Черновик видео",
          status: "editing",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: videoDrafts.id })
        .get();
      if (!video) throw new Error("video draft missing");
      backendDb.db
        .insert(videoTargets)
        .values({ videoDraftId: video.id, target: "youtube_shorts", metadataJson: {}, status: "draft", createdAt: now, updatedAt: now })
        .run();

      const snapshot = queueService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "7,8" })).snapshot(7);
      expect(snapshot.upcoming).toHaveLength(1);
      expect(snapshot.upcoming[0]?.label).toBe("Запланированный пост");
      expect(snapshot.drafts.map((item) => item.label)).toEqual(["Чужой черновик", "Черновик поста", "Черновик видео"]);
      expect(snapshot.attention).toEqual([{ id: 1, label: "Запланированный пост", kind: "post", time: new Date(now) }]);
    }));

  it("keeps recent scheduled videos visible after the queue history exceeds its cap", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(videoDrafts)
        .values(
          Array.from({ length: 100 }, (_, index) => ({
            actorId: 7,
            studioMediaAssetId: createTestVideoAsset(backendDb, 7),
            label: `Published video ${index}`,
            status: "published",
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
      const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const scheduled = backendDb.db
        .insert(videoDrafts)
        .values({
          actorId: 7,
          studioMediaAssetId: createTestVideoAsset(backendDb, 7),
          label: "Recent scheduled video",
          status: "scheduled",
          scheduledAt,
          createdAt: now,
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        })
        .returning({ id: videoDrafts.id })
        .get();
      if (!scheduled) throw new Error("scheduled video missing");
      backendDb.db
        .insert(videoTargets)
        .values({
          videoDraftId: scheduled.id,
          target: "youtube_shorts",
          metadataJson: {},
          status: "scheduled",
          scheduledAt,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const snapshot = queueService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "7" })).snapshot(7);
      expect(snapshot.upcoming).toEqual([
        expect.objectContaining({ id: scheduled.id, label: "Recent scheduled video", kind: "video", targets: 1 }),
      ]);
    }));

  it("keeps a partially scheduled post actionable instead of showing a past time as upcoming", () =>
    withDb(async (backendDb) => {
      registerTestChannels(backendDb, ["telegram", "threads_en"]);
      const now = new Date().toISOString();
      const ruAt = new Date(Date.now() + 60 * 60_000).toISOString();
      seedTextPost(backendDb, {
        postId: 201,
        actorId: 7,
        status: "scheduled",
        ru: "RU already handled",
        targets: { telegram: true, threads_en: true },
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        now,
      });
      seedTextPost(backendDb, {
        postId: 202,
        actorId: 7,
        status: "scheduled",
        ru: "RU then EN",
        targets: { telegram: true, threads_en: true },
        scheduledAt: ruAt,
        now,
      });

      const snapshot = queueService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "7" })).snapshot(7);
      expect(snapshot.upcoming).toHaveLength(0);
      expect(snapshot.drafts.map((item) => item.label)).toEqual(["⏳ RU then EN", "⏳ RU already handled"]);
    }));

  it("does not park a draft on a language this Studio publishes nothing in", () =>
    withDb(async (backendDb) => {
      // Maru connected Telegram and Threads RU only. A draft left over from when
      // an EN target was enabled must still go out on its RU date: waiting for an
      // EN time nobody can give held two posts in the queue indefinitely.
      registerTestChannels(backendDb, ["telegram", "threads_ru"]);
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        postId: 203,
        actorId: 7,
        status: "scheduled",
        ru: "RU only Studio",
        targets: { telegram: true, threads_ru: true, instagram_stories: true },
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        now,
      });

      const snapshot = queueService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "7" })).snapshot(7);
      expect(snapshot.drafts).toHaveLength(0);
      expect(snapshot.upcoming.map((item) => ({ label: item.label, targets: item.targets }))).toEqual([
        { label: "RU only Studio", targets: 2 },
      ]);
    }));

  it("keeps queue item details in buttons instead of duplicating them in the message", () => {
    const snapshot: StudioQueueSnapshot = {
      upcoming: [
        {
          id: 187,
          label: "Scheduled clip",
          time: new Date("2026-08-04T22:02:00.000Z"),
          kind: "video",
          targets: 2,
        },
      ],
      drafts: [{ id: 188, label: "Unfinished clip", time: new Date("2026-08-03T20:35:00.000Z"), kind: "video", targets: 0 }],
      attention: [],
    };

    const { text } = queueScreen(snapshot, "ru", "Europe/Moscow");
    expect(text).toBe("📋 *Очередь*");
    expect(text).not.toContain("Scheduled clip");
    expect(text).not.toContain("Unfinished clip");
  });

  it("renders failed work as an actionable attention section", () => {
    const snapshot: StudioQueueSnapshot = {
      upcoming: [],
      drafts: [],
      attention: [{ id: 12, label: "Failed clip", kind: "video", time: new Date() }],
    };

    const { text } = queueScreen(snapshot, "ru", "Europe/Moscow");
    expect(text).toBe("📋 *Очередь*");
    expect(text).not.toContain("Failed clip");
  });

  it("keeps a queue label well-formed when truncation reaches an emoji", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, { draftId: 301, actorId: 7, status: "needs_review", ru: `${"x".repeat(37)}😀 after the limit`, now });

      const label = queueService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "7" })).snapshot(7).drafts[0]?.label;
      expect(label).toBe(`${"x".repeat(37)}😀`);
      expect(label).not.toMatch(/[\uD800-\uDFFF]/u);
    }));

  it("keeps the inline queue button well-formed after label truncation", () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const draft = backendDb.db
        .insert(videoDrafts)
        .values({
          actorId: 7,
          studioMediaAssetId: createTestVideoAsset(backendDb, 7),
          label: `${"x".repeat(29)}${"😀".repeat(9)}`,
          status: "scheduled",
          scheduledAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: videoDrafts.id })
        .get();
      if (!draft) throw new Error("video draft missing");
      backendDb.db
        .insert(videoTargets)
        .values({
          videoDraftId: draft.id,
          target: "youtube_shorts",
          metadataJson: {},
          status: "scheduled",
          scheduledAt,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      let options: { reply_markup?: { inline_keyboard?: Array<Array<{ text: string }>> } } | undefined;
      const ctx = {
        from: { id: 7 },
        chat: { id: 100 },
        callbackQuery: { message: { message_id: 9 } },
        api: {
          editMessageText: async (_chatId: number, _messageId: number, _text: string, nextOptions: typeof options) => {
            options = nextOptions;
          },
        },
      } as unknown as Context;

      await showQueue(ctx, backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "7" }));
      const buttonText = options?.reply_markup?.inline_keyboard?.[0]?.[0]?.text;
      expect(buttonText).toBeTruthy();
      encodeURIComponent(buttonText ?? "");
    }));

  it("paginates every queue section without dropping items", () => {
    // Upcoming items are paged by the day they fall on, so eleven of them a
    // minute apart split differently when "now" is a minute before midnight in
    // Moscow — this failed for a few minutes each night and passed by morning.
    setSystemTime(new Date("2026-08-14T09:00:00.000Z"));
    const snapshot: StudioQueueSnapshot = {
      upcoming: Array.from({ length: 11 }, (_, index) => ({
        id: index + 1,
        label: `Upcoming ${index + 1}`,
        kind: "post",
        targets: 1,
        time: new Date(Date.now() + (index + 1) * 60_000),
      })),
      attention: [],
      drafts: [],
    };

    expect(queueScreen(snapshot, "en", "Europe/Moscow").pages).toBe(2);
    expect(queueScreen(snapshot, "en", "Europe/Moscow", 1)).toMatchObject({
      text: "📋 *Work queue*",
      currentPage: 1,
      items: { upcoming: [{ label: "Upcoming 11" }] },
    });
    setSystemTime();
  });
});
