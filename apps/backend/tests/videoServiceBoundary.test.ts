import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { studioMediaAssets, studioNotificationJobs, videoJobs, videoTargets } from "../src/db/schema.js";
import type { BackendConfig } from "../src/foundation/config.js";
import { replaceVideoTargets } from "../src/publishing/video-service.js";
import { videoService } from "../src/studio/services/videos.js";
import { VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoDraft } from "./helpers/video.js";

type VideoFixture = {
  config: BackendConfig;
  directory: string;
  draftId: number;
};

let fixtureSequence = 0;

function fixture(backendDb: UnsafeBackendDb, targets = ["instagram_reels"]): VideoFixture {
  const directory = mkdtempSync(join(import.meta.dir, "video-service-boundary-"));
  const source = join(directory, "clip.mp4");
  const encoded = Bun.spawnSync([
    "ffmpeg",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=320x180:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-y",
    source,
  ]);
  if (encoded.exitCode !== 0) throw new Error(`video fixture encode failed: ${encoded.stderr.toString()}`);
  const now = new Date().toISOString();
  const asset = backendDb.db
    .insert(studioMediaAssets)
    .values({
      actorId: 42,
      kind: "video",
      mimeType: "video/mp4",
      filename: "clip.mp4",
      localPath: source,
      byteSize: 1,
      sha256: `video-service-boundary-${fixtureSequence++}`,
      source: "test_upload",
      createdAt: now,
    })
    .returning({ id: studioMediaAssets.id })
    .get();
  if (!asset) throw new Error("video fixture asset was not created");
  const draftId = createTestVideoDraft(backendDb, 42, asset.id, 24);
  replaceVideoTargets(backendDb, draftId, targets as ("youtube_shorts" | "instagram_reels")[]);
  const config = loadTestConfig({
    CONTROLLER_ADMIN_IDS: "42",
    INSTAGRAM_RU_ACCESS_TOKEN: "instagram-token",
    INSTAGRAM_RU_USER_ID: "instagram-user",
    STUDIO_MEDIA_DIR: directory,
    VIDEO_MEDIA_DIR: directory,
  });
  return { config, directory, draftId };
}

async function withFixture<T>(fn: (backendDb: UnsafeBackendDb, fixture: VideoFixture) => Promise<T> | T, targets?: string[]): Promise<T> {
  return withDb(async (backendDb) => {
    const current = fixture(backendDb, targets);
    try {
      return await fn(backendDb, current);
    } finally {
      rmSync(current.directory, { recursive: true, force: true });
    }
  }, VIDEO_TEST_CHANNELS);
}

describe("video Studio service boundary", () => {
  it("validates, schedules through the shared PublicationSchedule shape, and arms grouped reminders", async () => {
    await withFixture(async (backendDb, current) => {
      const service = videoService(backendDb, current.config);
      expect(service.list(42)).toHaveLength(1);
      expect(service.metadataEditableTargets(42, current.draftId)).toEqual(["instagram_reels"]);
      expect(await service.validate(42, current.draftId)).toEqual([]);
      expect((await service.technicalCheck(42, current.draftId)).videoCodec).toBe("h264");

      const publishAt = new Date(Date.now() + 90 * 60_000);
      const technical = await service.schedule(42, current.draftId, {
        values: { instagram_reels: publishAt, ignored_target: publishAt },
      });

      expect(technical.seconds).toBeGreaterThan(0);
      expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, current.draftId)).get()).toMatchObject({
        target: "instagram_reels",
        status: "scheduled",
        scheduledAt: publishAt.toISOString(),
        metadataJson: { videoDurationMs: technical.seconds * 1_000 },
      });
      expect(backendDb.db.select().from(videoJobs).where(eq(videoJobs.videoDraftId, current.draftId)).all()).toHaveLength(2);
      expect(backendDb.db.select().from(studioNotificationJobs).all()).toMatchObject([
        {
          ref: `video:${current.draftId}`,
          status: "queued",
          payloadJson: { targets: ["instagram_reels"] },
        },
      ]);
    });
  });

  it("publishes through the same scheduling path and rejects an owned draft with no targets", async () => {
    await withFixture(async (backendDb, current) => {
      const service = videoService(backendDb, current.config);
      await service.publish(42, current.draftId);
      expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, current.draftId)).get()).toMatchObject({
        status: "scheduled",
      });
      expect(backendDb.db.select().from(studioNotificationJobs).all()).toHaveLength(1);

      const empty = fixture(backendDb, ["instagram_reels"]);
      try {
        backendDb.db.delete(videoTargets).where(eq(videoTargets.videoDraftId, empty.draftId)).run();
        await expect(videoService(backendDb, current.config).publish(42, empty.draftId)).rejects.toThrow("err.video-choose-platforms");
      } finally {
        rmSync(empty.directory, { recursive: true, force: true });
      }
    });
  });

  it("replaces the source file of an unprepared draft and refuses once a target is prepared", async () => {
    await withFixture(async (backendDb, current) => {
      const service = videoService(backendDb, current.config);
      const publishAt = new Date(Date.now() + 90 * 60_000);
      await service.schedule(42, current.draftId, { instagram_reels: publishAt });
      expect(service.sourceReplaceable(42, current.draftId)).toBe(true);

      const replacement = join(current.directory, "replacement.mp4");
      const encoded = Bun.spawnSync([
        "ffmpeg",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x180:d=3",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-y",
        replacement,
      ]);
      if (encoded.exitCode !== 0) throw new Error(`replacement encode failed: ${encoded.stderr.toString()}`);
      const asset = backendDb.db
        .insert(studioMediaAssets)
        .values({
          actorId: 42,
          kind: "video",
          mimeType: "video/mp4",
          filename: "replacement.mp4",
          localPath: replacement,
          byteSize: 1,
          sha256: `video-service-boundary-replacement-${fixtureSequence++}`,
          source: "test_upload",
          createdAt: new Date().toISOString(),
        })
        .returning({ id: studioMediaAssets.id })
        .get();
      if (!asset) throw new Error("replacement asset was not created");

      const technical = await service.replaceSource(42, current.draftId, asset.id);
      expect(technical.seconds).toBe(3);
      expect(service.get(42, current.draftId).draft.studioMediaAssetId).toBe(asset.id);
      // The duration recorded at scheduling time describes the old file and
      // would otherwise survive the swap.
      expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, current.draftId)).get()).toMatchObject({
        metadataJson: { videoDurationMs: 3_000 },
      });

      backendDb.db.update(videoTargets).set({ status: "prepared" }).where(eq(videoTargets.videoDraftId, current.draftId)).run();
      expect(service.sourceReplaceable(42, current.draftId)).toBe(false);
      await expect(service.replaceSource(42, current.draftId, asset.id)).rejects.toThrow("err.video-source-locked");
    });
  });

  it("exposes status, history, metadata commands, retry, manual scheduling, and target toggles", async () => {
    await withFixture(async (backendDb, current) => {
      const service = videoService(backendDb, current.config);
      expect(service.status(42, current.draftId).jobs).toEqual([]);
      expect(service.history(42, current.draftId)).toEqual([]);
      service.updateMetadata(42, current.draftId, "instagram_reels", { caption: "caption" });
      service.editMetadataField(42, current.draftId, "instagram_caption", "new caption");
      service.completeWizardTarget(42, current.draftId, "instagram_reels", { instagram_caption: "wizard caption" }, ["instagram_reels"]);
      service.rename(42, current.draftId, "Renamed video");
      expect(service.get(42, current.draftId).draft.label).toBe("Renamed video");
      expect(service.manualSchedule(42, current.draftId, "23:15")).toBeInstanceOf(Date);

      const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, current.draftId)).get();
      if (!target) throw new Error("video target missing");
      backendDb.db.update(videoTargets).set({ status: "failed" }).where(eq(videoTargets.id, target.id)).run();
      expect(await service.retryTarget(42, current.draftId, "instagram_reels")).toEqual({ requeued: 1, alreadyQueued: 0 });

      const toggle = fixture(backendDb, ["youtube_shorts"]);
      try {
        const toggleService = videoService(backendDb, current.config);
        toggleService.toggleTarget(42, toggle.draftId, "instagram_reels");
        expect(toggleService.metadataEditableTargets(42, toggle.draftId)).toEqual(["youtube_shorts", "instagram_reels"]);
        toggleService.toggleTarget(42, toggle.draftId, "instagram_reels");
        expect(toggleService.metadataEditableTargets(42, toggle.draftId)).toEqual(["youtube_shorts"]);
      } finally {
        rmSync(toggle.directory, { recursive: true, force: true });
      }
    });
  });
});
