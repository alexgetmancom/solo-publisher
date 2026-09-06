import { describe, expect, it } from "bun:test";
import { editorialReview } from "../src/analytics/reports/editorial-review.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { socialComments, videoMetricSnapshots } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const sampledAt = "2026-07-27T09:00:00.000Z";
const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "t", DEEPSEEK_API_KEY: "sk-test" });

function comment(backendDb: UnsafeBackendDb, targetId: number, text: string, publishedAt: string): void {
  backendDb.db
    .insert(socialComments)
    .values({ platform: "youtube", commentId: `${text}-${publishedAt}`, videoTargetId: targetId, text, publishedAt, fetchedAt: sampledAt })
    .run();
}

describe("editorial review", () => {
  it("hands the model the channel's numbers as well as its comments", async () => {
    await withDb(async (backendDb) => {
      const { targetId } = insertPublishedVideo(backendDb, {
        target: "youtube_shorts",
        publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
        label: "Кооп-хоррор",
      });
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({ videoTargetId: targetId, platform: "youtube_shorts", metricsJson: { views: 4000 }, sampledAt })
        .run();
      comment(backendDb, targetId, "как называется игра?", sampledAt);

      let sentBody = "";
      const impl = (async (_url: string, init?: RequestInit) => {
        sentBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ choices: [{ message: { content: "  разбор  " } }] }));
      }) as unknown as typeof fetch;

      const report = await editorialReview(backendDb, config, "ru", impl);
      const payload = JSON.parse(sentBody) as { messages: Array<{ role: string; content: string }> };
      const user = payload.messages.find((message) => message.role === "user")?.content ?? "";
      // The numbers travel with the words: the previous report sent comments alone.
      expect(user).toContain("CHANNEL NUMBERS");
      expect(user).toContain("nextSteps");
      // A comment arrives with the video it sits under.
      expect(user).toContain("youtube | Кооп-хоррор | как называется игра?");
      // The model is told what it may not do with them.
      expect(payload.messages[0]?.content).toContain("Never invent a metric");
      // The report is written in the language that was asked for.
      expect(user).toContain("ANSWER IN: Russian");
      expect(report).toContain("Разбор канала");
      expect(report).toContain("разбор");
    });
  });

  it("says the feature is unavailable without an API key, and does not call out", async () => {
    await withDb(async (backendDb) => {
      let called = false;
      const impl = (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch;
      const noKey = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "t" });

      expect(await editorialReview(backendDb, noKey, "ru", impl)).toContain("DEEPSEEK_API_KEY");
      expect(called).toBe(false);
    });
  });
});
