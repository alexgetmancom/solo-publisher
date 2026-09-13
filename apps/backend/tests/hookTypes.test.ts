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
      })) as { candidates: number; sample: Array<{ refs: string; opening: string }> };

      expect(report.candidates).toBe(1);
      // The first paragraph, not the whole script: judging the script would be
      // a different question wearing the same name.
      expect(report.sample[0]).toEqual({ refs: `video:${draftId}`, opening: "Помнишь ту игру про такси?" });
    });
  });
  it("judges one text once and labels every video that opens on it", async () => {
    await withDb(async (backendDb) => {
      const ids = [1, 2].map(
        (n) =>
          insertPublishedVideo(backendDb, {
            target: "youtube_shorts",
            publishedAt: new Date().toISOString(),
            label: `Twin ${n}`,
          }).draftId,
      );
      for (const id of ids)
        backendDb.db
          .update(videoDrafts)
          .set({ script: "Это самый подозрительный кооперативный хоррор.", scriptSource: "transcript" })
          .where(eq(videoDrafts.id, id))
          .run();
      // An interjection is not a line to judge, so it never becomes a candidate.
      const tiny = insertPublishedVideo(backendDb, {
        target: "youtube_shorts",
        publishedAt: new Date().toISOString(),
        label: "Interjection",
      }).draftId;
      backendDb.db.update(videoDrafts).set({ script: "Ух ты.", scriptSource: "transcript" }).where(eq(videoDrafts.id, tiny)).run();

      const report = (await classifyHooks(backendDb, loadTestConfig(), noFetch, {
        apply: false,
        limit: 10,
        overwrite: false,
      })) as { candidates: number; videos: number; sample: Array<{ refs: string }> };

      expect({ candidates: report.candidates, videos: report.videos }).toEqual({ candidates: 1, videos: 2 });
      // Newest first, the order the candidates are read in.
      expect(report.sample[0]?.refs).toBe(
        [...ids]
          .reverse()
          .map((id) => `video:${id}`)
          .join(" "),
      );
    });
  });
});
