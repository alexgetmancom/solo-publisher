import { describe, expect, it } from "bun:test";
import { createStudioServices } from "../src/studio/services/index.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });

/** A thread post longer than Threads takes was accepted as written and only
 * refused at publish time, with nothing on the card to fix it. */
describe("thread posts", () => {
  it("cuts an overlong post into as many posts as it takes, the media on the first", () =>
    withDb(async (backendDb) => {
      seedTextPost(backendDb, { draftId: 12, postId: 1200, actorId: 42, status: "draft", targets: { threads_ru: true }, ru: "Первый" });
      const posts = createStudioServices(backendDb, config).posts;
      const photo = { type: "photo", fileId: "f" };
      posts.appendThreadPart(42, 12, { textRu: `${"а ".repeat(300)}конец`, entitiesRu: [], media: [photo] });
      const thread = backendDb.threadParts.list(12);
      expect(thread.map((part) => part.position)).toEqual([2, 3]);
      expect(thread.every((part) => part.textRu.length <= 500)).toBe(true);
      expect(thread.map((part) => part.media.length)).toEqual([1, 0]);

      posts.editThreadPart(42, 12, 2, { textRu: "Короткий", entitiesRu: [], media: [] });
      expect(backendDb.threadParts.list(12).map((part) => part.textRu.slice(0, 8))).toEqual([
        "Короткий",
        thread[1]?.textRu.slice(0, 8) ?? "",
      ]);
    }));

  it("splits the first post of an existing thread ahead of its other posts", () =>
    withDb(async (backendDb) => {
      seedTextPost(backendDb, {
        draftId: 12,
        postId: 1200,
        actorId: 42,
        status: "draft",
        targets: { threads_ru: true },
        ru: "б ".repeat(340),
      });
      const posts = createStudioServices(backendDb, config).posts;
      posts.appendThreadPart(42, 12, { textRu: "Хвост", entitiesRu: [], media: [] });
      posts.makeThread(42, 12);
      const thread = backendDb.threadParts.list(12);
      expect(thread.map((part) => part.textRu).at(-1)).toBe("Хвост");
      expect(thread).toHaveLength(2);
      expect((backendDb.drafts.get(12)?.text_ru ?? "").length).toBeLessThanOrEqual(500);
    }));
});
