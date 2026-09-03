import { describe, expect, it } from "bun:test";
import { publicationTargets } from "../src/db/schema.js";
import { type DiscussionMessage, recentDiscussions, recordDiscussionMessage } from "../src/engagement/discussion-comments.js";
import { withDb } from "./helpers/db.js";

const CHANNEL = "@alexgetmancom";
const CHAT = -100123;

const message = (over: Partial<DiscussionMessage> & Pick<DiscussionMessage, "messageId">): DiscussionMessage => ({
  chatId: CHAT,
  chatType: "supergroup",
  date: new Date("2026-09-03T10:00:00.000Z"),
  ...over,
});

/** The forward the channel bot drops into the group when a post goes out. */
const forward = (threadId: number, channelPostId: number) =>
  message({
    messageId: threadId,
    isAutomaticForward: true,
    forwardOrigin: { chatUsername: "alexgetmancom", messageId: channelPostId },
  });

describe("discussion comments", () => {
  it("binds a comment to the channel post its thread was opened by", () =>
    withDb((backendDb) => {
      expect(recordDiscussionMessage(backendDb, CHANNEL, forward(50, 4321))).toBe("thread");
      const outcome = recordDiscussionMessage(
        backendDb,
        CHANNEL,
        message({ messageId: 51, threadId: 50, replyToMessageId: 50, authorId: 7, authorName: "Reader", text: "nice one" }),
      );
      expect(outcome).toBe("comment");
      const [discussion] = recentDiscussions(backendDb);
      expect(discussion?.channelPostId).toBe("4321");
      expect(discussion?.comments).toEqual([
        { messageId: 51, author: "Reader", text: "nice one", sentAt: "2026-09-03T10:00:00.000Z", edited: false, replyToMessageId: null },
      ]);
    }));

  it("names the publication a discussed post belongs to", () =>
    withDb((backendDb) => {
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:160",
          target: "telegram",
          externalId: "4321",
          url: "https://t.me/alexgetmancom/4321",
          updatedAt: "2026-09-03T09:00:00.000Z",
        })
        .run();
      recordDiscussionMessage(backendDb, CHANNEL, forward(50, 4321));
      recordDiscussionMessage(backendDb, CHANNEL, message({ messageId: 51, threadId: 50, text: "hi" }));
      const [discussion] = recentDiscussions(backendDb);
      expect(discussion?.publicationKey).toBe("post:160");
      expect(discussion?.url).toBe("https://t.me/alexgetmancom/4321");
    }));

  it("keeps a comment whose thread was opened before the bot arrived, and binds it when the forward is seen", () =>
    withDb((backendDb) => {
      // No forward yet, and this comment answers another comment rather than
      // the post, so nothing on it names the channel post.
      expect(
        recordDiscussionMessage(backendDb, CHANNEL, message({ messageId: 60, threadId: 50, replyToMessageId: 55, text: "late" })),
      ).toBe("unbound");
      expect(recentDiscussions(backendDb)).toEqual([]);
      recordDiscussionMessage(backendDb, CHANNEL, forward(50, 4321));
      const [discussion] = recentDiscussions(backendDb);
      expect(discussion?.channelPostId).toBe("4321");
      expect(discussion?.comments.map((comment) => comment.text)).toEqual(["late"]);
    }));

  it("reads the post from the forward a top-level comment answers", () =>
    withDb((backendDb) => {
      const outcome = recordDiscussionMessage(
        backendDb,
        CHANNEL,
        message({
          messageId: 61,
          threadId: 50,
          replyToMessageId: 50,
          replyToIsAutomaticForward: true,
          replyToForwardMessageId: 4321,
          text: "first",
        }),
      );
      expect(outcome).toBe("comment");
      expect(recentDiscussions(backendDb)[0]?.channelPostId).toBe("4321");
    }));

  it("rewrites the text on an edit and says the comment was edited", () =>
    withDb((backendDb) => {
      recordDiscussionMessage(backendDb, CHANNEL, forward(50, 4321));
      recordDiscussionMessage(backendDb, CHANNEL, message({ messageId: 51, threadId: 50, authorName: "Reader", text: "typo" }));
      recordDiscussionMessage(
        backendDb,
        CHANNEL,
        message({
          messageId: 51,
          threadId: 50,
          authorName: "Reader",
          text: "fixed",
          edited: true,
          date: new Date("2026-09-03T11:00:00.000Z"),
        }),
      );
      const comments = recentDiscussions(backendDb)[0]?.comments ?? [];
      expect(comments).toHaveLength(1);
      expect(comments[0]?.text).toBe("fixed");
      expect(comments[0]?.edited).toBe(true);
    }));

  it("ignores what is not the channel's discussion", () =>
    withDb((backendDb) => {
      // A private chat: the operator talking to the bot.
      expect(recordDiscussionMessage(backendDb, CHANNEL, message({ messageId: 1, chatType: "private", text: "hi" }))).toBe("ignored");
      // Someone else's channel forwarded into the same group.
      expect(
        recordDiscussionMessage(
          backendDb,
          CHANNEL,
          message({ messageId: 70, isAutomaticForward: true, forwardOrigin: { chatUsername: "someoneelse", messageId: 9 } }),
        ),
      ).toBe("ignored");
      // Group chatter outside any post's thread.
      expect(recordDiscussionMessage(backendDb, CHANNEL, message({ messageId: 71, text: "unrelated" }))).toBe("ignored");
      expect(recentDiscussions(backendDb)).toEqual([]);
    }));
});
