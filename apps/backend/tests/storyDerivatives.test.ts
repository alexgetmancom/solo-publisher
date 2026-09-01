import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unsafeDb } from "../src/db/client.js";
import { studioMediaAssets } from "../src/db/schema.js";
import type { PublishMediaItem } from "../src/delivery/social/payload.js";
import { preparedStoryMedia, runStoryDerivativeCycle, storyVariantPaths } from "../src/delivery/story-derivatives.js";
import type { BackendConfig } from "../src/foundation/config.js";
import { withDb } from "./helpers/db.js";

function tempConfig(): BackendConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "story-derivatives-"));
  return { DATA_DIR: dir } as unknown as BackendConfig;
}

describe("story derivatives", () => {
  it("names a variant after the content its source is named for", () => {
    const config = tempConfig();
    const paths = storyVariantPaths(config, "/data/media/42/abcdef0123456789abcdef01.mp4", true);
    expect(path.basename(paths.standard)).toBe("abcdef0123456789abcdef01-story-standard.mp4");
    expect(paths.telegram && path.basename(paths.telegram)).toBe("abcdef0123456789abcdef01-story-telegram.mp4");
    // An image has no Telegram-specific encode; the standard one is the only shape.
    expect(storyVariantPaths(config, "/data/media/42/abcdef0123456789abcdef01.jpg", false).telegram).toBeUndefined();
  });

  it("offers a prepared variant only once the file is actually there", async () => {
    const config = tempConfig();
    const source = path.join(config.DATA_DIR, "abcdef0123456789abcdef01.jpg");
    await fs.promises.writeFile(source, "source");
    const item: PublishMediaItem = { type: "IMAGE", localPath: source };

    expect(preparedStoryMedia(config, item)).toBeNull();

    const paths = storyVariantPaths(config, source, false);
    await fs.promises.mkdir(path.dirname(paths.standard), { recursive: true });
    await fs.promises.writeFile(paths.standard, "variant");
    const prepared = preparedStoryMedia(config, item);
    expect(prepared?.storyLocalPath).toBe(paths.standard);
    expect(prepared?.story_local_path).toBe(paths.standard);
    expect(prepared?.story_width).toBe(1080);
  });

  it("treats a vanished artefact as never prepared, so publishing renders it again", async () => {
    const config = tempConfig();
    const source = path.join(config.DATA_DIR, "abcdef0123456789abcdef02.jpg");
    await fs.promises.writeFile(source, "source");
    const item: PublishMediaItem = { type: "IMAGE", localPath: source };
    const paths = storyVariantPaths(config, source, false);
    await fs.promises.mkdir(path.dirname(paths.standard), { recursive: true });
    await fs.promises.writeFile(paths.standard, "variant");
    expect(preparedStoryMedia(config, item)).not.toBeNull();

    // Retrying a publication must never depend on a file having survived.
    await fs.promises.rm(paths.standard);
    expect(preparedStoryMedia(config, item)).toBeNull();
  });

  it("has nothing to offer for media that arrived without a local file", () => {
    const config = tempConfig();
    expect(preparedStoryMedia(config, { type: "IMAGE", fileId: "telegram-file" })).toBeNull();
  });

  it("prepares nothing for a Studio that publishes no Stories", () =>
    withDb(async (backendDb) => {
      const config = { ...tempConfig(), MEDIA_PROCESSOR_PROVIDER: "remote_http" } as BackendConfig;
      const localPath = path.join(config.DATA_DIR, `${"a".repeat(24)}.jpg`);
      await fs.promises.writeFile(localPath, "source");
      unsafeDb(backendDb)
        .db.insert(studioMediaAssets)
        .values({
          actorId: 1,
          kind: "image",
          mimeType: "image/jpeg",
          filename: "source.jpg",
          localPath,
          byteSize: 6,
          sha256: "a".repeat(64),
          source: "test",
          createdAt: "2026-01-01T00:00:00.000Z",
        })
        .run();
      // The operator's own selection, as the bot's default-targets screen holds
      // it: Telegram and Threads, no Story platform anywhere.
      backendDb.studioSettings.saveProfile({ defaultTargetsJson: ["telegram", "threads_ru"], updatedAt: "2026-01-01T00:00:00.000Z" });

      expect(await runStoryDerivativeCycle(config, backendDb, 2)).toEqual({ attempted: 0, prepared: 0 });

      // Ticking one is enough to make the same asset worth preparing again.
      backendDb.studioSettings.saveProfile({
        defaultTargetsJson: ["telegram", "instagram_stories_ru"],
        updatedAt: "2026-01-01T00:00:01.000Z",
      });
      expect((await runStoryDerivativeCycle(config, backendDb, 2)).attempted).toBe(1);
    }));

  it("limits failed preparations by attempts rather than successes", () =>
    withDb(async (backendDb) => {
      const config = { ...tempConfig(), MEDIA_PROCESSOR_PROVIDER: "remote_http" } as BackendConfig;
      const assets = await Promise.all(
        [1, 2, 3].map(async (index) => {
          const localPath = path.join(config.DATA_DIR, `${index.toString().repeat(24)}.jpg`);
          await fs.promises.writeFile(localPath, "source");
          return {
            actorId: 1,
            kind: "image",
            mimeType: "image/jpeg",
            filename: `source-${index}.jpg`,
            localPath,
            byteSize: 6,
            sha256: index.toString().repeat(64),
            source: "test",
            createdAt: `2026-01-01T00:00:0${index}.000Z`,
          };
        }),
      );
      unsafeDb(backendDb).db.insert(studioMediaAssets).values(assets).run();

      expect(await runStoryDerivativeCycle(config, backendDb, 2)).toEqual({ attempted: 2, prepared: 0 });
    }));
});
