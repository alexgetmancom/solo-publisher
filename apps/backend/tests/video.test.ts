import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { attachVideoAsset, handleVideoConversationMessage, startVideoDraft } from "../src/bot/video-conversation.js";
import { getVideoState, saveVideoState, videoScheduleConfirmationEffects } from "../src/bot/video-ui.js";
import { registerChannel } from "../src/channels/registry.js";
import {
  socialComments,
  studioMediaAssets,
  videoDrafts,
  videoJobs,
  videoMetricSchedule,
  videoMetricSnapshots,
  videoTargets,
} from "../src/db/schema.js";
import { recoverVideoLocks, runVideoCycle } from "../src/delivery/video-worker.js";
import { t } from "../src/foundation/i18n/index.js";
import { videoPreview } from "../src/interfaces/telegram/video-preview.js";
import { listVideoTargets } from "../src/publishing/video-data.js";
import { cancelVideo, replaceVideoTargets, retryVideoTarget, saveVideoMetadata, scheduleVideo } from "../src/publishing/video-service.js";
import type { VideoTechnicalCheck } from "../src/publishing/video-types.js";
import { VIDEO_LENGTH_WARNING_SECONDS } from "../src/publishing/video-types.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { videoService } from "../src/studio/services/videos.js";
import { VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { useBackendDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoAsset, createTestVideoDraft } from "./helpers/video.js";

function buttonLabels(effect: unknown): string[] {
  const markup = (effect as { options?: { reply_markup?: { inline_keyboard?: Array<Array<{ text: string }>> } } }).options?.reply_markup;
  return (markup?.inline_keyboard ?? []).flat().map((button) => button.text);
}

const TECHNICAL_CHECK: VideoTechnicalCheck = {
  width: 1080,
  height: 1920,
  seconds: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  fps: 30,
  sizeBytes: 1_000,
  aspectOk: true,
};

const testDb = useBackendDb(VIDEO_TEST_CHANNELS);

function videoConfig() {
  return loadTestConfig({});
}

function videoContext(input: { text?: string; callback?: string } = {}) {
  const replies: string[] = [];
  const callbackAnswers: Array<Record<string, unknown> | undefined> = [];
  const context = {
    from: { id: 42 },
    chat: { id: 100 },
    message: input.text == null ? undefined : { text: input.text },
    callbackQuery: input.callback == null ? undefined : { data: input.callback, message: { message_id: 11 } },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 12 };
    },
    answerCallbackQuery: async (options?: Record<string, unknown>) => {
      callbackAnswers.push(options);
    },
    editMessageReplyMarkup: async () => undefined,
    editMessageText: async () => undefined,
    api: { editMessageText: async () => undefined },
  };
  return { context: context as unknown as import("grammy").Context, replies, callbackAnswers };
}

describe("video publication queue", () => {
  it("persists the selected locale and resolves the matching Zernio account", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24, "en");
    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);
    registerChannel(backendDb, {
      platform: "instagram",
      locale: "en",
      provider: "zernio",
      providerAccountId: "en-account",
    });
    scheduleVideo(backendDb, draftId, { instagram_reels: new Date(Date.now() + 60 * 60_000) }, { prepareLeadMinutes: 15 });

    expect(backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, draftId)).get()?.locale).toBe("en");
    expect(listVideoTargets(backendDb, draftId)[0]).toMatchObject({ deliveryProvider: "zernio", providerAccountId: "en-account" });
  });

  it("removes an expired Studio source after every draft using it is final", async () => {
    const backendDb = testDb.open();
    const directory = mkdtempSync(path.join(os.tmpdir(), "studio-video-retention-"));
    const source = path.join(directory, "source.mp4");
    writeFileSync(source, "video");
    try {
      const now = new Date().toISOString();
      const asset = backendDb.db
        .insert(studioMediaAssets)
        .values({
          actorId: 42,
          kind: "video",
          mimeType: "video/mp4",
          filename: "source.mp4",
          localPath: source,
          byteSize: 5,
          sha256: "a".repeat(64),
          source: "telegram",
          createdAt: now,
        })
        .returning({ id: studioMediaAssets.id })
        .get();
      if (!asset) throw new Error("asset missing");
      const draftId = createTestVideoDraft(backendDb, 42, asset.id, 24);
      replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
      const target = listVideoTargets(backendDb, draftId)[0];
      if (!target) throw new Error("target missing");
      backendDb.db.update(videoTargets).set({ status: "published", updatedAt: now }).where(eq(videoTargets.id, target.id)).run();
      backendDb.db
        .update(videoDrafts)
        .set({ status: "published", retentionUntil: new Date(Date.now() - 1_000).toISOString(), updatedAt: now })
        .where(eq(videoDrafts.id, draftId))
        .run();

      const config = { ...videoConfig(), STUDIO_MEDIA_DIR: directory };
      await runVideoCycle(config, backendDb);
      expect(existsSync(source)).toBe(false);
      expect(backendDb.db.select().from(studioMediaAssets).where(eq(studioMediaAssets.id, asset.id)).get()).toBeDefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an expired Studio source that is still attached to a post draft", async () => {
    const backendDb = testDb.open();
    const directory = mkdtempSync(path.join(os.tmpdir(), "studio-video-retention-shared-"));
    const source = path.join(directory, "source.mp4");
    writeFileSync(source, "video");
    try {
      const now = new Date().toISOString();
      const asset = backendDb.db
        .insert(studioMediaAssets)
        .values({
          actorId: 42,
          kind: "video",
          mimeType: "video/mp4",
          filename: "source.mp4",
          localPath: source,
          byteSize: 5,
          sha256: "b".repeat(64),
          source: "telegram",
          createdAt: now,
        })
        .returning({ id: studioMediaAssets.id })
        .get();
      if (!asset) throw new Error("asset missing");
      const draftId = createTestVideoDraft(backendDb, 42, asset.id, 24);
      replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
      const target = listVideoTargets(backendDb, draftId)[0];
      if (!target) throw new Error("target missing");
      backendDb.db.update(videoTargets).set({ status: "published", updatedAt: now }).where(eq(videoTargets.id, target.id)).run();
      backendDb.db
        .update(videoDrafts)
        .set({ status: "published", retentionUntil: new Date(Date.now() - 1_000).toISOString(), updatedAt: now })
        .where(eq(videoDrafts.id, draftId))
        .run();
      seedTextPost(backendDb, {
        draftId: 999,
        actorId: 42,
        status: "needs_review",
        ru: "Post using the same asset",
        mediaRu: [{ type: "video", asset_id: asset.id, local_path: source }],
        now,
      });

      await runVideoCycle({ ...videoConfig(), STUDIO_MEDIA_DIR: directory }, backendDb);
      expect(existsSync(source)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("holds a stale video publish lock for verification instead of risking a duplicate", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);
    const target = listVideoTargets(backendDb, draftId)[0];
    if (!target) throw new Error("target missing");
    const now = new Date().toISOString();
    backendDb.db
      .insert(videoJobs)
      .values({
        videoDraftId: draftId,
        videoTargetId: target.id,
        kind: "publish",
        runAt: now,
        status: "running",
        lockedBy: "old-worker",
        // Comfortably past the 120s video lock window, which is a constant now.
        lockedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const config = { ...videoConfig(), VIDEO_LOCK_TIMEOUT_SECONDS: 60 };
    expect(recoverVideoLocks(backendDb, config)).toBe(1);
    expect(backendDb.db.select().from(videoJobs).all()).toMatchObject([
      {
        status: "verification_required",
        attemptCount: 1,
        lockedBy: null,
        lockedAt: null,
        lastError: "worker_lost: video lock expired before completion",
      },
    ]);
    expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, target.id)).get()).toMatchObject({
      status: "verification_required",
      lastError: "worker_lost: video lock expired before completion",
    });
  });

  it("still retries a stale native Instagram prepare lock because it cannot have published", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);
    const target = listVideoTargets(backendDb, draftId)[0];
    if (!target) throw new Error("target missing");
    const now = new Date().toISOString();
    backendDb.db
      .insert(videoJobs)
      .values({
        videoDraftId: draftId,
        videoTargetId: target.id,
        kind: "prepare",
        runAt: now,
        status: "running",
        attemptCount: 0,
        lockedBy: "old-worker",
        // Comfortably past the 120s video lock window, which is a constant now.
        lockedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    expect(recoverVideoLocks(backendDb, videoConfig())).toBe(1);
    expect(backendDb.db.select().from(videoJobs).all()).toMatchObject([
      { status: "queued", attemptCount: 1, lockedBy: null, lockedAt: null, lastError: "worker_lost: video lock expired before completion" },
    ]);
    expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, target.id)).get()).toMatchObject({
      status: "scheduled",
      lastError: "worker_lost: video lock expired before completion",
    });
  });

  it("lets a refused target's details be fixed before it is retried", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    saveVideoMetadata(backendDb, draftId, "youtube_shorts", { title: "Clip", description: "", tags: ["one"] });
    saveVideoMetadata(backendDb, draftId, "instagram_reels", { caption: "Clip" });
    // One platform took it, the other refused the details themselves — the
    // publication is half-finished, not settled. Freezing the metadata here left
    // the only fix out of reach and the retry able to reproduce the rejection.
    backendDb.sqlite.prepare("UPDATE video_drafts SET status='partial'").run();
    backendDb.sqlite.prepare("UPDATE video_targets SET status='failed' WHERE target='youtube_shorts'").run();
    backendDb.sqlite.prepare("UPDATE video_targets SET status='published' WHERE target='instagram_reels'").run();

    saveVideoMetadata(backendDb, draftId, "youtube_shorts", { title: "Clip", description: "", tags: ["shorter"] });

    expect(listVideoTargets(backendDb, draftId).find((target) => target.target === "youtube_shorts")?.metadataJson).toMatchObject({
      tags: ["shorter"],
    });
    // The published one stays untouchable: its details are what an audience has.
    expect(() => saveVideoMetadata(backendDb, draftId, "instagram_reels", { caption: "Changed" })).toThrow();
  });

  it("updates one video field through the Telegram message state machine", async () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    saveVideoMetadata(backendDb, draftId, "youtube_shorts", { title: "Old", description: "Description", tags: [] });
    saveVideoState(backendDb, 42, { draftId, step: "youtube_title", selected: ["youtube_shorts"], data: { is_single_edit: true } });
    const { context } = videoContext({ text: "New title" });

    expect((await handleVideoConversationMessage(context, backendDb, videoConfig())).handled).toBe(true);
    expect(listVideoTargets(backendDb, draftId)[0]?.metadataJson).toMatchObject({ title: "New title" });
    expect(getVideoState(backendDb, 42)).toBeNull();
  });

  it("advances the YouTube+Instagram wizard through every metadata step in FSM order", async () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    saveVideoState(backendDb, 42, { draftId, step: "youtube_title", selected: ["youtube_shorts", "instagram_reels"], data: {} });

    await handleVideoConversationMessage(videoContext({ text: "My Title" }).context, backendDb, videoConfig());
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "youtube_description" });

    await handleVideoConversationMessage(videoContext({ text: "My Description" }).context, backendDb, videoConfig());
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "youtube_game_url" });

    await handleVideoConversationMessage(videoContext({ text: "-" }).context, backendDb, videoConfig());
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "youtube_tags" });

    await handleVideoConversationMessage(videoContext({ text: "a, b, c" }).context, backendDb, videoConfig());
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "instagram_caption" });
    expect(listVideoTargets(backendDb, draftId).find((row) => row.target === "youtube_shorts")?.metadataJson).toMatchObject({
      title: "My Title",
      description: "My Description",
      tags: ["a", "b", "c"],
    });

    await handleVideoConversationMessage(videoContext({ text: "Caption #tag" }).context, backendDb, videoConfig());
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "schedule_choice" });
    expect(listVideoTargets(backendDb, draftId).find((row) => row.target === "instagram_reels")?.metadataJson).toMatchObject({
      caption: "Caption #tag",
    });
  });

  it("keeps independent platform schedules and queues Delivery prepare and publish work", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const youtubeAt = new Date(Date.now() + 60 * 60_000);
    const instagramAt = new Date(Date.now() + 2 * 60 * 60_000);
    scheduleVideo(backendDb, draftId, { youtube_shorts: youtubeAt, instagram_reels: instagramAt }, { prepareLeadMinutes: 15 }, 24);

    expect(listVideoTargets(backendDb, draftId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "youtube_shorts",
          scheduledAt: youtubeAt.toISOString(),
          metadataJson: expect.objectContaining({ videoDurationMs: 24_000 }),
        }),
        expect.objectContaining({
          target: "instagram_reels",
          scheduledAt: instagramAt.toISOString(),
          metadataJson: expect.objectContaining({ videoDurationMs: 24_000 }),
        }),
      ]),
    );
    expect(backendDb.sqlite.prepare("SELECT kind, count(*) AS count FROM video_jobs GROUP BY kind ORDER BY kind").all()).toEqual([
      { kind: "prepare", count: 2 },
      { kind: "publish", count: 2 },
    ]);
  });

  it("snapshots the Zernio route and account on a scheduled Instagram target", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);
    registerChannel(backendDb, {
      platform: "instagram",
      locale: "ru",
      provider: "zernio",
      providerAccountId: "maru-account",
    });
    scheduleVideo(backendDb, draftId, { instagram_reels: new Date(Date.now() + 60 * 60_000) }, { prepareLeadMinutes: 15 });
    expect(listVideoTargets(backendDb, draftId)[0]).toMatchObject({ deliveryProvider: "zernio", providerAccountId: "maru-account" });
  });

  it("retains a cancelled source for at least the configured 24 hours", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    cancelVideo(backendDb, draftId, 24);
    const row = backendDb.sqlite.prepare("SELECT status, retention_until FROM video_drafts WHERE id=?").get(draftId) as {
      status: string;
      retention_until: string;
    };
    expect(row.status).toBe("cancelled");
    expect(new Date(row.retention_until).getTime()).toBeGreaterThanOrEqual(Date.now() + 23 * 60 * 60_000);
    expect(backendDb.sqlite.prepare("SELECT status FROM video_targets WHERE video_draft_id=?").all(draftId)).toEqual([
      { status: "cancelled" },
    ]);
  });

  it("refuses cancellation while delivery is running and leaves every target untouched", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const targets = listVideoTargets(backendDb, draftId);
    const youtube = targets.find((target) => target.target === "youtube_shorts");
    const instagram = targets.find((target) => target.target === "instagram_reels");
    if (!youtube || !instagram) throw new Error("video targets missing");
    const now = new Date().toISOString();
    backendDb.db
      .update(videoTargets)
      .set({ status: "published", externalUrl: "https://www.youtube.com/watch?v=published", publishedAt: now, updatedAt: now })
      .where(eq(videoTargets.id, youtube.id))
      .run();
    backendDb.db
      .insert(videoJobs)
      .values({
        videoDraftId: draftId,
        videoTargetId: instagram.id,
        kind: "publish",
        runAt: now,
        status: "running",
        lockedBy: "worker-1",
        lockedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    expect(() => cancelVideo(backendDb, draftId, 24)).toThrow("err.video-cancel-in-progress");
    expect(backendDb.db.select().from(videoJobs).all()).toMatchObject([{ status: "running", lockedBy: "worker-1", lockedAt: now }]);
    expect(listVideoTargets(backendDb, draftId).map((target) => ({ target: target.target, status: target.status }))).toEqual([
      { target: "youtube_shorts", status: "published" },
      { target: "instagram_reels", status: "editing" },
    ]);
  });

  it("does not let another admin remove a video platform", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const service = videoService(backendDb, videoConfig());

    expect(() => service.removeTarget(7, draftId, "youtube_shorts")).toThrow("err.video-not-yours");
    expect(listVideoTargets(backendDb, draftId)).toHaveLength(2);
    expect(service.removeTarget(42, draftId, "youtube_shorts")).toEqual({ cancelled: false });
    expect(listVideoTargets(backendDb, draftId).map((target) => target.target)).toEqual(["instagram_reels"]);
  });

  it("refuses to reschedule a platform whose publish job a worker is still holding", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);
    const initial = new Date(Date.now() + 60 * 60_000);
    scheduleVideo(backendDb, draftId, { instagram_reels: initial }, { prepareLeadMinutes: 15 });
    backendDb.db
      .update(videoJobs)
      .set({ status: "running", lockedBy: "worker-1", lockedAt: new Date().toISOString() })
      .where(and(eq(videoJobs.videoDraftId, draftId), eq(videoJobs.kind, "publish")))
      .run();

    // Clearing the lock here would break the worker's (id, lockedBy) fence and
    // let the requeued job publish the same target a second time.
    expect(() =>
      scheduleVideo(backendDb, draftId, { instagram_reels: new Date(Date.now() + 3 * 60 * 60_000) }, { prepareLeadMinutes: 15 }),
    ).toThrow("err.video-job-running");
    expect(
      backendDb.db
        .select()
        .from(videoJobs)
        .where(and(eq(videoJobs.videoDraftId, draftId), eq(videoJobs.kind, "publish")))
        .get(),
    ).toMatchObject({ status: "running", lockedBy: "worker-1" });
    expect(listVideoTargets(backendDb, draftId)[0]?.scheduledAt).toBe(initial.toISOString());
  });

  it("reschedules only the selected platform and never requeues a published target", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const initial = new Date(Date.now() + 60 * 60_000);
    scheduleVideo(
      backendDb,
      draftId,
      { youtube_shorts: initial, instagram_reels: new Date(initial.getTime() + 60 * 60_000) },
      { prepareLeadMinutes: 15 },
    );
    backendDb.db
      .update(videoTargets)
      .set({ status: "published" })
      .where(and(eq(videoTargets.videoDraftId, draftId), eq(videoTargets.target, "youtube_shorts")))
      .run();

    const instagramAt = new Date(Date.now() + 3 * 60 * 60_000);
    scheduleVideo(backendDb, draftId, { instagram_reels: instagramAt }, { prepareLeadMinutes: 15 });

    expect(
      listVideoTargets(backendDb, draftId).map((target) => ({
        target: target.target,
        status: target.status,
        scheduledAt: target.scheduledAt,
      })),
    ).toEqual([
      { target: "youtube_shorts", status: "published", scheduledAt: initial.toISOString() },
      { target: "instagram_reels", status: "scheduled", scheduledAt: instagramAt.toISOString() },
    ]);
  });

  it("does not replace video targets once scheduling has begun", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    scheduleVideo(backendDb, draftId, { youtube_shorts: new Date(Date.now() + 60 * 60_000) }, { prepareLeadMinutes: 15 });
    expect(() => replaceVideoTargets(backendDb, draftId, ["instagram_reels"])).toThrow("err.video-targets-locked");
    expect(listVideoTargets(backendDb, draftId).map((target) => target.target)).toEqual(["youtube_shorts"]);
  });

  it("cleans dependent analytics rows when editable targets are replaced", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    const target = listVideoTargets(backendDb, draftId)[0];
    if (!target) throw new Error("target missing");
    const now = new Date().toISOString();
    backendDb.db
      .insert(videoMetricSnapshots)
      .values({ videoTargetId: target.id, platform: "youtube_shorts", metricsJson: {}, sampledAt: now })
      .run();
    backendDb.db.insert(videoMetricSchedule).values({ videoTargetId: target.id, nextCheckAt: now, updatedAt: now }).run();
    backendDb.db
      .insert(socialComments)
      .values({ platform: "youtube", commentId: "comment", videoTargetId: target.id, text: "x", fetchedAt: now })
      .run();

    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);

    expect(backendDb.db.select().from(videoMetricSnapshots).all()).toHaveLength(0);
    expect(backendDb.db.select().from(videoMetricSchedule).all()).toHaveLength(0);
    expect(backendDb.db.select().from(socialComments).all()).toHaveLength(0);
  });

  it("sets a 24-hour retention deadline as soon as a draft video is uploaded", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    const row = backendDb.sqlite.prepare("SELECT status, retention_until FROM video_drafts WHERE id=?").get(draftId) as {
      status: string;
      retention_until: string;
    };
    expect(row.status).toBe("editing");
    expect(new Date(row.retention_until).getTime()).toBeGreaterThanOrEqual(Date.now() + 23 * 60 * 60_000);
  });

  it("shows separate YouTube and Instagram metadata on the control card", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    saveVideoMetadata(backendDb, draftId, "youtube_shorts", {
      title: "Название ролика",
      description: "Описание для YouTube",
      gameUrl: "https://store.steampowered.com/app/123",
      tags: ["game", "shorts"],
    });
    saveVideoMetadata(backendDb, draftId, "instagram_reels", {
      caption: "Описание для Instagram\n#game #reels",
    });

    const preview = videoPreview(videoService(backendDb, videoConfig()).preview(42, draftId), videoConfig(), "ru");
    expect(preview.text).toContain("▶️ *YouTube Shorts*");
    expect(preview.text).toContain("Название: Название ролика");
    expect(preview.text).toContain("Игра: https://store.steampowered.com/app/123");
    expect(preview.text).toContain("📸 *Instagram Reels*");
    expect(preview.text).toContain("Описание: Описание для Instagram");
    // Each platform owns its own row of controls. Written out per platform,
    // YouTube's buttons used to leak into Instagram's row whenever the status
    // offered a time but no removal.
    const rows = preview.keyboard.inline_keyboard.map((row) => row.map((button) => String(button.text)).join(" | "));
    expect(rows.filter((row) => row.includes("YouTube Shorts"))).toHaveLength(1);
    expect(rows.filter((row) => row.includes("Instagram Reels"))).toHaveLength(1);
    expect(rows.some((row) => row.includes("YouTube Shorts") && row.includes("Instagram Reels"))).toBe(false);
  });

  it("retries only a failed platform without touching the other target", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const instagram = backendDb.db
      .select()
      .from(videoTargets)
      .where(and(eq(videoTargets.videoDraftId, draftId), eq(videoTargets.target, "instagram_reels")))
      .get();
    if (!instagram) throw new Error("instagram target missing");
    backendDb.db.update(videoTargets).set({ status: "failed", lastError: "Meta failed" }).where(eq(videoTargets.id, instagram.id)).run();

    retryVideoTarget(backendDb, draftId, "instagram_reels");

    expect(backendDb.sqlite.prepare("SELECT status FROM video_targets WHERE id=?").get(instagram.id)).toEqual({ status: "scheduled" });
    expect(
      backendDb.sqlite.prepare("SELECT count(*) AS count FROM video_jobs WHERE video_target_id=? AND kind='prepare'").get(instagram.id),
    ).toEqual({ count: 1 });
    expect(
      backendDb.sqlite.prepare("SELECT status FROM video_targets WHERE video_draft_id=? AND target='youtube_shorts'").get(draftId),
    ).toEqual({ status: "editing" });
  });

  it("does not retry a video mutation with an ambiguous provider outcome", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);
    const instagram = backendDb.db
      .select()
      .from(videoTargets)
      .where(and(eq(videoTargets.videoDraftId, draftId), eq(videoTargets.target, "instagram_reels")))
      .get();
    if (!instagram) throw new Error("instagram target missing");
    backendDb.db.update(videoTargets).set({ status: "verification_required" }).where(eq(videoTargets.id, instagram.id)).run();

    expect(() => retryVideoTarget(backendDb, draftId, "instagram_reels")).toThrow("err.retry-only-failed");
    expect(backendDb.sqlite.prepare("SELECT count(*) AS count FROM video_jobs WHERE video_target_id=?").get(instagram.id)).toEqual({
      count: 0,
    });
  });
  it("asks about a clip past the length threshold before any draft exists, and creates it once confirmed", async () => {
    const backendDb = testDb.open();
    const config = videoConfig();
    const assetId = createTestVideoAsset(backendDb, 42, "/tmp/long-video.mp4");
    const services = createStudioServices(backendDb, config);
    // The probe is the only part of the attach that needs a real file on disk.
    const probed = (seconds: number) => ({
      ...services,
      videos: { ...services.videos, assetTechnicalCheck: async () => ({ ...TECHNICAL_CHECK, seconds }) },
    });
    const session = saveVideoState(backendDb, 42, {
      draftId: null,
      step: "asset",
      selected: ["youtube_shorts", "instagram_reels"],
      data: { videoLocale: "ru" },
    });

    const asked = await attachVideoAsset(backendDb, config, 42, session, assetId, probed(VIDEO_LENGTH_WARNING_SECONDS + 1));

    expect(JSON.stringify(asked)).toContain("p:video:length_ok");
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "asset", draftId: null });
    // Nothing was created: answering "no" has to leave no orphan behind.
    expect(backendDb.db.select().from(videoDrafts).all()).toHaveLength(0);

    const confirmed = getVideoState(backendDb, 42);
    if (!confirmed) throw new Error("video session missing");
    await startVideoDraft(backendDb, config, 42, confirmed, assetId, probed(VIDEO_LENGTH_WARNING_SECONDS + 1));

    expect(backendDb.db.select().from(videoDrafts).all()).toHaveLength(1);
    expect(getVideoState(backendDb, 42)?.step).not.toBe("asset");
  });

  /** The destination screen's answer is what the draft is made of: a video
   * meant for Instagram alone gets Instagram's targets and Instagram's
   * question, and is never asked for a YouTube title it will not use. */
  it("creates only the platforms the operator chose and asks only their questions", async () => {
    const backendDb = testDb.open();
    const config = videoConfig();
    const assetId = createTestVideoAsset(backendDb, 42, "/tmp/ig-only.mp4");
    const session = saveVideoState(backendDb, 42, {
      draftId: null,
      step: "asset",
      selected: ["instagram_reels"],
      data: { videoLocale: "ru" },
    });

    const effects = await startVideoDraft(backendDb, config, 42, session, assetId);

    expect(effects[0]).toMatchObject({ text: expect.stringContaining("Instagram Reels") });
    expect(getVideoState(backendDb, 42)?.step).toBe("instagram_caption");
    expect(
      backendDb.db
        .select()
        .from(videoTargets)
        .all()
        .map((row) => row.target),
    ).toEqual(["instagram_reels"]);
  });

  /** A value a platform would refuse is answered by the question itself, with
   * the controls that question carries. The bare error under a lone cancel left
   * an over-long title with no way back into the wizard. */
  it("re-asks the step, with its own controls, when a typed value is refused", async () => {
    const backendDb = testDb.open();
    const config = videoConfig();
    const assetId = createTestVideoAsset(backendDb, 42, "/tmp/too-long.mp4");
    const session = saveVideoState(backendDb, 42, {
      draftId: null,
      step: "asset",
      selected: ["youtube_shorts"],
      data: { videoLocale: "ru" },
    });
    await startVideoDraft(backendDb, config, 42, session, assetId);
    await handleVideoConversationMessage(videoContext({ text: "A usable title" }).context, backendDb, config);
    expect(getVideoState(backendDb, 42)?.step).toBe("youtube_description");

    const refused = await handleVideoConversationMessage(videoContext({ text: "x".repeat(5_000) }).context, backendDb, config);

    expect((refused.effects[0] as { text: string }).text).toContain(t("en", "video.prompt-yt-description"));
    expect(buttonLabels(refused.effects[0])).toContain(t("en", "common.back"));
    // The step did not move on: the question is still the one being answered.
    expect(getVideoState(backendDb, 42)?.step).toBe("youtube_description");
  });

  /** Every platform of a video publication shows the same file, so the previews
   * carry only the metadata that differs and the clip is offered once, by the
   * button on the confirmation. Sent per platform, it was the same 35 MB twice,
   * pushing the metadata off the screen. */
  it("keeps the clip out of the per-platform previews and offers it once as the source", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    saveVideoMetadata(backendDb, draftId, "youtube_shorts", { title: "Title", description: "", tags: [] });

    const delivery = createStudioServices(backendDb, videoConfig()).videos.preview(42, draftId).delivery;

    expect(delivery.projections).toHaveLength(2);
    expect(delivery.projections.every((projection) => projection.media.length === 0)).toBe(true);
    expect(delivery.source).toMatchObject({ type: "video" });
  });

  it("puts the one clip behind a button on the schedule confirmation", () => {
    const backendDb = testDb.open();
    const config = videoConfig();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    const session = saveVideoState(backendDb, 42, {
      draftId,
      step: "schedule_confirm",
      selected: ["youtube_shorts"],
      data: {},
    });
    const services = createStudioServices(backendDb, config);

    const effects = videoScheduleConfirmationEffects(
      backendDb,
      config,
      42,
      session,
      { youtube_shorts: new Date("2026-09-04T08:00:00.000Z") },
      services,
    );

    const confirmation = effects.find((effect) => effect.type === "screen");
    expect(buttonLabels(confirmation)).toEqual([t("en", "video.show-source"), t("en", "common.confirm"), t("en", "common.back")]);
    expect(JSON.stringify(confirmation)).toContain(`delivery_preview_video:${draftId}`);
  });

  it("attaches a clip within the length threshold without asking", async () => {
    const backendDb = testDb.open();
    const config = videoConfig();
    const assetId = createTestVideoAsset(backendDb, 42, "/tmp/short-video.mp4");
    const services = createStudioServices(backendDb, config);
    const session = saveVideoState(backendDb, 42, {
      draftId: null,
      step: "asset",
      selected: ["youtube_shorts", "instagram_reels"],
      data: { videoLocale: "ru" },
    });

    const effects = await attachVideoAsset(backendDb, config, 42, session, assetId, {
      ...services,
      videos: { ...services.videos, assetTechnicalCheck: async () => ({ ...TECHNICAL_CHECK, seconds: VIDEO_LENGTH_WARNING_SECONDS }) },
    });

    expect(JSON.stringify(effects)).not.toContain("p:video:length_ok");
    expect(backendDb.db.select().from(videoDrafts).all()).toHaveLength(1);
  });
});
