import { describe, expect, it } from "bun:test";
import { publicationTargets } from "../src/db/schema.js";
import { recentPostComments } from "../src/engagement/post-comments.js";
import { backfillThreadsReplies, collectThreadsReplies } from "../src/engagement/threads-replies.js";
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

describe("threads reply backfill", () => {
  const page = (data: unknown[], next?: string) => JSON.stringify({ data, ...(next ? { paging: { next } } : {}) });

  it("follows the paging and leaves the Studio's own chain replies out", () =>
    withDb(async (backendDb) => {
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:1", target: "threads_ru", externalId: "500", updatedAt: "2026-09-01T00:00:00.000Z" })
        .run();
      const calls: string[] = [];
      const fetchImpl = (async (input: string | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname.endsWith("/me")) return new Response(JSON.stringify({ username: "alexgetmanru" }));
        if (url.searchParams.get("cursor") === "2")
          return new Response(page([{ id: "c3", text: "third", username: "reader", timestamp: "2026-09-02T10:00:00+0000" }]));
        return new Response(
          page(
            [
              // The post's own author continuing the chain: not the audience.
              { id: "c1", text: "part two of my own thread", username: "alexgetmanru", timestamp: "2026-09-02T09:00:00+0000" },
              { id: "c2", text: "second", username: "someone", timestamp: "2026-09-02T09:30:00+0000" },
            ],
            "https://graph.threads.net/v1.0/500/conversation?cursor=2&access_token=ru-token",
          ),
        );
      }) as unknown as typeof fetch;

      const report = await backfillThreadsReplies(backendDb, config, "threads_ru", fetchImpl, { pause: async () => {} });
      expect(report.skippedAuthor).toBe("alexgetmanru");
      expect(report.posts).toBe(1);
      expect(report.visited).toBe(1);
      expect(report.stored).toBe(2);
      expect(report.stoppedEarly).toBeNull();
      const texts = recentPostComments(backendDb, 10)[0]?.comments.map((comment) => comment.text);
      expect(texts).toEqual(["second", "third"]);
    }));

  it("stops on the first throttle instead of spending more of the limit", () =>
    withDb(async (backendDb) => {
      for (const id of ["600", "601", "602"])
        backendDb.db
          .insert(publicationTargets)
          .values({ publicationKey: `post:${id}`, target: "threads_ru", externalId: id, updatedAt: "2026-09-01T00:00:00.000Z" })
          .run();
      let conversations = 0;
      const fetchImpl = (async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/me")) return new Response(JSON.stringify({ username: "alexgetmanru" }));
        conversations += 1;
        if (conversations > 1)
          return new Response(JSON.stringify({ error: { message: "Application request limit reached", code: 4 } }), { status: 400 });
        return new Response(page([{ id: "x1", text: "hi", username: "reader", timestamp: "2026-09-02T09:00:00+0000" }]));
      }) as unknown as typeof fetch;

      const report = await backfillThreadsReplies(backendDb, config, "threads_ru", fetchImpl, { pause: async () => {} });
      expect(report.stoppedEarly).toBe("throttled");
      expect(report.visited).toBe(1);
      expect(report.stored).toBe(1);
      // Two of the three were never asked for: the point of stopping.
      expect(conversations).toBe(2);
    }));
});
