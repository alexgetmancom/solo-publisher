import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { handlePublicationCallback, isStaleCardCallback } from "../src/bot/callback-router.js";
import { type PublicationCallback, parseSessionCallback, publicationCallback } from "../src/bot/publication-callback.js";
import { getVideoState } from "../src/bot/video-ui.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import type { BackendDb } from "../src/db/client.js";
import {
  setTelegramPostCard,
  setTelegramVideoCard,
  telegramPostCard,
  telegramVideoCard,
} from "../src/interfaces/telegram/control-cards.js";
import { replaceVideoTargets } from "../src/publishing/video-service.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoDraft } from "./helpers/video.js";

function videoCallback(data: string, messageId: number): Context {
  return {
    from: { id: 42 },
    chat: { id: 100 },
    callbackQuery: { data, message: { message_id: messageId } },
    answerCallbackQuery: async () => undefined,
    editMessageText: async () => undefined,
  } as unknown as Context;
}

function parsed(value: string): PublicationCallback {
  const callback = parseSessionCallback(value).callback;
  if (!callback) throw new Error(`Expected publication callback: ${value}`);
  return callback;
}

describe("video publication card flow", () => {
  it("keeps the immediate confirmation on the current video card", () =>
    withDb(async (backendDb: BackendDb) => {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
      const draftId = createTestVideoDraft(backendDb, 42, "clip.mp4", 24);
      replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
      setTelegramVideoCard(backendDb, draftId, 100, 10);

      await handlePublicationCallback(videoCallback(publicationCallback("video", "publish", [draftId]), 10), backendDb, config);

      const session = getVideoState(backendDb, 42);
      expect(session?.step).toBe("schedule_confirm");
      expect(telegramVideoCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 10 });
      expect(
        isStaleCardCallback(
          videoCallback(publicationCallback("video", "publish_confirm", [draftId]), 10),
          backendDb,
          parsed(publicationCallback("video", "publish_confirm", [draftId])),
        ),
      ).toBe(false);
    }));
});

describe("post publication card flow", () => {
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
      const context = {
        from: { id: 42 },
        chat: { id: 100 },
        callbackQuery: { data: publicationCallback("post", "publish", [draftId]), message: { message_id: 10 } },
        answerCallbackQuery: async () => true,
        reply: async () => ({ message_id: ++nextMessageId }),
        replyWithVideo: async () => ({ message_id: ++nextMessageId }),
      } as unknown as Context;

      await handlePublicationCallback(context, backendDb, config);

      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: nextMessageId });
      expect(
        isStaleCardCallback(
          { callbackQuery: { message: { message_id: nextMessageId } } } as unknown as Context,
          backendDb,
          parsed(publicationCallback("post", "publish_confirm", [draftId])),
        ),
      ).toBe(false);
    }));
});
