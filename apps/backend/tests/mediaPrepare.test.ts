import { describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareMediaItems, pruneMediaCache } from "../src/delivery/media-prepare.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("media preparation", () => {
  it("reuses durable local and public files for identical target uploads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-media-race-"));
    const config = loadTestConfig({
      CONTROLLER_BOT_TOKEN: "token",
      TELEGRAM_API_BASE_URL: "https://telegram.local",
      DATA_DIR: dir,
      PUBLIC_MEDIA_BASE_URL: "https://example.com/media",
    });
    const fetchImpl = mock(async (input: string | URL | Request) =>
      String(input).includes("getFile")
        ? new Response(JSON.stringify({ ok: true, result: { file_path: "photos/source.jpg" } }), { status: 200 })
        : new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      const source = [{ type: "IMAGE" as const, fileId: "same-file-id" }];
      const [first, second] = await Promise.all([
        prepareMediaItems(config, source, fetchImpl),
        prepareMediaItems(config, source, fetchImpl),
      ]);
      expect(first[0]?.localPath).toBe(second[0]?.localPath);
      expect(first[0]?.vpsUrl).toBe(second[0]?.vpsUrl);
      expect(fs.existsSync(String(first[0]?.localPath))).toBe(true);
      expect(fs.existsSync(String(second[0]?.localPath))).toBe(true);
      expect(fs.existsSync(String(second[0]?.vpsUrl).replace("https://example.com/media/", `${config.REMOTE_MEDIA_PATH}/`))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes only expired managed cache files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-media-prune-"));
    try {
      const config = loadTestConfig({
        DATA_DIR: dir,
      });
      fs.mkdirSync(config.MEDIA_CACHE_DIR, { recursive: true });
      fs.mkdirSync(config.REMOTE_MEDIA_PATH, { recursive: true });
      const cached = path.join(config.MEDIA_CACHE_DIR, "asset.jpg");
      const publicCached = path.join(config.REMOTE_MEDIA_PATH, "cache-asset.jpg");
      const unrelated = path.join(config.REMOTE_MEDIA_PATH, "editorial.jpg");
      for (const file of [cached, publicCached, unrelated]) fs.writeFileSync(file, "x");
      // Comfortably past the 24h cache TTL, which is a constant now.
      const old = new Date(Date.now() - 48 * 60 * 60_000);
      for (const file of [cached, publicCached, unrelated]) fs.utimesSync(file, old, old);
      expect(await pruneMediaCache(config)).toBe(2);
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
