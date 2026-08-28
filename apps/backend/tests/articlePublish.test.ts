import { describe, expect, it } from "bun:test";
import type { OperationContext } from "../src/operations/registry.js";
import { runOperation } from "../src/operations/registry.js";
import { registerTestChannels } from "./helpers/channels.js";
import { withDb } from "./helpers/db.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

function context(db: ReturnType<typeof openBackendDb>): OperationContext {
  return {
    dbPath: ":memory:",
    config: () => loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }),
    db: () => db,
    fetchImpl: fetch,
    actorType: "test",
  };
}

const markdown = "# How delivery settles\n\nA **bold** claim with a [link](https://example.com).";

async function publish(db: ReturnType<typeof openBackendDb>, overrides: Record<string, unknown> = {}) {
  return (await runOperation("article-publish", context(db), {
    locale: "en",
    targets: "x_article",
    markdown,
    ...overrides,
  })) as { article_id: number; ref: string; title: string };
}

describe("article-publish", () => {
  it("stores the article and queues it on the shared spine under an article key", async () => {
    const backendDb = openBackendDb(":memory:");
    registerTestChannels(backendDb, ["x"]);
    try {
      const result = await publish(backendDb);
      expect(result).toMatchObject({ title: "How delivery settles", ref: `article:${result.article_id}`, queued: true });

      const stored = backendDb.sqlite
        .query("SELECT title, slug, body_text, entities_json FROM article_locales WHERE article_id=?")
        .get(result.article_id) as { title: string; slug: string; body_text: string; entities_json: string };
      expect(stored.title).toBe("How delivery settles");
      expect(stored.slug).toBe("how-delivery-settles");
      // The heading left the body, and the markers left the text.
      expect(stored.body_text).toBe("A bold claim with a link.");
      expect(JSON.parse(stored.entities_json)).toEqual([
        { type: "bold", offset: 2, length: 4 },
        { type: "text_link", offset: 20, length: 4, url: "https://example.com" },
      ]);

      const jobs = backendDb.sqlite
        .query("SELECT target, publication_key, payload_json FROM publish_jobs WHERE publication_key='article:'||?")
        .all(result.article_id) as Array<{ target: string; publication_key: string; payload_json: string }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.target).toBe("x_article");
      expect(jobs[0]?.publication_key).toBe(`article:${result.article_id}`);
      expect(JSON.parse(jobs[0]?.payload_json ?? "{}")).toMatchObject({ title: "How delivery settles", locale: "en" });
    } finally {
      backendDb.close();
    }
  });

  it("refuses a target that carries posts rather than articles", async () => {
    const backendDb = openBackendDb(":memory:");
    registerTestChannels(backendDb, ["x"]);
    try {
      await expect(publish(backendDb, { targets: "x" })).rejects.toThrow(/does not carry articles/);
    } finally {
      backendDb.close();
    }
  });

  it("refuses a body with no title instead of taking the first line", async () => {
    const backendDb = openBackendDb(":memory:");
    registerTestChannels(backendDb, ["x"]);
    try {
      await expect(publish(backendDb, { markdown: "Just prose." })).rejects.toThrow(/needs a `# Title` heading/);
    } finally {
      backendDb.close();
    }
  });

  it("writes nothing when a target has no connected channel", () =>
    withDb(async (backendDb) => {
      await expect(publish(backendDb)).rejects.toThrow(/no connected channel/);
      expect(backendDb.sqlite.query("SELECT count(*) AS count FROM articles").get()).toEqual({ count: 0 });
    }));
});
