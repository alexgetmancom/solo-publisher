import { describe, expect, it, mock } from "bun:test";
import type { Bot } from "grammy";
import { refreshPostControlCard } from "../src/bot/progress.js";
import { alertDedup, botUiSettings, publishJobs, siteJobs, videoDrafts, videoTargets } from "../src/db/schema.js";
import { setTelegramPostCard, setTelegramPostProgressCard, setTelegramVideoCard } from "../src/interfaces/telegram/control-cards.js";
import { consumeTelegramEvents } from "../src/interfaces/telegram/event-consumer.js";
import { refreshVideoControlCard, sendStudioCompletion, sendStudioReminder } from "../src/interfaces/telegram/video-notifications.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig, MSK_STUDIO_PROFILE } from "./helpers/studio-config.js";
import { createTestVideoAsset } from "./helpers/video.js";

const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }, MSK_STUDIO_PROFILE);

function milestone(message: string) {
  return { type: "analytics.milestone.reached", severity: "info" as const, message };
}

describe("Telegram event consumer", () => {
  it("does not overwrite a draft card while no progress card is bound", async () =>
    withDb(async (backendDb) => {
      const draftId = 11;
      const now = new Date().toISOString();
      seedTextPost(backendDb, { draftId, actorId: 42, status: "scheduled", ru: "Scheduled post", targets: { threads_en: true }, now });
      setTelegramPostCard(backendDb, draftId, 42, 100);
      const editMessageText = mock(async () => undefined);
      const bot = { api: { editMessageText } } as unknown as Bot;

      await refreshPostControlCard(backendDb, bot, draftId);

      expect(editMessageText).not.toHaveBeenCalled();
    }));

  it("refreshes the explicitly bound progress card", async () =>
    withDb(async (backendDb) => {
      const draftId = 12;
      const now = new Date().toISOString();
      seedTextPost(backendDb, { draftId, actorId: 42, status: "scheduled", ru: "Scheduled post", targets: { threads_en: true }, now });
      setTelegramPostProgressCard(backendDb, draftId, 42, 101);
      const editMessageText = mock(async (_chatId: number, _messageId: number, text: string) => text);
      const bot = { api: { editMessageText } } as unknown as Bot;

      await refreshPostControlCard(backendDb, bot, draftId);

      expect(editMessageText).toHaveBeenCalledTimes(1);
      expect(editMessageText.mock.calls[0]?.[2]).toContain("Post #12");
    }));

  it("refreshes a video card in its owner's stored UI locale", async () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db.insert(botUiSettings).values({ actorId: 42, locale: "en", updatedAt: now }).run();
      backendDb.db
        .insert(videoDrafts)
        .values({
          id: 11,
          actorId: 42,
          locale: "en",
          label: "Shared launch",
          studioMediaAssetId: createTestVideoAsset(backendDb, 42),
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(videoTargets)
        .values({ videoDraftId: 11, target: "youtube_shorts", metadataJson: {}, status: "draft", createdAt: now, updatedAt: now })
        .run();
      setTelegramVideoCard(backendDb, 11, 42, 100);
      const edits: string[] = [];
      const editMessageText = mock(async (_chatId: number, _messageId: number, text: string) => void edits.push(text));
      const bot = { api: { editMessageText } } as unknown as Bot;

      await refreshVideoControlCard(backendDb, bot, { TIMEZONE: "UTC", TIMEZONE_LABEL: "UTC" }, 11);

      expect(edits[0]).toContain("Status:");
      expect(edits[0]).not.toContain("Статус:");
    }));

  it("drops an undeliverable event instead of blocking every event behind it", async () =>
    withDb(async (backendDb) => {
      backendDb.events.record(milestone("first"));
      backendDb.events.record(milestone("second"));
      // Telegram's real failure here is a 403 from a user who blocked the bot:
      // permanent, chat-specific, and no reason to stall the whole queue.
      const sendMessage = mock(async (_chatId: number, text: string) => {
        if (text === "first") throw new Error("Forbidden: bot was blocked by the user");
        return { message_id: 1, date: 1, chat: { id: 42, type: "private" as const } };
      });
      const bot = { api: { sendMessage } } as unknown as Bot;

      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(1);
      expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual(["first", "second"]);

      // Both are marked delivered: the failed one is not retried on the next tick.
      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(0);
      expect(sendMessage).toHaveBeenCalledTimes(2);
    }));

  it("delivers each event exactly once across repeated ticks", async () =>
    withDb(async (backendDb) => {
      backendDb.events.record(milestone("only"));
      const sendMessage = mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
      const bot = { api: { sendMessage } } as unknown as Bot;

      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(1);
      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(0);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    }));

  it("durably reserves an event before calling Telegram", async () =>
    withDb(async (backendDb) => {
      backendDb.events.record(milestone("reserved"));
      const sendMessage = mock(async () => {
        expect(backendDb.db.select().from(alertDedup).all()).toHaveLength(1);
        return { message_id: 1, date: 1, chat: { id: 42, type: "private" as const } };
      });
      const bot = { api: { sendMessage } } as unknown as Bot;

      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(1);
    }));

  it("fans one aggregated video reminder and detailed completion out to every admin", async () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(videoDrafts)
        .values({
          id: 10,
          actorId: 42,
          locale: "en",
          label: "Shared launch",
          studioMediaAssetId: createTestVideoAsset(backendDb, 42),
          status: "published",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(videoTargets)
        .values([
          { videoDraftId: 10, target: "youtube_shorts", metadataJson: {}, status: "published", createdAt: now, updatedAt: now },
          { videoDraftId: 10, target: "instagram_reels", metadataJson: {}, status: "published", createdAt: now, updatedAt: now },
        ])
        .run();
      const sendMessage = mock(async (chatId: number, text: string, options: unknown) => ({
        message_id: 1,
        date: 1,
        chat: { id: chatId, type: "private" as const },
        text,
        options,
      }));
      const bot = { api: { sendMessage } } as unknown as Bot;
      const sharedConfig = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42,7" }, MSK_STUDIO_PROFILE);

      await sendStudioReminder(backendDb, bot, sharedConfig, {
        publicationKey: "video:10",
        detailsJson: {
          actor_id: 42,
          title: "Shared launch",
          targets: ["youtube_shorts", "instagram_reels"],
          minutes: 5,
          publish_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      });
      await sendStudioCompletion(backendDb, bot, sharedConfig, {
        publicationKey: "video:10",
        detailsJson: { total: 2, published: 2, failed: 0 },
      });

      expect(sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([42, 7, 42, 7]);
      for (const call of sendMessage.mock.calls.slice(0, 2)) {
        expect(call[1]).toContain("YouTube Shorts");
        expect(call[1]).toContain("Instagram Reels");
        expect(call[1]).toContain("🇬🇧 EN");
      }
      for (const call of sendMessage.mock.calls.slice(2)) {
        expect(call[1]).toContain("✅ YouTube Shorts");
        expect(call[1]).toContain("✅ Instagram Reels");
      }
    }));

  it("reports an ambiguous video outcome without offering a duplicate-producing retry", async () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(videoDrafts)
        .values({
          id: 11,
          actorId: 42,
          locale: "ru",
          label: "Ambiguous launch",
          studioMediaAssetId: createTestVideoAsset(backendDb, 42),
          status: "partial",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(videoTargets)
        .values({
          videoDraftId: 11,
          target: "instagram_reels",
          metadataJson: {},
          status: "verification_required",
          lastError: "Provider response was ambiguous",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const sendMessage = mock(async (_chatId: number, text: string, options: unknown) => ({
        message_id: 1,
        date: 1,
        chat: { id: 42, type: "private" as const },
        text,
        options,
      }));
      const bot = { api: { sendMessage } } as unknown as Bot;

      await sendStudioCompletion(backendDb, bot, config, {
        publicationKey: "video:11",
        detailsJson: { total: 1, published: 0, failed: 1 },
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[1]).toContain("Provider response was ambiguous");
      expect(JSON.stringify(sendMessage.mock.calls[0]?.[2] ?? {})).not.toContain("p:video:retry:11");
    }));

  it("notifies about a completed locale and shows the later locale schedule", async () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const later = "2026-08-06T07:00:00.000Z";
      seedTextPost(backendDb, {
        draftId: 13,
        postId: 113,
        actorId: 42,
        status: "scheduled",
        ru: "RU",
        en: "EN",
        targets: { telegram: true, site_ru: true, threads_en: true, site_en: true },
        scheduledAt: later,
        scheduledEnAt: now,
        now,
      });
      backendDb.db
        .insert(publishJobs)
        .values([
          {
            publicationKey: "post:113",
            target: "threads_en",
            status: "published",
            createdAt: now,
            updatedAt: now,
          },
          {
            publicationKey: "post:113",
            target: "telegram",
            status: "queued",
            publishAt: later,
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run();
      backendDb.db
        .insert(siteJobs)
        .values([
          { publicationKey: "post:113", reason: "site_en", status: "published", createdAt: now, updatedAt: now },
          {
            publicationKey: "post:113",
            reason: "site_ru",
            status: "queued",
            nextAttemptAt: later,
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run();
      backendDb.events.record({
        ref: "post:113",
        target: "en",
        type: "delivery.post.locale.completed",
        severity: "info",
        message: "Post #113 EN publication part completed",
        details: {
          post_id: 113,
          locale: "en",
          total: 2,
          published: 2,
          failed: 0,
          remaining: [{ locale: "ru", scheduled_at: later }],
        },
      });
      const sendMessage = mock(async (chatId: number, text: string, options: unknown) => ({
        message_id: 1,
        date: 1,
        chat: { id: chatId, type: "private" as const },
        text,
        options,
      }));
      const bot = { api: { sendMessage } } as unknown as Bot;

      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[1]).toContain("🇬🇧 EN part of Post published");
      expect(sendMessage.mock.calls[0]?.[1]).toContain("Threads EN");
      expect(sendMessage.mock.calls[0]?.[1]).toContain("Site EN");
      expect(sendMessage.mock.calls[0]?.[1]).toContain("🇷🇺 RU");
      expect(sendMessage.mock.calls[0]?.[1]).toContain("10:00 MSK");
      expect(JSON.stringify(sendMessage.mock.calls[0]?.[2])).toContain("p:post:view:13:overview");
      expect(JSON.stringify(sendMessage.mock.calls[0]?.[2])).not.toContain("retry:13:all:notice");
    }));

  it("sends one actionable aggregate for a failed post and does not replay it", async () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 11,
        postId: 110,
        actorId: 42,
        status: "failed",
        ru: "Failed post",
        targets: { telegram_ru: true, site_en: true },
        now,
      });
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:110",
          target: "telegram_ru",
          status: "failed",
          lastError: "Telegram timed out",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(siteJobs)
        .values({
          publicationKey: "post:110",
          reason: "site_en",
          status: "published",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.events.record({
        ref: "post:110",
        type: "delivery.post.completed",
        severity: "info",
        message: "Post #110 completed with 1 failed target(s)",
        details: { post_id: 110, total: 2, published: 1, failed: 1 },
      });
      const sendMessage = mock(async (chatId: number, text: string, options: unknown) => ({
        message_id: 1,
        date: 1,
        chat: { id: chatId, type: "private" as const },
        text,
        options,
      }));
      const bot = { api: { sendMessage } } as unknown as Bot;

      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[1]).toContain("Telegram");
      expect(sendMessage.mock.calls[0]?.[1]).toContain("Telegram timed out");
      expect(JSON.stringify(sendMessage.mock.calls[0]?.[2])).toContain("p:post:retry:11:all:notice");
      expect(JSON.stringify(sendMessage.mock.calls[0]?.[2])).toContain("p:post:view:11:overview");
      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(0);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    }));
});
