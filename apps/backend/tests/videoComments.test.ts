import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { collectYouTubeComments, collectZernioComments } from "../src/analytics/collection/video-comments.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { socialComments } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const now = "2026-09-05T12:00:00.000Z";

function youtubeThread(id: string, text: string, replyCount: number, inline: Array<[string, string]>) {
  return {
    id,
    snippet: {
      totalReplyCount: replyCount,
      topLevelComment: { snippet: { textDisplay: text, authorDisplayName: "@viewer", likeCount: 1, publishedAt: now } },
    },
    replies: { comments: inline.map(([replyId, replyText]) => ({ id: replyId, snippet: { textDisplay: replyText, publishedAt: now } })) },
  };
}

describe("video comment collection", () => {
  it("reads every page of a video's threads rather than the newest one", () =>
    withDb(async (backendDb) => {
      const { targetId } = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: now, externalId: "vid" });
      const calls: string[] = [];
      const fetchImpl = (async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        calls.push(url.searchParams.get("pageToken") ?? "first");
        return url.searchParams.get("pageToken")
          ? Response.json({ items: [youtubeThread("t2", "second page", 0, [])] })
          : Response.json({ nextPageToken: "page-2", items: [youtubeThread("t1", "first page", 0, [])] });
      }) as typeof fetch;

      expect(await collectYouTubeComments(backendDb, target(targetId, "vid"), "token", fetchImpl)).toBe(2);
      expect(calls).toEqual(["first", "page-2"]);
      // A page is the newest hundred. Stopping at the first one loses a busy
      // video's older comments permanently, because nothing goes back for them.
      expect(
        stored(backendDb, targetId)
          .map((row) => row.text)
          .sort(),
      ).toEqual(["first page", "second page"]);
    }));

  it("finishes a thread whose replies the listing only sampled", () =>
    withDb(async (backendDb) => {
      const { targetId } = insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: now, externalId: "vid" });
      const fetchImpl = (async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/comments"))
          return Response.json({ items: [{ id: "r6", snippet: { textDisplay: "sixth reply", publishedAt: now } }] });
        // The platform says six, and volunteers one: the rest need asking for.
        return Response.json({ items: [youtubeThread("t1", "root", 6, [["r1", "first reply"]])] });
      }) as typeof fetch;

      await collectYouTubeComments(backendDb, target(targetId, "vid"), "token", fetchImpl);

      const rows = stored(backendDb, targetId);
      expect(rows.find((row) => row.commentId === "t1")?.parentCommentId).toBeNull();
      expect(rows.find((row) => row.commentId === "r6")?.parentCommentId).toBe("t1");
      expect(rows.map((row) => row.commentId).sort()).toEqual(["r6", "t1"]);
    }));

  it("stores a provider's replies under the comment they answer", () =>
    withDb(async (backendDb) => {
      const { targetId } = insertPublishedVideo(backendDb, {
        target: "instagram_reels",
        publishedAt: now,
        deliveryProvider: "zernio",
        providerAccountId: "acct",
        providerPostId: "zpost",
      });
      const config = Object.assign(loadTestConfig({}), { ZERNIO_API_KEY: "z".repeat(16) });
      const fetchImpl = (async () =>
        Response.json({
          comments: [
            {
              id: "c1",
              message: "огонь",
              createdTime: now,
              likeCount: 2,
              replyCount: 1,
              from: { username: "viewer" },
              replies: [{ id: "c1r1", message: "спасибо", createdTime: now, from: { username: "marux" } }],
            },
          ],
          pagination: { hasMore: false },
        })) as unknown as typeof fetch;

      expect(await collectZernioComments(config, backendDb, target(targetId, ""), fetchImpl)).toBe(2);

      const rows = stored(backendDb, targetId);
      expect(rows.find((row) => row.commentId === "c1")).toMatchObject({ text: "огонь", author: "viewer", parentCommentId: null });
      expect(rows.find((row) => row.commentId === "c1r1")).toMatchObject({ text: "спасибо", parentCommentId: "c1" });
    }));
});

function target(id: number, externalId: string) {
  return { id, externalId, providerPostId: "zpost", providerAccountId: "acct", locale: "ru" as const };
}

function stored(backendDb: UnsafeBackendDb, targetId: number) {
  return backendDb.db.select().from(socialComments).where(eq(socialComments.videoTargetId, targetId)).all();
}
