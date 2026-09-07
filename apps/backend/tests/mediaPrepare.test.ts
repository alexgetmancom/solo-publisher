import { describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isProgressiveJpeg, prepareMediaItems, pruneMediaCache } from "../src/delivery/media-prepare.js";
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

describe("progressive JPEG detection", () => {
  // Meta's fetcher rejects a progressive JPEG with a subcode that reads as an
  // unreachable URL, so the encoding has to be recognised before it is staged.
  const jpeg = (sofMarker: number): Buffer =>
    Buffer.from([
      0xff,
      0xd8, // SOI
      0xff,
      0xe0,
      0x00,
      0x06,
      0x4a,
      0x46,
      0x49,
      0x46, // APP0, a segment to walk past
      0xff,
      sofMarker,
      0x00,
      0x0b,
      0x08,
      0x00,
      0x10,
      0x00,
      0x10,
      0x01,
      0x01,
      0x11,
      0x00,
      0xff,
      0xda,
      0x00,
      0x08,
      0x01,
      0x01,
      0x00,
      0x00,
      0x3f,
      0x00, // SOS
    ]);

  const writeFixture = (bytes: Buffer): string => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-jpeg-")), "image.jpg");
    fs.writeFileSync(file, bytes);
    return file;
  };

  it("recognises SOF2 as progressive", async () => {
    expect(await isProgressiveJpeg(writeFixture(jpeg(0xc2)))).toBe(true);
  });

  it("leaves a baseline JPEG alone", async () => {
    expect(await isProgressiveJpeg(writeFixture(jpeg(0xc0)))).toBe(false);
  });

  it("stops at the scan rather than walking entropy-coded data as segments", async () => {
    // Compressed bytes that happen to look like a marker must not be read as
    // one: the answer is settled by the segment table, which ends at the SOS.
    const withScanData = Buffer.concat([jpeg(0xc0), Buffer.from([0xff, 0xc2, 0x00, 0x11])]);
    expect(await isProgressiveJpeg(writeFixture(withScanData))).toBe(false);
  });

  it("treats a non-JPEG as nothing to re-encode", async () => {
    expect(await isProgressiveJpeg(writeFixture(Buffer.from([0x89, 0x50, 0x4e, 0x47])))).toBe(false);
  });
});
