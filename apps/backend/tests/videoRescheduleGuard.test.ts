import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { videoDrafts, videoJobs, videoTargets } from "../src/db/schema.js";
import { replaceVideoTargets, saveVideoMetadata, scheduleVideo, updateVideoLabel } from "../src/publishing/video-service.js";
import { videoService } from "../src/studio/services/videos.js";
import { VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { useBackendDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoDraft } from "./helpers/video.js";

const testDb = useBackendDb(VIDEO_TEST_CHANNELS);

function videoConfig() {
  const config = loadTestConfig({});
  return config;
}

const timing = { prepareLeadMinutes: 10 };

describe("video reschedule guard", () => {
  it("refuses to reschedule a platform that already published", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
    if (!target) throw new Error("target was not created");
    backendDb.db.update(videoTargets).set({ status: "published" }).where(eq(videoTargets.id, target.id)).run();

    expect(() => scheduleVideo(backendDb, draftId, { youtube_shorts: new Date(Date.now() + 3_600_000) }, timing, 24)).toThrow(
      "err.video-target-not-schedulable",
    );

    // The published target keeps its state and gains no second delivery pair.
    const after = backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, target.id)).get();
    expect(after?.status).toBe("published");
    expect(backendDb.db.select().from(videoJobs).where(eq(videoJobs.videoDraftId, draftId)).all()).toEqual([]);
  });

  it("still schedules a platform that has not been delivered", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);

    scheduleVideo(backendDb, draftId, { youtube_shorts: new Date(Date.now() + 3_600_000) }, timing, 24);

    const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
    expect(target?.status).toBe("scheduled");
    expect(
      backendDb.db
        .select()
        .from(videoJobs)
        .where(eq(videoJobs.videoDraftId, draftId))
        .all()
        .map((job) => job.kind)
        .sort(),
    ).toEqual(["prepare", "publish"]);
  });

  it("allows metadata and label changes while a scheduled platform is still waiting", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    scheduleVideo(backendDb, draftId, { youtube_shorts: new Date(Date.now() + 3_600_000) }, timing, 24);

    saveVideoMetadata(backendDb, draftId, "youtube_shorts", { title: "Changed", description: "", tags: [] });
    expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get()?.metadataJson).toEqual({
      title: "Changed",
      description: "",
      tags: [],
    });
    updateVideoLabel(backendDb, draftId, "Changed");
    expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get()?.metadataJson).toEqual({
      title: "Changed",
      description: "",
      tags: [],
    });
  });

  it("finishes a scheduled YouTube title edit instead of reporting a draft lock", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    scheduleVideo(backendDb, draftId, { youtube_shorts: new Date(Date.now() + 3_600_000) }, timing, 24);

    videoService(backendDb, videoConfig()).editMetadataField(42, draftId, "youtube_title", "Changed title");

    expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get()?.metadataJson).toMatchObject({
      title: "Changed title",
    });
    expect(backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, draftId)).get()?.label).toBe("Changed title");
  });

  it("blocks metadata changes after target preparation has started", () => {
    const backendDb = testDb.open();
    const draftId = createTestVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    scheduleVideo(backendDb, draftId, { youtube_shorts: new Date(Date.now() + 3_600_000) }, timing, 24);
    const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
    if (!target) throw new Error("target was not created");
    backendDb.db.update(videoTargets).set({ status: "prepared" }).where(eq(videoTargets.id, target.id)).run();

    expect(() => saveVideoMetadata(backendDb, draftId, "youtube_shorts", { title: "Changed", description: "", tags: [] })).toThrow(
      "err.video-metadata-locked",
    );
  });
});
