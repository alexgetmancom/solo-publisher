import { describe, expect, it } from "bun:test";
import { publicationTargets } from "../src/db/schema.js";
import { recentPostComments } from "../src/engagement/post-comments.js";
import { collectThreadsReplies } from "../src/engagement/threads-replies.js";
import { withDb } from "./helpers/db.js";

const config = { THREADS_RU_ACCESS_TOKEN: "ru-token", THREADS_EN_ACCESS_TOKEN: "en-token" } as never;

/** The conversation edge returns the post beside its replies, and a reply names
 * what it answers. Both are what the flat store has to be built from. */
const conversation = {
  data: [
    { id: "1001", text: "the post itself", username: "alexgetmanru", timestamp: "2026-09-05T10:00:00+0000" },
    { id: "1002", text: "first reply", username: "reader", timestamp: "2026-09-05T10:05:00+0000", replied_to: { id: "1001" } },
    { id: "1003", text: "reply to a reply", username: "other", timestamp: "2026-09-05T10:09:00+0000", replied_to: { id: "1002" } },
    { id: "1004", username: "silent", timestamp: "2026-09-05T10:10:00+0000" },
  ],
};

describe("threads replies", () => {
  it("stores the conversation flat, without the post and without the empty reply", () =>
    withDb(async (backendDb) => {
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:412",
          target: "threads_ru",
          externalId: "1001",
          url: "https://www.threads.com/@alexgetmanru/post/xyz",
          updatedAt: "2026-09-05T09:00:00.000Z",
        })
        .run();
      const fetchImpl = (async (input: string | URL) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/v1.0/1001/conversation");
        expect(url.searchParams.get("access_token")).toBe("ru-token");
        return new Response(JSON.stringify(conversation), { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      const stored = await collectThreadsReplies(backendDb, config, "threads_ru", ["1001"], fetchImpl);
      expect(stored).toBe(2);

      const [discussion] = recentPostComments(backendDb, 10);
      expect(discussion?.publicationKey).toBe("post:412");
      expect(discussion?.target).toBe("threads_ru");
      expect(discussion?.comments).toEqual([
        {
          commentId: "1002",
          author: "reader",
          text: "first reply",
          sentAt: "2026-09-05T10:05:00.000Z",
          edited: false,
          // A reply to the post has no parent comment.
          replyToCommentId: null,
        },
        {
          commentId: "1003",
          author: "other",
          text: "reply to a reply",
          sentAt: "2026-09-05T10:09:00.000Z",
          edited: false,
          replyToCommentId: "1002",
        },
      ]);
    }));

  it("reads the English account with its own token", () =>
    withDb(async (backendDb) => {
      let seen = "";
      const fetchImpl = (async (input: string | URL) => {
        seen = new URL(String(input)).searchParams.get("access_token") ?? "";
        return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      await collectThreadsReplies(backendDb, config, "threads_en", ["2002"], fetchImpl);
      expect(seen).toBe("en-token");
    }));

  it("does nothing at all without a token", () =>
    withDb(async (backendDb) => {
      const fetchImpl = (() => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch;
      expect(await collectThreadsReplies(backendDb, {} as never, "threads_ru", ["1"], fetchImpl)).toBe(0);
    }));
});
