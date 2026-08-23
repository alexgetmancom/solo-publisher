import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { registerChannel } from "../src/channels/registry.js";
import { publicationEvents, videoJobs, videoTargets } from "../src/db/schema.js";
import { recordAuthFailure } from "../src/observability/auth-circuit.js";
import { replaceVideoTargets, saveVideoMetadata, scheduleVideo } from "../src/publishing/video-service.js";
import { VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { useBackendDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoDraft } from "./helpers/video.js";

/**
 * The video cycle's job execution: which platform call a job makes, what it
 * writes back to the durable target, and what it does when the draft is
 * cancelled underneath a running upload.
 *
 * The publishers themselves are covered by videoPublishers.test.ts; here they
 * are replaced so a cycle can be driven end to end without uploading. As in
 * socialPorts.test.ts, `mock.module` is process-wide, so the replacements
 * delegate to the real functions unless this file is the one running.
 */

let intercepting = false;
const publishers = await import("../src/delivery/video-publishers.js");
const zernio = await import("../src/delivery/zernio.js");
const real = {
  prepareYouTubeVideo: publishers.prepareYouTubeVideo,
  keepYouTubeUploadPrivate: publishers.keepYouTubeUploadPrivate,
  prepareInstagramReel: publishers.prepareInstagramReel,
  instagramContainerReady: publishers.instagramContainerReady,
  publishInstagramReel: publishers.publishInstagramReel,
  publishZernioInstagramReel: zernio.publishZernioInstagramReel,
};

const seen: string[] = [];
const instagramCredentialsSeen: Array<{ token: string | undefined; userId: string | undefined }> = [];
let containerReadyError: Error | null = null;
/** Runs while a platform call is in flight, so a test can cancel the draft
 * exactly where a real cancellation would land. */
let duringUpload: (() => void) | null = null;

mock.module("../src/delivery/video-publishers.js", () => ({
  ...publishers,
  prepareYouTubeVideo: async (...args: Parameters<typeof real.prepareYouTubeVideo>) => {
    if (!intercepting) return real.prepareYouTubeVideo(...args);
    seen.push("prepareYouTubeVideo");
    duringUpload?.();
    return { id: "yt-1", url: "https://www.youtube.com/watch?v=yt-1" };
  },
  keepYouTubeUploadPrivate: async (...args: Parameters<typeof real.keepYouTubeUploadPrivate>) => {
    if (!intercepting) return real.keepYouTubeUploadPrivate(...args);
    seen.push("keepYouTubeUploadPrivate");
  },
  prepareInstagramReel: async (...args: Parameters<typeof real.prepareInstagramReel>) => {
    if (!intercepting) return real.prepareInstagramReel(...args);
    seen.push("prepareInstagramReel");
    instagramCredentialsSeen.push({ token: args[1].accessToken, userId: args[1].userId });
    duringUpload?.();
    return { id: "ig-container" };
  },
  instagramContainerReady: async (...args: Parameters<typeof real.instagramContainerReady>) => {
    if (!intercepting) return real.instagramContainerReady(...args);
    seen.push("instagramContainerReady");
    instagramCredentialsSeen.push({ token: args[1].accessToken, userId: args[1].userId });
    if (containerReadyError) throw containerReadyError;
  },
  publishInstagramReel: async (...args: Parameters<typeof real.publishInstagramReel>) => {
    if (!intercepting) return real.publishInstagramReel(...args);
    seen.push("publishInstagramReel");
    instagramCredentialsSeen.push({ token: args[1].accessToken, userId: args[1].userId });
    return { id: "ig-reel", url: "https://www.instagram.com/reel/ig-reel/" };
  },
}));
mock.module("../src/delivery/zernio.js", () => ({
  ...zernio,
  publishZernioInstagramReel: async (...args: Parameters<typeof real.publishZernioInstagramReel>) => {
    if (!intercepting) return real.publishZernioInstagramReel(...args);
    seen.push("publishZernioInstagramReel");
    return zernioReelResult;
  },
}));

/** What the provider answers a Reel publication with. It accepts before the
 * platform does, so "no platform link yet" is a real answer, not a failure. */
let zernioReelResult: { providerPostId: string; externalId: string | null; url: string | null } = {
  providerPostId: "z-1",
  externalId: "ig-2",
  url: "https://www.instagram.com/reel/ig-2/",
};

const { runVideoCycle } = await import("../src/delivery/video-worker.js");
const { cancelVideo } = await import("../src/publishing/video-service.js");

const testDb = useBackendDb(VIDEO_TEST_CHANNELS);

beforeAll(() => {
  intercepting = true;
});
afterAll(() => {
  intercepting = false;
});

function videoConfig(directory: string, overrides: Record<string, string> = {}) {
  const config = loadTestConfig({
    YOUTUBE_RU_CLIENT_ID: "client",
    YOUTUBE_RU_CLIENT_SECRET: "secret",
    YOUTUBE_RU_REFRESH_TOKEN: "refresh",
    INSTAGRAM_RU_ACCESS_TOKEN: "EAAB-token",
    INSTAGRAM_RU_USER_ID: "ig-user",
    PUBLIC_MEDIA_BASE_URL: "https://alexgetman.com/media",
    ...overrides,
  });
  return { ...config, VIDEO_MEDIA_DIR: directory, STUDIO_MEDIA_DIR: directory };
}

/** A scheduled draft whose jobs are all due now, so one cycle runs them. */
function dueDraft(backendDb: ReturnType<typeof testDb.open>, directory: string, targets: string[], locale: "ru" | "en" = "ru"): number {
  const assetKey = `clip-${targets.join("-")}`;
  const source = path.join(directory, `${assetKey}.mp4`);
  writeFileSync(source, "video-bytes");
  const draftId = createTestVideoDraft(backendDb, 42, source, 24, locale);
  replaceVideoTargets(backendDb, draftId, targets as never);
  if (targets.includes("youtube_shorts")) {
    saveVideoMetadata(backendDb, draftId, "youtube_shorts", {
      title: "Test video",
      description: "Test description",
      tags: [],
    });
  }
  const at = new Date(Date.now() + 60 * 60_000);
  scheduleVideo(backendDb, draftId, Object.fromEntries(targets.map((target) => [target, at])), { prepareLeadMinutes: 15 });
  // Drizzle needs a predicate to update; the point here is only to make every
  // job of this draft due, so drive it through the raw handle.
  const past = new Date(Date.now() - 1_000).toISOString();
  backendDb.sqlite.prepare("UPDATE video_jobs SET run_at = ?, updated_at = ? WHERE video_draft_id = ?").run(past, past, draftId);
  return draftId;
}

function targetRow(backendDb: ReturnType<typeof testDb.open>, draftId: number) {
  return backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
}

function withDirectory<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "video-worker-"));
  return fn(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function reset(): void {
  zernioReelResult = { providerPostId: "z-1", externalId: "ig-2", url: "https://www.instagram.com/reel/ig-2/" };
  seen.length = 0;
  instagramCredentialsSeen.length = 0;
  containerReadyError = null;
  duringUpload = null;
}

describe("video job execution", () => {
  it("claims each serial video job only when its provider call is about to start", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      dueDraft(backendDb, directory, ["youtube_shorts"]);
      dueDraft(backendDb, directory, ["youtube_shorts"]);
      let statuses: string[] = [];
      duringUpload = () => {
        statuses = backendDb.db
          .select({ status: videoJobs.status })
          .from(videoJobs)
          .all()
          .map((job) => job.status);
        duringUpload = null;
      };

      await runVideoCycle(config, backendDb);

      expect(statuses.filter((status) => status === "running")).toHaveLength(1);
      expect(statuses.filter((status) => status === "queued")).toHaveLength(3);
    });
  });

  it("uploads to YouTube on prepare and records the id before the scheduled release", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["youtube_shorts"]);

      await runVideoCycle(config, backendDb);

      expect(seen).toContain("prepareYouTubeVideo");
      const target = targetRow(backendDb, draftId);
      // Publishing is a second job: prepare only parks a private upload.
      expect(target).toMatchObject({ status: "published", externalId: "yt-1", externalUrl: "https://www.youtube.com/watch?v=yt-1" });
    });
  });

  it("rejects cancellation during a YouTube upload instead of losing the provider id", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["youtube_shorts"]);
      // The video id exists only in the upload response, so cancellation must
      // not discard the local job while the provider call is in flight.
      duringUpload = () => {
        expect(() => cancelVideo(backendDb, draftId, 24)).toThrow("err.video-cancel-in-progress");
      };

      await runVideoCycle(config, backendDb);

      // Cancellation is rejected while the delivery lock is held. The worker
      // therefore completes the upload and records one durable publication,
      // instead of losing the provider id in a cancellation race.
      expect(seen).toContain("prepareYouTubeVideo");
      expect(seen).not.toContain("keepYouTubeUploadPrivate");
      expect(targetRow(backendDb, draftId)).toMatchObject({ status: "published", externalId: "yt-1" });
    });
  });

  it("creates an Instagram container on prepare and publishes it once it is ready", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["instagram_reels"]);

      await runVideoCycle(config, backendDb);

      expect(seen).toEqual(["prepareInstagramReel", "instagramContainerReady", "publishInstagramReel"]);
      expect(targetRow(backendDb, draftId)).toMatchObject({
        status: "published",
        externalId: "ig-reel",
        externalUrl: "https://www.instagram.com/reel/ig-reel/",
      });
    });
  });

  it("uses the draft locale's native Instagram credentials for an English Reel", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory, {
        INSTAGRAM_EN_ACCESS_TOKEN: "en-token",
        INSTAGRAM_EN_USER_ID: "en-user",
      });
      const draftId = dueDraft(backendDb, directory, ["instagram_reels"], "en");

      await runVideoCycle(config, backendDb);

      expect(targetRow(backendDb, draftId)?.status).toBe("published");
      expect(instagramCredentialsSeen).toEqual([
        { token: "en-token", userId: "en-user" },
        { token: "en-token", userId: "en-user" },
        { token: "en-token", userId: "en-user" },
      ]);
    });
  });

  it("blocks only the connected video account whose credential circuit tripped", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory, {
        INSTAGRAM_EN_ACCESS_TOKEN: "en-token",
        INSTAGRAM_EN_USER_ID: "en-user",
      });
      const draftId = dueDraft(backendDb, directory, ["instagram_reels"], "en");
      recordAuthFailure(backendDb, "instagram_en");
      recordAuthFailure(backendDb, "instagram_en");
      recordAuthFailure(backendDb, "instagram_en");

      await runVideoCycle(config, backendDb);

      expect(seen).toHaveLength(0);
      expect(targetRow(backendDb, draftId)?.status).toBe("scheduled");
      expect(backendDb.db.select().from(videoJobs).where(eq(videoJobs.videoDraftId, draftId)).all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: "queued", attemptCount: 0 })]),
      );
    });
  });

  it("leaves the target prepared and retryable while the container is still processing", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["instagram_reels"]);
      containerReadyError = new publishers.InstagramContainerProcessingError("Instagram container IN_PROGRESS");

      await runVideoCycle(config, backendDb);

      expect(seen).not.toContain("publishInstagramReel");
      expect(targetRow(backendDb, draftId)?.status).toBe("prepared");
      // The publish job must survive for the next cycle rather than dead-end.
      const job = backendDb.db.select().from(videoJobs).where(eq(videoJobs.kind, "publish")).get();
      expect(job?.status).toBe("queued");
      expect(job?.lastError).toContain("IN_PROGRESS");
    });
  });

  it("routes a Zernio target to the provider instead of the Graph API", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = Object.assign(videoConfig(directory), { ZERNIO_API_KEY: "z".repeat(16) });
      registerChannel(backendDb, {
        platform: "instagram",
        locale: "ru",
        provider: "zernio",
        providerAccountId: "maru-account",
      });
      const draftId = dueDraft(backendDb, directory, ["instagram_reels"]);

      await runVideoCycle(config, backendDb);

      // Prepare is a local checkpoint for Zernio: publishing early would break
      // the schedule the creator chose.
      expect(seen).toEqual(["publishZernioInstagramReel"]);
      expect(targetRow(backendDb, draftId)).toMatchObject({ status: "published", providerPostId: "z-1", externalId: "ig-2" });
    });
  });

  it("does not call a Reel published while the platform has not confirmed it", async () => {
    reset();
    zernioReelResult = { providerPostId: "z-1", externalId: null, url: null };
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = Object.assign(videoConfig(directory), { ZERNIO_API_KEY: "z".repeat(16) });
      registerChannel(backendDb, { platform: "instagram", locale: "ru", provider: "zernio", providerAccountId: "maru-account" });
      const draftId = dueDraft(backendDb, directory, ["instagram_reels"]);

      await runVideoCycle(config, backendDb);

      // The provider's id is kept — it is what the reconciliation sweep asks
      // about — but the target waits for the platform instead of claiming a
      // publication no one has seen.
      expect(targetRow(backendDb, draftId)).toMatchObject({ status: "verification_required", providerPostId: "z-1", externalId: null });
      const job = backendDb.db.select().from(videoJobs).where(eq(videoJobs.kind, "publish")).get();
      expect(job?.status).toBe("verification_required");
    });
  });

  it("holds the outcome back while the provider still owes an answer", async () => {
    reset();
    zernioReelResult = { providerPostId: "z-1", externalId: null, url: null };
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = Object.assign(videoConfig(directory), { ZERNIO_API_KEY: "z".repeat(16) });
      registerChannel(backendDb, { platform: "instagram", locale: "ru", provider: "zernio", providerAccountId: "maru-account" });
      dueDraft(backendDb, directory, ["instagram_reels"]);

      await runVideoCycle(config, backendDb);

      // The provider takes a publication before the platform does. Announcing
      // the outcome here said "completed with 1 failed target" about a Reel the
      // sweep confirmed a minute later, and the waiting itself was a warning.
      const events = backendDb.db.select().from(publicationEvents).all();
      expect(events.filter((event) => event.eventType === "delivery.video.completed")).toEqual([]);
      const waiting = events.find((event) => event.eventType === "video.target.verification_required");
      expect(waiting?.severity).toBe("info");
    });
  });

  it("does not send a publication whose preparation failed for good", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["youtube_shorts"]);
      rmSync(path.join(directory, "clip-youtube_shorts.mp4"), { force: true });
      backendDb.db.update(videoJobs).set({ attemptCount: 3 }).where(eq(videoJobs.kind, "prepare")).run();

      await runVideoCycle(config, backendDb);

      // The publish job used to run anyway and fail with "upload has not
      // completed yet" — the consequence, which then replaced the real cause on
      // the card and sent the operator looking in the wrong place.
      const publish = backendDb.db.select().from(videoJobs).where(eq(videoJobs.kind, "publish")).get();
      expect(publish?.status).toBe("cancelled");
      expect(publish?.lastError).toContain("Video source was removed");
      expect(targetRow(backendDb, draftId)?.lastError).toContain("Video source was removed");
    });
  });

  it("spends only the single safe retry on an unknown video failure", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["youtube_shorts"]);
      rmSync(path.join(directory, "clip-youtube_shorts.mp4"), { force: true });
      backendDb.db.update(videoJobs).set({ attemptCount: 1 }).where(eq(videoJobs.kind, "prepare")).run();

      await runVideoCycle(config, backendDb);

      expect(seen).toHaveLength(0);
      expect(targetRow(backendDb, draftId)?.status).not.toBe("published");
      const job = backendDb.db.select().from(videoJobs).where(eq(videoJobs.kind, "prepare")).get();
      expect(job?.status).toBe("failed");
      expect(job?.attemptCount).toBe(2);
      expect(job?.lastError).toContain("Video source was removed");
    });
  });

  it("does nothing for a target that was already cancelled before the cycle", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["youtube_shorts"]);
      cancelVideo(backendDb, draftId, 24);

      await runVideoCycle(config, backendDb);

      expect(seen).toHaveLength(0);
    });
  });
});
