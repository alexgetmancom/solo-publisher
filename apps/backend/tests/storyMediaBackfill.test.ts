import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storyVariantPaths } from "../src/delivery/story-derivatives.js";
import { backfillStoryMedia } from "../src/operations/story-media-backfill.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function assetFile(dataDir: string, stem: string): string {
  const source = path.join(dataDir, `${stem}.jpg`);
  fs.writeFileSync(source, PNG_BYTES);
  return source;
}

describe("story media backfill", () => {
  it("renders what publishing would otherwise have to render itself", async () => {
    await withDb(
      async (backendDb) => {
        const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "story-backfill-")) });
        const source = assetFile(config.DATA_DIR, "abcdef0123456789abcdef11");
        backendDb.studioMediaAssets.insertIfAbsent({
          actorId: 1,
          kind: "photo",
          mimeType: "image/jpeg",
          filename: "photo.jpg",
          localPath: source,
          byteSize: PNG_BYTES.length,
          sha256: "abcdef0123456789abcdef11",
          source: "telegram",
          createdAt: new Date(0).toISOString(),
        });

        // Reporting changes nothing: the plan is what the operator reads before
        // spending an encode per source.
        const report = await backfillStoryMedia(backendDb, config, false, 25);
        expect(report.missing).toBe(1);
        expect(report.applied).toBe(false);
        expect(fs.existsSync(storyVariantPaths(config, source, false).standard)).toBe(false);

        const applied = await backfillStoryMedia(backendDb, config, true, 25);
        expect(applied.rendered).toBe(1);
        expect(applied.remaining).toBe(0);
        expect(fs.existsSync(storyVariantPaths(config, source, false).standard)).toBe(true);

        // Prepared is prepared: a second run has nothing to do and does not
        // re-encode what is already there.
        expect((await backfillStoryMedia(backendDb, config, true, 25)).missing).toBe(0);
      },
      ["telegram", "telegram_stories"],
    );
  });

  it("reports a source whose file is gone instead of failing on it", async () => {
    await withDb(
      async (backendDb) => {
        const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "story-backfill-gone-")) });
        backendDb.studioMediaAssets.insertIfAbsent({
          actorId: 1,
          kind: "photo",
          mimeType: "image/jpeg",
          filename: "photo.jpg",
          localPath: path.join(config.DATA_DIR, "abcdef0123456789abcdef12.jpg"),
          byteSize: 10,
          sha256: "abcdef0123456789abcdef12",
          source: "telegram",
          createdAt: new Date(0).toISOString(),
        });
        const report = await backfillStoryMedia(backendDb, config, true, 25);
        expect(report.source_file_gone).toBe(1);
        expect(report.missing).toBe(0);
      },
      ["telegram", "telegram_stories"],
    );
  });

  it("spends nothing for a Studio with no Story channel", async () => {
    await withDb(
      async (backendDb) => {
        const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "story-backfill-none-")) });
        assetFile(config.DATA_DIR, "abcdef0123456789abcdef13");
        const report = await backfillStoryMedia(backendDb, config, true, 25);
        expect(report.story_targets_connected).toBe(false);
        expect(report.applied).toBe(false);
      },
      ["telegram"],
    );
  });
});
