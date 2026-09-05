import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PublishMediaItem } from "../src/delivery/social/payload.js";
import { ensureStoryDerivative, preparedStoryMedia, storyVariantPaths } from "../src/delivery/story-derivatives.js";
import type { BackendConfig } from "../src/foundation/config.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

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

  it("treats a vanished artefact as not prepared", async () => {
    const config = tempConfig();
    const source = path.join(config.DATA_DIR, "abcdef0123456789abcdef02.jpg");
    await fs.promises.writeFile(source, "source");
    const item: PublishMediaItem = { type: "IMAGE", localPath: source };
    const paths = storyVariantPaths(config, source, false);
    await fs.promises.mkdir(path.dirname(paths.standard), { recursive: true });
    await fs.promises.writeFile(paths.standard, "variant");
    expect(preparedStoryMedia(config, item)).not.toBeNull();

    // The file is the record: with it gone, the asset is simply unprepared.
    await fs.promises.rm(paths.standard);
    expect(preparedStoryMedia(config, item)).toBeNull();
  });

  it("requires both video derivatives before delivery can use either", async () => {
    const config = tempConfig();
    const source = path.join(config.DATA_DIR, "abcdef0123456789abcdef03.mp4");
    const paths = storyVariantPaths(config, source, true);
    await fs.promises.mkdir(path.dirname(paths.standard), { recursive: true });
    await fs.promises.writeFile(paths.standard, "standard");

    expect(preparedStoryMedia(config, { type: "VIDEO", localPath: source })).toBeNull();

    await fs.promises.writeFile(String(paths.telegram), "telegram");
    expect(preparedStoryMedia(config, { type: "VIDEO", localPath: source })?.telegramStoryLocalPath).toBe(paths.telegram);
  });

  it("has nothing to offer for media that arrived without a local file", () => {
    const config = tempConfig();
    expect(preparedStoryMedia(config, { type: "IMAGE", fileId: "telegram-file" })).toBeNull();
  });

  it("renders a missing derivative once and leaves a present one alone", async () => {
    const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "story-ensure-")) });
    const source = path.join(config.DATA_DIR, "abcdef0123456789abcdef04.jpg");
    await fs.promises.writeFile(source, PNG_BYTES);

    expect(await ensureStoryDerivative(config, source, false)).toBe(true);
    const paths = storyVariantPaths(config, source, false);
    const renderedAt = fs.statSync(paths.standard).mtimeMs;

    // Present means done: the second caller neither waits for ffmpeg nor
    // replaces the file the first one made.
    expect(await ensureStoryDerivative(config, source, false)).toBe(false);
    expect(fs.statSync(paths.standard).mtimeMs).toBe(renderedAt);
  });

  it("prepares a file that never went through ingress, for the backfill to publish", async () => {
    const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "story-recover-")) });
    const source = path.join(config.DATA_DIR, "abcdef0123456789abcdef05.jpg");
    await fs.promises.writeFile(source, PNG_BYTES);
    const item: PublishMediaItem = { type: "IMAGE", localPath: source };
    expect(preparedStoryMedia(config, item)).toBeNull();

    // Publishing itself never renders: it reads what ingress or the backfill
    // left, and this is the render the backfill performs.
    await ensureStoryDerivative(config, source, false);
    const prepared = preparedStoryMedia(config, item);
    expect(prepared?.storyLocalPath).toBe(storyVariantPaths(config, source, false).standard);
    expect(fs.existsSync(String(prepared?.storyLocalPath))).toBe(true);
  });

  it("shares one render between the targets that arrive while it runs", async () => {
    const config = loadTestConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "story-share-")) });
    const source = path.join(config.DATA_DIR, "abcdef0123456789abcdef06.jpg");
    await fs.promises.writeFile(source, PNG_BYTES);

    // Two Story targets of one post, asking at the same moment: one encode, and
    // both see it as theirs.
    const [first, second] = await Promise.all([ensureStoryDerivative(config, source, false), ensureStoryDerivative(config, source, false)]);
    expect([first, second]).toEqual([true, true]);
    expect(fs.readdirSync(path.join(config.DATA_DIR, "story-media"))).toHaveLength(1);
  });

  it("refuses to invent a derivative for a source that is gone", async () => {
    const config = tempConfig();
    await expect(ensureStoryDerivative(config, path.join(config.DATA_DIR, "abcdef0123456789abcdef08.jpg"), false)).rejects.toThrow(
      "story_source_missing",
    );
  });
});
