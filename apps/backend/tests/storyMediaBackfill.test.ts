import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storyVariantPaths } from "../src/delivery/story-derivatives.js";
import { backfillStoryMedia } from "../src/operations/story-media-backfill.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function assetFile(dataDir: string, stem: string): string {
  const source = path.join(dataDir, `${stem}.jpg`);
  fs.writeFileSync(source, PNG_BYTES);
  return source;
}

describe("story media backfill", () => {
  it("renders what a Story publication would otherwise refuse for", async () => {
    await withDb(
      async (backendDb) => {
        const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "story-backfill-")) });
        const source = assetFile(config.DATA_DIR, "abcdef0123456789abcdef11");
        // A draft that publishes a Story and points at this file: exactly the
        // publication that would arrive at delivery and find nothing.
        createStudioServices(backendDb, config).posts.create(
          1,
          { text: "текст", media: [{ type: "photo", local_path: source }], entities: [] },
          { targets: ["telegram"] },
        );
        const draftId = createStudioServices(backendDb, config).posts.list(1)[0]?.id ?? 0;
        createStudioServices(backendDb, config).posts.toggleTarget(1, draftId, "telegram_stories");
        // The draft's own preparation is the fast path; this test is about the
        // repair, so start from a variant that is not there.
        await fs.promises.rm(storyVariantPaths(config, source, false).standard, { force: true });

        const report = await backfillStoryMedia(backendDb, config, false, 25);
        expect(report.missing_wanted).toBe(1);
        expect(report.missing_unused).toBe(0);
        expect(report.applied).toBe(false);

        const applied = await backfillStoryMedia(backendDb, config, true, 25);
        expect(applied.rendered).toBe(1);
        expect(applied.remaining).toBe(0);
        expect(fs.existsSync(storyVariantPaths(config, source, false).standard)).toBe(true);
        expect((await backfillStoryMedia(backendDb, config, true, 25)).missing_wanted).toBe(0);
      },
      ["telegram", "telegram_stories"],
    );
  });

  it("leaves media no draft has asked a Story of alone, until it is asked for", async () => {
    await withDb(
      async (backendDb) => {
        const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "story-backfill-unused-")) });
        const source = assetFile(config.DATA_DIR, "abcdef0123456789abcdef14");
        backendDb.studioMediaAssets.insertIfAbsent({
          actorId: 1,
          kind: "photo",
          mimeType: "image/jpeg",
          filename: "photo.jpg",
          localPath: source,
          byteSize: PNG_BYTES.length,
          sha256: "abcdef0123456789abcdef14",
          source: "telegram",
          createdAt: new Date(0).toISOString(),
        });

        // An imported file nobody has pointed at a Story: reported, not encoded.
        // A Studio that posts to Stories now and then would otherwise pay 8-12
        // seconds per video for a decision that was never made.
        const report = await backfillStoryMedia(backendDb, config, true, 25);
        expect(report.missing_unused).toBe(1);
        expect(report.missing_wanted).toBe(0);
        expect(report.applied).toBe(false);
        expect(fs.existsSync(storyVariantPaths(config, source, false).standard)).toBe(false);

        const everything = await backfillStoryMedia(backendDb, config, true, 25, true);
        expect(everything.rendered).toBe(1);
        expect(fs.existsSync(storyVariantPaths(config, source, false).standard)).toBe(true);
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
        const report = await backfillStoryMedia(backendDb, config, true, 25, true);
        expect(report.source_file_gone).toBe(1);
        expect(report.missing_wanted).toBe(0);
        expect(report.missing_unused).toBe(0);
      },
      ["telegram", "telegram_stories"],
    );
  });

  it("spends nothing for a Studio with no Story channel", async () => {
    await withDb(
      async (backendDb) => {
        const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "story-backfill-none-")) });
        assetFile(config.DATA_DIR, "abcdef0123456789abcdef13");
        const report = await backfillStoryMedia(backendDb, config, true, 25, true);
        expect(report.story_targets_connected).toBe(false);
        expect(report.applied).toBe(false);
      },
      ["telegram"],
    );
  });
});
