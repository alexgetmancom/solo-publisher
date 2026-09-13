import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { videoTargets } from "../src/db/schema.js";
import { backfillYouTubeCaptions } from "../src/operations/youtube-captions.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { registerTestChannels } from "./helpers/channels.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/** A candidate never reaches the network here: without --apply the command
 * lists tracks, and a video that is not a candidate is never asked about. */
const noFetch = (() => {
  throw new Error("a video on a closed channel must not be asked about");
}) as unknown as typeof fetch;

function published(backendDb: Parameters<typeof insertPublishedVideo>[0], locale: "ru" | "en"): number {
  const { draftId, targetId } = insertPublishedVideo(backendDb, {
    target: "youtube_shorts",
    publishedAt: new Date(Date.now() - 72 * 3_600_000).toISOString(),
    label: `Published ${locale}`,
    locale,
  });
  backendDb.db
    .update(videoTargets)
    .set({ externalId: `yt-${draftId}` })
    .where(eq(videoTargets.id, targetId))
    .run();
  return draftId;
}

describe("caption backfill", () => {
  it("leaves alone the videos of a channel that was turned off", async () => {
    await withDb(async (backendDb) => {
      // Only the Russian channel is connected; the English one is not.
      registerTestChannels(backendDb, ["youtube_ru"]);
      published(backendDb, "en");

      const report = (await backfillYouTubeCaptions(backendDb, loadTestConfig(), noFetch, {
        apply: false,
        limit: 10,
        refresh: false,
      })) as { candidates: number };

      // There is no credential to ask with, and a token failure per video reads
      // as a broken connection rather than as a channel someone closed.
      expect(report.candidates).toBe(0);
    });
  });
});
