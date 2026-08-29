import { afterEach, describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { handlePublicationCallback } from "../src/bot/callback-router.js";
import { publicationCallback, versionedCallback } from "../src/bot/publication-callback.js";
import { clearVideoState, getVideoState, saveVideoState } from "../src/bot/video-ui.js";
import { type BackendDb, unsafeDb } from "../src/db/client.js";
import { t } from "../src/foundation/i18n/index.js";
import { setTelegramVideoCard } from "../src/interfaces/telegram/control-cards.js";
import { videoPreview } from "../src/interfaces/telegram/video-preview.js";
import { replaceVideoTargets, scheduleVideo } from "../src/publishing/video-service.js";
import { registerTestChannels, VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoDraft } from "./helpers/video.js";

let backendDb: BackendDb | null = null;

function openVideoDb(): BackendDb {
  const memory = ":memory:";
  const db = openBackendDb(memory);
  registerTestChannels(db, VIDEO_TEST_CHANNELS);
  return db;
}

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });

function draftCard(status: string, target = "youtube_shorts", deliveryProvider: string | null = "native") {
  return {
    draft: { id: 7, label: "Clip", locale: "ru", status },
    targets: [{ id: 1, target, status, metadataJson: { title: "Clip" }, scheduledAt: null, deliveryProvider }],
  };
}

describe("video card controls", () => {
  it("offers publishing now beside scheduling, like a text post card", () => {
    const keyboard = JSON.stringify(videoPreview(draftCard("draft"), config, "ru").keyboard);

    expect(keyboard).toContain("p:video:publish:7");
    expect(keyboard).toContain("p:video:schedule:7");
  });

  it("drops both publication controls once the video leaves the draft states", () => {
    const keyboard = JSON.stringify(videoPreview(draftCard("scheduled"), config, "ru").keyboard);

    expect(keyboard).not.toContain("p:video:publish:7");
    expect(keyboard).not.toContain("p:video:schedule:7");
    expect(keyboard).toContain("p:video:edit_menu:7");
  });

  it("localizes a target that needs provider verification", () => {
    const preview = videoPreview(draftCard("verification_required"), config, "ru");

    expect(preview.text).toContain("нужна проверка");
    expect(preview.text).not.toContain("verification_required");
    expect(JSON.stringify(preview.keyboard)).not.toContain("p:video:retry:7");
  });

  it("offers the provider answer only where the same request cannot publish twice", () => {
    // A lost worker leaves nobody knowing whether the audience has it. Asking
    // the provider is safe because the request id fences the publication; a
    // native upload has no such fence and must not grow a button.
    const throughProvider = videoPreview(draftCard("verification_required", "instagram_reels", "zernio"), config, "ru");
    expect(JSON.stringify(throughProvider.keyboard)).toContain("p:video:settle:7:instagram_reels");

    const native = videoPreview(draftCard("verification_required", "instagram_reels", "native"), config, "ru");
    expect(JSON.stringify(native.keyboard)).not.toContain("p:video:settle:7");
  });

  it("offers Instagram metadata editing and a file replacement while a scheduled target is still waiting", async () => {
    backendDb = openVideoDb();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);
    scheduleVideo(backendDb, draftId, { instagram_reels: new Date(Date.now() + 3_600_000) }, { prepareLeadMinutes: 10 });
    let options: { reply_markup?: unknown } | undefined;
    const ctx = {
      callbackQuery: { data: publicationCallback("video", "edit_menu", [draftId]), message: { message_id: 10 } },
      from: { id: 42 },
      chat: { id: 100 },
      editMessageText: async (_text: string, nextOptions: { reply_markup?: unknown }) => {
        options = nextOptions;
      },
      answerCallbackQuery: async () => undefined,
    } as unknown as Context;

    await handlePublicationCallback(ctx, backendDb, config);

    const keyboard = JSON.stringify(options?.reply_markup);
    expect(keyboard).toContain(`p:video:edit_field:${draftId}:instagram_caption`);
    expect(keyboard).not.toContain(`p:video:edit_field:${draftId}:label`);
    expect(keyboard).toContain(`p:video:edit_media:${draftId}`);
  });
});

describe("video callback dispatch", () => {
  it("reports an unrouted video callback instead of answering it silently", async () => {
    backendDb = openVideoDb();
    const answers: Array<{ text?: string } | undefined> = [];
    const ctx = {
      callbackQuery: { data: "p:video:not_a_route:7" },
      from: { id: 42 },
      answerCallbackQuery: async (options?: { text?: string }) => void answers.push(options),
      reply: async () => undefined,
    } as unknown as Context;

    const handled = await handlePublicationCallback(ctx, backendDb, config);

    // Still claimed by the video branch: falling through would reach the post
    // handler, which would answer a second time with "invalid post".
    expect(handled).toBe(true);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBeTruthy();
  });

  /** Navigation writes over the screen it was tapped on. Going back used to
   * arrive as a new message below the question it came from, so "← Back" moved
   * the operator forward in the chat. */
  it("re-asks the previous wizard step on the message the Back button sits on", async () => {
    backendDb = openVideoDb();
    const draftId = createTestVideoDraft(backendDb, 42, "clip.mp4", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    const session = saveVideoState(backendDb, 42, {
      draftId,
      step: "youtube_description",
      selected: ["youtube_shorts"],
      data: {},
    });
    const edits: string[] = [];
    const replies: string[] = [];
    const ctx = {
      from: { id: 42 },
      chat: { id: 100 },
      callbackQuery: { data: versionedCallback(publicationCallback("video", "meta_back"), session.revision), message: { message_id: 10 } },
      answerCallbackQuery: async () => true,
      editMessageText: async (text: string) => void edits.push(text),
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 11 };
      },
    } as unknown as Context;

    await handlePublicationCallback(ctx, backendDb, config);

    expect(getVideoState(backendDb, 42)?.step).toBe("youtube_title");
    expect(edits).toHaveLength(1);
    expect(replies).toEqual([]);
    clearVideoState(backendDb, 42);
  });

  /** The tap landed on a card the publication has moved past. Saying so and
   * nothing else left the live card up in the history to scroll for. */
  it("sends the live card back down when a superseded card is tapped", async () => {
    backendDb = openVideoDb();
    const draftId = createTestVideoDraft(backendDb, 42, "clip.mp4", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    setTelegramVideoCard(backendDb, draftId, 100, 30);
    const answers: Array<{ text?: string } | undefined> = [];
    const replies: string[] = [];
    const ctx = {
      from: { id: 42 },
      chat: { id: 100 },
      callbackQuery: { data: publicationCallback("video", "edit_menu", [draftId]), message: { message_id: 10 } },
      answerCallbackQuery: async (options?: { text?: string }) => void answers.push(options),
      editMessageText: async () => undefined,
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 31 };
      },
    } as unknown as Context;

    await handlePublicationCallback(ctx, backendDb, config);

    expect(answers[0]?.text).toBe(t("en", "action.card-stale"));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("YouTube Shorts");
  });

  it("routes namespaced callbacks to the video handler", async () => {
    backendDb = openVideoDb();
    const draftId = createTestVideoDraft(backendDb, 42, "clip.mp4", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);

    const ctx = {
      callbackQuery: { data: publicationCallback("video", "publish", [draftId]), message: { message_id: 10 } },
      from: { id: 42 },
      chat: { id: 100 },
      editMessageText: async () => undefined,
      answerCallbackQuery: async () => undefined,
    } as unknown as Context;

    await handlePublicationCallback(ctx, backendDb, config);

    expect(getVideoState(backendDb, 42)?.step).toBe("schedule_confirm");
    clearVideoState(backendDb, 42);
  });

  it("asks every platform for its own time before confirming a per-target schedule", async () => {
    backendDb = openVideoDb();
    const bothPlatforms = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
    const draftId = createTestVideoDraft(backendDb, 42, "clip.mp4", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    setTelegramVideoCard(backendDb, draftId, 100, 10);
    let nextMessageId = 20;
    // Each prompt arrives as a fresh message and becomes the card, so the next
    // tap has to come from it — a callback on a superseded message is stale.
    let cardMessageId = 10;
    const context = (data: string): Context =>
      ({
        from: { id: 42 },
        chat: { id: 100 },
        callbackQuery: { data, message: { message_id: cardMessageId } },
        answerCallbackQuery: async () => true,
        editMessageText: async () => undefined,
        reply: async () => {
          nextMessageId += 1;
          cardMessageId = nextMessageId;
          return { message_id: nextMessageId };
        },
        replyWithVideo: async () => {
          nextMessageId += 1;
          return { message_id: nextMessageId };
        },
        api: { editMessageText: async () => undefined },
      }) as unknown as Context;
    const current = () => {
      const state = getVideoState(backendDb as BackendDb, 42);
      if (!state) throw new Error("video schedule session missing");
      return state;
    };

    await handlePublicationCallback(context(publicationCallback("video", "schedule", [draftId])), backendDb, bothPlatforms);
    await handlePublicationCallback(
      context(versionedCallback(publicationCallback("video", "individual", [draftId]), current().revision)),
      backendDb,
      bothPlatforms,
    );
    expect(current()).toMatchObject({ step: "schedule_target", data: { target: "youtube_shorts" } });

    await handlePublicationCallback(
      context(versionedCallback(publicationCallback("video", "sched_pick", [draftId, "youtube_shorts", "0800"]), current().revision)),
      backendDb,
      bothPlatforms,
    );
    // The first pick must not jump to confirmation: Instagram has no time yet.
    expect(current()).toMatchObject({ step: "schedule_target", data: { target: "instagram_reels" } });

    await handlePublicationCallback(
      context(versionedCallback(publicationCallback("video", "sched_pick", [draftId, "instagram_reels", "0930"]), current().revision)),
      backendDb,
      bothPlatforms,
    );

    const confirmed = current();
    expect(confirmed.step).toBe("schedule_confirm");
    const schedule = confirmed.data.schedule as Record<string, string>;
    expect(Object.keys(schedule).sort()).toEqual(["instagram_reels", "youtube_shorts"]);
    expect(new Date(schedule.youtube_shorts ?? "").getTime()).not.toBe(new Date(schedule.instagram_reels ?? "").getTime());
    clearVideoState(backendDb, 42);
  });

  it("rejects a callback from an older video dialog revision", async () => {
    backendDb = openVideoDb();
    const first = saveVideoState(backendDb, 42, { draftId: 7, step: "youtube_game_url", selected: ["youtube_shorts"], data: {} });
    saveVideoState(backendDb, 42, { ...first, data: { note: "moved on" } });
    const answers: Array<{ text?: string } | undefined> = [];
    const ctx = {
      callbackQuery: { data: versionedCallback(publicationCallback("video", "game_skip"), first.revision) },
      from: { id: 42 },
      answerCallbackQuery: async (options?: { text?: string }) => void answers.push(options),
    } as unknown as Context;

    expect(await handlePublicationCallback(ctx, backendDb, config)).toBe(true);
    expect(answers[0]?.text).toBe("This dialog is outdated. Start again.");
    expect(getVideoState(backendDb, 42)?.step).toBe("youtube_game_url");
  });

  it("opens target scheduling after a previous video dialog was retired", async () => {
    backendDb = openVideoDb();
    const draftId = createTestVideoDraft(backendDb, 42, "clip.mp4", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    const previous = saveVideoState(backendDb, 42, {
      draftId,
      step: "schedule_common",
      selected: ["youtube_shorts"],
      data: {},
    });
    clearVideoState(backendDb, 42);

    const answers: Array<{ text?: string } | undefined> = [];
    const ctx = {
      callbackQuery: {
        data: publicationCallback("video", "time", [draftId, "youtube_shorts"]),
        message: { message_id: 10 },
      },
      from: { id: 42 },
      chat: { id: 100 },
      reply: async () => ({ message_id: 11 }),
      answerCallbackQuery: async (options?: { text?: string }) => void answers.push(options),
    } as unknown as Context;

    await handlePublicationCallback(ctx, backendDb, config);

    expect(answers).toEqual([undefined]);
    expect(getVideoState(backendDb, 42)).toMatchObject({
      draftId,
      step: "schedule_target",
      data: { target: "youtube_shorts" },
      revision: previous.revision + 2,
    });
  });

  it("accepts cancellation from a standalone reminder even when the card was replaced", async () => {
    backendDb = openVideoDb();
    const draftId = createTestVideoDraft(backendDb, 42, "clip.mp4", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    setTelegramVideoCard(backendDb, draftId, 100, 10);
    const answers: Array<{ text?: string } | undefined> = [];
    const ctx = {
      callbackQuery: { data: publicationCallback("video", "cancel_confirm", [draftId]), message: { message_id: 50 } },
      from: { id: 42 },
      chat: { id: 100 },
      editMessageText: async () => undefined,
      answerCallbackQuery: async (options?: { text?: string }) => void answers.push(options),
    } as unknown as Context;

    await handlePublicationCallback(ctx, backendDb, config);

    expect(answers).toEqual([undefined]);
    expect(unsafeDb(backendDb).sqlite.prepare("SELECT status FROM video_targets WHERE video_draft_id=?").get(draftId)).toEqual({
      status: "cancelled",
    });
  });
});
