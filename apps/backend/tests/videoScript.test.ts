import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { videoDrafts } from "../src/db/schema.js";
import { updateVideoScript } from "../src/publishing/video-service.js";
import { VIDEO_FLOW } from "../src/studio/video-fsm.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";

describe("video script", () => {
  it("is a step that ends on the card, like the rename and unlike the wizard", () => {
    const step = VIDEO_FLOW.steps.script;
    expect(step?.input).toBe("text");
    // Nothing follows it: a script is attached to a finished draft, never
    // asked for between the upload and the schedule.
    expect(step?.next({})).toBeNull();
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
