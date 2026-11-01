import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { siteUrlsForIndexNow } from "../src/delivery/site-content-index.js";
import { pingIndexNow } from "../src/delivery/site-index-now.js";
import { refreshPublicationStatus } from "../src/publishing/publication-status.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { registerTestChannels, TEXT_TEST_CHANNELS } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("site parity", () => {
  it("retains an edit queued while an older revision of the same URL is in flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "indexnow-revisions-"));
    const config = loadTestConfig({ DATA_DIR: dir, PUBLIC_BASE_URL: "https://example.test", INDEXNOW_ENABLED: "true" });
    const replies: Array<(response: Response) => void> = [];
    const send = mock(() => new Promise<Response>((resolve) => replies.push(resolve))) as unknown as typeof fetch;
    try {
      const first = pingIndexNow(config, ["https://example.test/post"], send);
      const edited = pingIndexNow(config, ["https://example.test/post"], send);
      expect(replies).toHaveLength(1);
      replies[0]?.(new Response("", { status: 202 }));
      await first;
      await Bun.sleep(0);
      expect(replies).toHaveLength(2);
      expect(Object.keys(JSON.parse(readFileSync(join(dir, "indexnow.json"), "utf8")).pending_urls)).toEqual(["https://example.test/post"]);
      replies[1]?.(new Response("", { status: 200 }));
      await edited;
      expect(JSON.parse(readFileSync(join(dir, "indexnow.json"), "utf8")).pending_urls).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drains more than one IndexNow batch without losing URLs beyond the provider limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "indexnow-batches-"));
    const config = loadTestConfig({ DATA_DIR: dir, PUBLIC_BASE_URL: "https://example.test", INDEXNOW_ENABLED: "true" });
    const batches: string[][] = [];
    const send = (async (_input, init) => {
      batches.push(JSON.parse(String(init?.body)).urlList);
      return new Response("", { status: 202 });
    }) as typeof fetch;
    try {
      await pingIndexNow(
        config,
        Array.from({ length: 10_001 }, (_, i) => `https://example.test/post-${i}`),
        send,
      );
      expect(batches[0]).toHaveLength(10_000);
      await pingIndexNow(config, [], send);
      expect(batches[1]).toHaveLength(1);
      expect(new Set(batches.flat()).size).toBe(10_001);
      expect(JSON.parse(readFileSync(join(dir, "indexnow.json"), "utf8")).pending_urls).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("notifies only changed public pages and sends later edits at the same URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-site-parity-"));
    const backendDb = openBackendDb(join(dir, "pipeline.db"));
    registerTestChannels(backendDb, TEXT_TEST_CHANNELS);
    const config = loadTestConfig({
      DATA_DIR: dir,
      PUBLIC_BASE_URL: "https://example.test",
      INDEXNOW_ENABLED: "true",
    });
    try {
      const draft = createDraftFromMessage(backendDb, 1, { text: "Русский заголовок", textEn: "English title", media: [], entities: [] });
      const postId = publishDraftToQueue(backendDb, draft);
      backendDb.sqlite.prepare("UPDATE publish_jobs SET status='published' WHERE publication_key='post:'||?").run(postId);
      backendDb.sqlite.prepare("UPDATE site_jobs SET status='published' WHERE publication_key='post:'||?").run(postId);
      refreshPublicationStatus(backendDb, postId);
      seedTextPost(backendDb, { postId: postId + 1, en: "Unchanged post", siteEn: true, slugEn: "unchanged" });
      const urls = siteUrlsForIndexNow(config, backendDb, new Set([`post:${postId}`]));
      expect(urls).toHaveLength(2);
      expect(urls).toContain(`https://example.test/${postId}/english-title/`);
      expect(urls.some((url) => url.includes("unchanged"))).toBe(false);
      const send = mock(async (_input: string | URL | Request, _init?: RequestInit) => new Response("", { status: 202 }));
      const fetchImpl = send as unknown as typeof fetch;
      await pingIndexNow(config, [...urls, ...urls], fetchImpl);
      await pingIndexNow(config, urls, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body)).urlList).toEqual([...urls].sort());
      expect(existsSync(join(dir, "indexnow.json"))).toBe(true);
    } finally {
      backendDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes edits to older posts and respects the public feed's locale visibility", () => {
    const backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({ PUBLIC_BASE_URL: "https://example.test/" });
    try {
      for (let postId = 1; postId <= 201; postId++) {
        seedTextPost(backendDb, { postId, en: "Published post", siteEn: true });
      }
      seedTextPost(backendDb, { postId: 202, status: "scheduled", en: "Visible locale", siteEn: true });
      seedTextPost(backendDb, {
        postId: 203,
        en: "Future locale",
        siteEn: true,
        publishedAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      seedTextPost(backendDb, { postId: 204, en: "Disabled locale", siteEn: false });
      expect(siteUrlsForIndexNow(config, backendDb, new Set(["post:1", "post:202", "post:203", "post:204"]))).toEqual([
        "https://example.test/202/post-202-en/",
        "https://example.test/1/post-1-en/",
      ]);
      expect(siteUrlsForIndexNow(config, backendDb, new Set())).toEqual([]);
    } finally {
      backendDb.close();
    }
  });

  it("retries an IndexNow batch after a rejected response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-indexnow-"));
    const config = loadTestConfig({
      DATA_DIR: dir,
      PUBLIC_BASE_URL: "https://example.test",
      INDEXNOW_ENABLED: "true",
    });
    try {
      // The runtime creates every data directory at boot (see data-dirs.ts).
      mkdirSync(config.SITE_PUBLIC_DIR, { recursive: true });
      const fetchImpl = mock(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
      await expect(pingIndexNow(config, ["https://example.test/post"], fetchImpl)).rejects.toThrow("500");
      await expect(pingIndexNow(config, ["https://example.test/post"], fetchImpl)).rejects.toThrow("500");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
