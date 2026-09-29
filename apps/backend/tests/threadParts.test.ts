import { describe, expect, it } from "bun:test";
import { splitText } from "../src/content/text.js";
import { chainPosts, localizedThread } from "../src/content/thread.js";
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

  it("leaves the English of the other posts alone when one post is rewritten", () =>
    withDb(async (backendDb) => {
      seedTextPost(backendDb, { draftId: 12, postId: 1200, actorId: 42, status: "draft", targets: { threads_ru: true }, ru: "Первый" });
      const posts = createStudioServices(backendDb, config).posts;
      posts.appendThreadPart(42, 12, { textRu: "Второй", entitiesRu: [], media: [] });
      posts.appendThreadPart(42, 12, { textRu: "Третий", entitiesRu: [], media: [] });
      backendDb.threadParts.setEnglish(12, [
        { position: 2, textEn: "Second" },
        { position: 3, textEn: "Third" },
      ]);

      posts.editThreadPart(42, 12, 2, { textRu: "Второй, иначе", entitiesRu: [], media: [] });

      // The rewritten post loses its English, because it is no longer that
      // post's translation; its neighbour's is untouched and used to be wiped.
      expect(backendDb.threadParts.list(12).map((part) => part.textEn)).toEqual([null, "Third"]);
    }));

  it("lets the author write the English of one post, and no translation takes it back", () =>
    withDb(async (backendDb) => {
      seedTextPost(backendDb, { draftId: 12, postId: 1200, actorId: 42, status: "draft", targets: { threads_ru: true }, ru: "Первый" });
      const posts = createStudioServices(backendDb, config).posts;
      posts.appendThreadPart(42, 12, { textRu: "Второй", entitiesRu: [], media: [] });

      posts.editThreadPartEnglish(42, 12, 2, "Mine, not the machine's");
      backendDb.threadParts.setEnglish(12, [{ position: 2, textEn: "Second" }]);

      expect(localizedThread(backendDb.threadParts.list(12), "en").map((part) => part.text)).toEqual(["Mine, not the machine's"]);
      expect(() => posts.editThreadPartEnglish(42, 12, 9, "Nowhere")).toThrow("err.thread-part-missing");
    }));
});

describe("splitting a post into a chain", () => {
  it("cuts where a sentence ends rather than in the middle of one", () => {
    const first = "Мы починили разбивку тредов, и это заняло больше времени, чем хотелось.";
    const second = "Теперь английский режется так же, как русский!";
    const parts = splitText(`${first} ${second} ${"хвост ".repeat(20)}`.trim(), first.length + 20);
    expect(parts[0]).toBe(first);
  });

  it("gives every piece after the first no media and no entities of a text it no longer holds", () => {
    const posts = chainPosts(
      [{ text: `${"a".repeat(500)} tail`, entities: [{ type: "bold", offset: 0, length: 4 }], media: ["photo"] }],
      500,
    );
    expect(posts.map((post) => post.text)).toEqual(["a".repeat(500), "tail"]);
    expect(posts.map((post) => post.media)).toEqual([["photo"], []]);
    expect(posts[1]?.entities).toEqual([]);
  });
});
