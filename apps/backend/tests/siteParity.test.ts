import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { siteUrlsForIndexNow } from "../src/delivery/site-content-index.js";
import { pingIndexNow } from "../src/delivery/site-index-now.js";
import { refreshPublicationStatus } from "../src/publishing/publication-status.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { registerTestChannels, TEXT_TEST_CHANNELS } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("site parity", () => {
  it("lists the published pages and deduplicates IndexNow submissions", async () => {
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
      const urls = siteUrlsForIndexNow(config, backendDb);
      expect(urls).toContain(`https://example.test/${postId}/english-title/`);
      const fetchImpl = mock(async () => new Response("", { status: 202 })) as unknown as typeof fetch;
      await pingIndexNow(config, urls, fetchImpl);
      await pingIndexNow(config, urls, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(existsSync(join(dir, "indexnow.json"))).toBe(true);
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
    // The runtime creates every data directory at boot (see data-dirs.ts).
    mkdirSync(config.SITE_PUBLIC_DIR, { recursive: true });
    const fetchImpl = mock(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(pingIndexNow(config, ["https://example.test/post"], fetchImpl)).rejects.toThrow("500");
    await expect(pingIndexNow(config, ["https://example.test/post"], fetchImpl)).rejects.toThrow("500");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
