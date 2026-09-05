import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureStoryDerivative, storyVariantPaths } from "../src/delivery/story-derivatives.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function mediaFile(dataDir: string, stem: string): string {
  const source = path.join(dataDir, `${stem}.jpg`);
  fs.writeFileSync(source, PNG_BYTES);
  return source;
}

/** Maru's shape, which is what this rule exists for: the only connected Story
 * channel is not in the Studio's default targets, so a draft is where a Story
 * is decided. */
describe("draft Story media", () => {
  it("prepares the media of a draft that publishes a Story, and nothing else", async () => {
    await withDb(
      async (backendDb) => {
        const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "draft-story-media-")) });
        const posts = createStudioServices(backendDb, config).posts;
        const source = mediaFile(config.DATA_DIR, "abcdef0123456789abcdef21");
        const variant = storyVariantPaths(config, source, false).standard;

        const draftId = posts.create(
          1,
          { text: "текст", media: [{ type: "photo", local_path: source }], entities: [] },
          { targets: ["telegram"] },
        );
        expect(fs.existsSync(variant)).toBe(false);

        // The Story target goes on after the draft exists, which is the case the
        // Studio's profile could never answer.
        posts.toggleTarget(1, draftId, "instagram_stories_ru");
        // The edit does not wait for the encode; this joins the render it started.
        await ensureStoryDerivative(config, source, false);
        expect(fs.existsSync(variant)).toBe(true);
      },
      ["telegram", "instagram_stories_ru"],
    );
  });

  it("spends no encode on a draft that publishes no Story", async () => {
    await withDb(
      async (backendDb) => {
        const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "draft-story-media-none-")) });
        const posts = createStudioServices(backendDb, config).posts;
        const source = mediaFile(config.DATA_DIR, "abcdef0123456789abcdef22");

        posts.create(1, { text: "текст", media: [{ type: "photo", local_path: source }], entities: [] }, { targets: ["telegram"] });
        await Bun.sleep(50);
        // A connected Story channel is not a reason on its own: this draft does
        // not go to one, and the encode it would cost is work nobody asked for.
        expect(fs.existsSync(storyVariantPaths(config, source, false).standard)).toBe(false);
      },
      ["telegram", "instagram_stories_ru"],
    );
  });
});
