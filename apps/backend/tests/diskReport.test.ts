import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storyVariantPaths } from "../src/delivery/story-derivatives.js";
import { diskReport } from "../src/operations/disk-report.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("disk report", () => {
  it("counts a Story variant whose source is gone as an orphan", async () => {
    await withDb(async (backendDb) => {
      const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "disk-report-")) });
      const live = path.join(config.DATA_DIR, "abcdef0123456789abcdef31.jpg");
      const gone = path.join(config.DATA_DIR, "abcdef0123456789abcdef32.jpg");
      fs.writeFileSync(live, "source");
      for (const [index, source] of [live, gone].entries()) {
        const variant = storyVariantPaths(config, source, false).standard;
        fs.mkdirSync(path.dirname(variant), { recursive: true });
        fs.writeFileSync(variant, "variant".repeat(index + 1));
        backendDb.studioMediaAssets.insertIfAbsent({
          actorId: 1,
          kind: "photo",
          mimeType: "image/jpeg",
          filename: path.basename(source),
          localPath: source,
          byteSize: 6,
          sha256: path.basename(source, ".jpg"),
          source: "telegram",
          createdAt: new Date(0).toISOString(),
        });
      }

      const report = diskReport(backendDb, config) as {
        story_variants: { files: number; orphaned: number; orphaned_bytes: number; orphaned_files: string[] };
        directories: Array<{ name: string; files: number }>;
      };
      // Retention removes a source it is done with and leaves the shapes made
      // from it, so this is the count that says whether that is happening.
      expect(report.story_variants.files).toBe(2);
      expect(report.story_variants.orphaned).toBe(1);
      expect(report.story_variants.orphaned_files).toEqual(["abcdef0123456789abcdef32-story-standard.jpg"]);
      expect(report.story_variants.orphaned_bytes).toBe(14);
      expect(report.directories.some((entry) => entry.name === "story-media" && entry.files === 2)).toBe(true);
    });
  });
});
