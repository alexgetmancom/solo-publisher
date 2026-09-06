import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { videoDrafts } from "../src/db/schema.js";
import { updateVideoScript } from "../src/publishing/video-service.js";
import { VIDEO_FLOW } from "../src/studio/video-fsm.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";

describe("video script", () => {
  it("is asked right after the upload, and the wizard goes on from it", () => {
    const step = VIDEO_FLOW.steps.script;
    expect(step?.input).toBe("text");
    // The upload leads into it, and it leads into the metadata: a field
    // reachable only from an edit menu was filled on one video in three
    // hundred.
    expect(VIDEO_FLOW.steps.asset?.next({})).toBe("script");
    expect(step?.next({ selectedTargets: ["youtube_shorts"] })).toBe("youtube_title");
    expect(step?.next({ selectedTargets: ["instagram_reels"] })).toBe("instagram_caption");
  });

  it("stores a script for a video that has already been published", async () => {
    await withDb(async (backendDb) => {
      const { draftId } = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: new Date().toISOString() });

      updateVideoScript(backendDb, draftId, "  Ты потеряешь всё за секунду!\n\nЭто новый кооп-хоррор.  ");

      const draft = backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, draftId)).get();
      expect(draft?.script).toBe("Ты потеряешь всё за секунду!\n\nЭто новый кооп-хоррор.");
      // A published video is exactly the one whose opening is worth knowing,
      // so this write is not gated on the draft still being editable.
      expect(draft?.status).toBe("published");
    });
  });

  it("clears the script when an empty one is stored", async () => {
    await withDb(async (backendDb) => {
      const { draftId } = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: new Date().toISOString() });
      updateVideoScript(backendDb, draftId, "текст");
      updateVideoScript(backendDb, draftId, "   ");
      expect(backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, draftId)).get()?.script).toBeNull();
    });
  });
});
