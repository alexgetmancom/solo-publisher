import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { classifyHooks } from "../src/analytics/collection/hook-types.js";
import { videoDrafts } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/** Nothing here reaches the model: without --apply the classifier only reads. */
const noFetch = (() => {
  throw new Error("the model must not be asked for a listing");
}) as unknown as typeof fetch;

describe("hook classification", () => {
  it("derives the opening of a script written before the column existed", async () => {
    await withDb(async (backendDb) => {
      const { draftId } = insertPublishedVideo(backendDb, {
        target: "youtube_shorts",
        publishedAt: new Date().toISOString(),
        label: "Older than the column",
      });
      // The shape migration 0025 left behind: a script, its source, and a null
      // opening no later write comes back for.
      backendDb.db
        .update(videoDrafts)
        .set({
          script: "Помнишь ту игру про такси?\n\nДальше идёт всё остальное, чего зритель в первые секунды не слышит.",
          scriptSource: "operator",
          openingLine: null,
        })
        .where(eq(videoDrafts.id, draftId))
        .run();

      const report = (await classifyHooks(backendDb, loadTestConfig(), noFetch, {
        apply: false,
        limit: 10,
        overwrite: false,
      })) as { candidates: number; sample: Array<{ ref: string; opening: string }> };

      expect(report.candidates).toBe(1);
      // The first paragraph, not the whole script: judging the script would be
      // a different question wearing the same name.
      expect(report.sample[0]).toEqual({ ref: `video:${draftId}`, opening: "Помнишь ту игру про такси?" });
    });
  });
});
