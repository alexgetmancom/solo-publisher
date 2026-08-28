import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { handlePublicationMessage } from "../src/bot/callback-router.js";
import { saveConversationState } from "../src/bot/conversation-state.js";
import { saveVideoState } from "../src/bot/video-ui.js";
import { createDraftFromMessage, requireDraft } from "../src/content/drafts.js";
import { pendingAlbums } from "../src/db/schema.js";
import { unsafeDb } from "../src/db/unsafe.js";
import { t } from "../src/foundation/i18n/index.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("Telegram publication message routing", () => {
  it("does not send a text message from an active video session to the post handler", () =>
    withDb(async (backendDb) => {
      saveVideoState(backendDb, 42, { draftId: 7, step: "schedule_choice", selected: [], data: {} });
      const replies: string[] = [];
      const ctx = {
        from: { id: 42 },
        chat: { id: 100 },
        message: { text: "This must stay in the video flow" },
        reply: async (text: string) => {
          replies.push(text);
          return { message_id: 1 };
        },
      } as unknown as Context;

      // The step is answered with buttons, so the wizard says so and keeps the
      // message: it must never fall through and become a post.
      expect(await handlePublicationMessage(ctx, backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }))).toBe(true);
      expect(replies).toEqual([t("en", "video.awaiting-button")]);
      expect(unsafeDb(backendDb).sqlite.prepare("SELECT count(*) AS count FROM drafts").get()).toEqual({ count: 0 });
    }));

  it("does not send a text message from an active post session to the video handler", () =>
    withDb(async (backendDb) => {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Before", textEn: "Before", entities: [], media: [] });
      saveConversationState(backendDb, 42, { kind: "post", draftId, step: "edit_text", data: { locale: "ru" }, controlMessageId: null });
      const ctx = {
        from: { id: 42 },
        chat: { id: 100 },
        message: { text: "This must stay in the post flow" },
        reply: async () => ({ message_id: 1 }),
      } as unknown as Context;

      expect(await handlePublicationMessage(ctx, backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }))).toBe(true);
      expect(requireDraft(backendDb, draftId).text_ru).toBe("This must stay in the post flow");
      expect(unsafeDb(backendDb).sqlite.prepare("SELECT count(*) AS count FROM video_drafts").get()).toEqual({ count: 0 });
    }));

  it("sends an album through the active post flow before parsing its input step", () =>
    withDb(async (backendDb) => {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Before", textEn: "Before", entities: [], media: [] });
      saveConversationState(backendDb, 42, {
        kind: "post",
        draftId,
        step: "replace_media",
        data: { locale: "en" },
        controlMessageId: 99,
      });
      const ctx = {
        from: { id: 42 },
        chat: { id: 100 },
        message: {
          media_group_id: "album-1",
          caption: "",
          caption_entities: [],
          photo: [{ file_id: "photo-1", width: 100, height: 100 }],
        },
        reply: async () => undefined,
      } as unknown as Context;

      expect(await handlePublicationMessage(ctx, backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }))).toBe(true);
      expect(unsafeDb(backendDb).db.select().from(pendingAlbums).all()).toHaveLength(1);
    }));
});
