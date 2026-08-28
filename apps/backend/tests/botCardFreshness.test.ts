import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import { handlePublicationCallback, isStaleCardCallback } from "../src/bot/callback-router.js";
import { executePublicationEffects } from "../src/bot/effects.js";
import { draftPreview } from "../src/bot/preview.js";
import { type PublicationCallback, parseSessionCallback, publicationCallback, versionedCallback } from "../src/bot/publication-callback.js";
import { getVideoState, videoControlEffects } from "../src/bot/video-ui.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import type { BackendDb, UnsafeBackendDb } from "../src/db/client.js";
import { draftStoryCards, videoDrafts } from "../src/db/schema.js";
import { unsafeDb } from "../src/db/unsafe.js";
import {
  setTelegramPostCard,
  setTelegramVideoCard,
  telegramPostCard,
  telegramVideoCard,
} from "../src/interfaces/telegram/control-cards.js";
import { replaceVideoTargets } from "../src/publishing/video-service.js";
import { registerTestChannels } from "./helpers/channels.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoAsset, createTestVideoDraft } from "./helpers/video.js";

function callbackContext(messageId: number): Context {
  return { callbackQuery: { message: { message_id: messageId } } } as unknown as Context;
}

function postAction(action: string, args: readonly (string | number)[] = []): string {
  return publicationCallback("post", action, args);
}

function videoAction(action: string, args: readonly (string | number)[] = []): string {
  return publicationCallback("video", action, args);
}

function parsed(value: string): PublicationCallback {
  const callback = parseSessionCallback(value).callback;
  if (!callback) throw new Error(`Expected publication callback: ${value}`);
  return callback;
}

function postPublication(action: string, args: readonly (string | number)[] = []): PublicationCallback {
  return parsed(postAction(action, args));
}

function videoPublication(action: string, args: readonly (string | number)[] = []): PublicationCallback {
  return parsed(videoAction(action, args));
}

describe("Telegram card freshness", () => {
  it("rejects a mutation from a replaced post card but allows the current one", () =>
    withDb(async (backendDb: BackendDb) => {
      setTelegramPostCard(backendDb, 7, 100, 20);
      expect(isStaleCardCallback(callbackContext(19), backendDb, postPublication("publish", [7]))).toBe(true);
      expect(isStaleCardCallback(callbackContext(20), backendDb, postPublication("publish", [7]))).toBe(false);
      expect(isStaleCardCallback(callbackContext(19), backendDb, postPublication("publish", [7]))).toBe(true);
      expect(isStaleCardCallback(callbackContext(19), backendDb, postPublication("view", [7, "overview"]))).toBe(false);
      expect(isStaleCardCallback(callbackContext(19), backendDb, postPublication("threads_chain", [7]))).toBe(true);
      expect(isStaleCardCallback(callbackContext(20), backendDb, postPublication("threads_chain", [7]))).toBe(false);
      expect(isStaleCardCallback(callbackContext(19), backendDb, postPublication("story_schedule_all", [7]))).toBe(true);
      expect(isStaleCardCallback(callbackContext(20), backendDb, postPublication("story_schedule_all", [7]))).toBe(false);
    }));

  it("tracks the publish confirmation card after delivery previews", () =>
    withDb(async (backendDb: BackendDb) => {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
      const draftId = createDraftFromMessage(backendDb, 42, {
        text: "Video post",
        textEn: "Video post",
        entities: [],
        media: [{ type: "video", file_id: "video-1" }],
      });
      setTelegramPostCard(backendDb, draftId, 100, 10);
      let nextMessageId = 10;
      const context = (data: string, messageId: number): Context =>
        ({
          from: { id: 42 },
          chat: { id: 100 },
          callbackQuery: { data, message: { message_id: messageId } },
          answerCallbackQuery: async () => true,
          reply: async () => ({ message_id: ++nextMessageId }),
          replyWithVideo: async () => ({ message_id: ++nextMessageId }),
        }) as unknown as Context;

      await handlePublicationCallback(context(postAction("publish", [draftId]), 10), backendDb, config);

      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 15 });
      expect(
        isStaleCardCallback(
          context(postAction("publish_confirm", [draftId]), 15),
          backendDb,
          postPublication("publish_confirm", [draftId]),
        ),
      ).toBe(false);
    }));

  it("tracks the message that now renders an inline post screen", () =>
    withDb(async (backendDb: BackendDb) => {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Card", textEn: "Card", entities: [], media: [] });
      const ctx = {
        from: { id: 42 },
        chat: { id: 100 },
        callbackQuery: { message: { message_id: 20 } },
        answerCallbackQuery: async () => true,
        editMessageText: async () => undefined,
      } as unknown as Context;

      const preview = draftPreview(backendDb, draftId, loadTestConfig({}), "en", "schedule");
      await executePublicationEffects(ctx, backendDb, [
        {
          type: "screen",
          mode: "edit",
          text: preview.text,
          options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
          card: { kind: "post", draftId },
        },
      ]);

      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 20 });
    }));

  it("tracks a new manual schedule confirmation message", () =>
    withDb(async (backendDb: BackendDb) => {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Card", textEn: "Card", entities: [], media: [] });
      const ctx = {
        from: { id: 42 },
        chat: { id: 100 },
        reply: async () => ({ message_id: 21 }),
      } as unknown as Context;

      const preview = draftPreview(backendDb, draftId, loadTestConfig({}), "en");
      await executePublicationEffects(ctx, backendDb, [
        {
          type: "prompt",
          text: preview.text,
          options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
          card: { kind: "post", draftId },
        },
      ]);

      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 21 });
    }));

  it("keeps the Story scheduling flow on the message that renders its next screen", () =>
    withDb(async (backendDb: BackendDb) => {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
      registerTestChannels(backendDb as UnsafeBackendDb, ["telegram_stories", "instagram_stories"]);
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Card", textEn: "Card", entities: [], media: [] });
      for (const locale of ["ru", "en"] as const) {
        unsafeDb(backendDb)
          .db.update(draftStoryCards)
          .set({ status: "ready", localPath: `/tmp/draft-${draftId}-${locale}.jpg` })
          .where(and(eq(draftStoryCards.draftId, draftId), eq(draftStoryCards.locale, locale)))
          .run();
      }
      setTelegramPostCard(backendDb, draftId, 100, 10);

      const context = (data: string, messageId: number): Context =>
        ({
          from: { id: 42 },
          chat: { id: 100 },
          callbackQuery: { data, message: { message_id: messageId } },
          answerCallbackQuery: async () => true,
          editMessageText: async () => undefined,
          reply: async () => ({ message_id: 11 }),
          replyWithPhoto: async () => ({ message_id: 12 }),
        }) as unknown as Context;

      await handlePublicationCallback(context(postAction("schedule", [draftId]), 10), backendDb, config);
      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 11 });

      await handlePublicationCallback(context(postAction("story_schedule_all", [draftId]), 11), backendDb, config);
      await handlePublicationCallback(context(postAction("sched_scope", [draftId, "both"]), 11), backendDb, config);
      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 11 });

      await handlePublicationCallback(context(postAction("sched_pick", [draftId, "ru", "0800"]), 11), backendDb, config);
      await handlePublicationCallback(context(postAction("sched_pick", [draftId, "en", "1800"]), 11), backendDb, config);
      expect(JSON.stringify(draftPreview(backendDb, draftId, config, "en"))).toContain(`edit_ru:${draftId}`);
    }));

  it("rejects a mutation from a replaced video card", () =>
    withDb(async (backendDb: BackendDb) => {
      setTelegramVideoCard(backendDb, 7, 100, 20);
      expect(isStaleCardCallback(callbackContext(19), backendDb, videoPublication("schedule", [7]))).toBe(true);
      expect(isStaleCardCallback(callbackContext(19), backendDb, videoPublication("sched_pick", [7, "youtube_shorts", "2100"]))).toBe(true);
      expect(isStaleCardCallback(callbackContext(20), backendDb, videoPublication("schedule", [7]))).toBe(false);
      // Retry callbacks are also emitted by failure notifications, which are
      // separate messages from the current card. The service validates the
      // target state, so this action does not need card freshness protection.
      expect(isStaleCardCallback(callbackContext(19), backendDb, videoPublication("retry", [7, "youtube_shorts", "notice"]))).toBe(false);
      expect(isStaleCardCallback(callbackContext(19), backendDb, videoPublication("cancel_confirm", [7]))).toBe(false);
      expect(isStaleCardCallback(callbackContext(19), backendDb, videoPublication("view", [7, "overview"]))).toBe(false);
    }));

  it("rebases the durable video card when a scheduling prompt becomes a new message", () =>
    withDb(async (backendDb: BackendDb) => {
      const now = new Date().toISOString();
      const draftId = unsafeDb(backendDb)
        .db.insert(videoDrafts)
        .values({
          actorId: 42,
          locale: "ru",
          studioMediaAssetId: createTestVideoAsset(backendDb, 42),
          status: "editing",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: videoDrafts.id })
        .get()?.id;
      if (!draftId) throw new Error("video draft missing");
      const ctx = {
        chat: { id: 100 },
        reply: async () => ({ message_id: 21 }),
      } as unknown as Context;

      await executePublicationEffects(
        ctx,
        backendDb,
        videoControlEffects(
          { kind: "video", draftId, step: "schedule_common", selected: ["youtube_shorts"], data: {}, controlMessageId: null, revision: 0 },
          "When?",
          new InlineKeyboard(),
        ),
      );

      expect(telegramVideoCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 21 });
    }));

  it("keeps a two-platform video schedule on the latest Telegram control message", () =>
    withDb(async (backendDb: BackendDb) => {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
      const draftId = createTestVideoDraft(backendDb, 42, "clip.mp4", 24);
      replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
      setTelegramVideoCard(backendDb, draftId, 100, 10);
      let nextMessageId = 20;
      const context = (data: string, messageId: number): Context =>
        ({
          from: { id: 42 },
          chat: { id: 100 },
          callbackQuery: { data, message: { message_id: messageId } },
          answerCallbackQuery: async () => true,
          editMessageText: async () => undefined,
          reply: async () => ({ message_id: ++nextMessageId }),
          replyWithVideo: async () => ({ message_id: ++nextMessageId }),
          api: { editMessageText: async () => undefined },
        }) as unknown as Context;

      await handlePublicationCallback(context(videoAction("schedule", [draftId]), 10), backendDb, config);
      const choice = getVideoState(backendDb, 42);
      if (!choice) throw new Error("video schedule session missing");
      await handlePublicationCallback(context(versionedCallback(videoAction("common", [draftId]), choice.revision), 10), backendDb, config);
      const timePrompt = getVideoState(backendDb, 42);
      if (!timePrompt) throw new Error("video time session missing");
      expect(telegramVideoCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 21 });

      await handlePublicationCallback(
        context(versionedCallback(videoAction("sched_pick", [draftId, "youtube_shorts", "0800"]), timePrompt.revision), 21),
        backendDb,
        config,
      );

      expect(getVideoState(backendDb, 42)?.step).toBe("schedule_confirm");
      const latestCard = telegramVideoCard(backendDb, draftId);
      expect(latestCard).toEqual({ chatId: 100, messageId: expect.any(Number) });
      expect(latestCard?.messageId).toBeGreaterThan(21);
      expect(
        isStaleCardCallback(context(videoAction("sched_confirm", [draftId]), 21), backendDb, videoPublication("sched_confirm", [draftId])),
      ).toBe(true);
      expect(
        isStaleCardCallback(
          context(videoAction("sched_confirm", [draftId]), latestCard?.messageId ?? 0),
          backendDb,
          videoPublication("sched_confirm", [draftId]),
        ),
      ).toBe(false);
    }));
});
