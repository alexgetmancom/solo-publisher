import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FeedItem } from "../server/public-site";
import { existingSiteImage, sortedHomePosts, toHomePost } from "./home-posts";

function feedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "post:1",
    post_id: 1,
    date: "2026-07-15T10:00:00.000Z",
    text: "Русский текст поста",
    text_ru: "Русский текст поста",
    text_en: "English post text",
    html: "",
    html_en: "",
    slug_ru: "russkiy-post",
    slug_en: "english-post",
    has_ru: true,
    has_en: true,
    media: [],
    media_en: [],
    image: null,
    image_en: null,
    entities: [],
    views: 12,
    ...overrides,
  };
}

/** `existingSiteImage` checks the real filesystem; point DATA_DIR at a
 * throwaway temp dir (the same seam siteJobs/siteParity/home.smoke tests use)
 * so these tests don't depend on which files happen to live in apps/web/public. */
let dataDir: string;
let siteDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "solo-publisher-home-posts-"));
  siteDir = path.join(dataDir, "site");
  fs.mkdirSync(siteDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
});
afterEach(() => {
  delete process.env.DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function touch(relativePath: string): void {
  const filePath = path.join(siteDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "fixture");
}

describe("existingSiteImage", () => {
  it("returns null for a falsy path", () => {
    expect(existingSiteImage(null)).toBeNull();
    expect(existingSiteImage(undefined)).toBeNull();
    expect(existingSiteImage("")).toBeNull();
  });

  it("returns null when the file does not exist anywhere", () => {
    expect(existingSiteImage("media/posts/does-not-exist.jpg")).toBeNull();
  });

  it("returns the normalized path once the file exists under the site volume", () => {
    touch("media/posts/1-en-0.jpg");
    expect(existingSiteImage("media/posts/1-en-0.jpg")).toBe("media/posts/1-en-0.jpg");
    expect(existingSiteImage("/media/posts/1-en-0.jpg")).toBe("media/posts/1-en-0.jpg");
  });
});

describe("toHomePost", () => {
  it("drops a published locale without a canonical slug", () => {
    expect(sortedHomePosts([feedItem({ slug_en: null })], "en")).toEqual([]);
  });

  it("resolves an image post whose file exists", () => {
    touch("media/posts/1-en-0.jpg");
    const post = toHomePost(feedItem({ image_en: "media/posts/1-en-0.jpg" }), "en");

    expect(post.mediaType).toBe("image");
    expect(post.image).toBe("media/posts/1-en-0.jpg");
    expect(post.url).toBe("/1/english-post/");
    expect(post.gallery).toEqual([{ type: "image", path: "media/posts/1-en-0.jpg" }]);
  });

  it("resolves a video post and keeps the poster as the fallback image", () => {
    touch("media/posts/1-en-0.mp4");
    touch("media/posts/1-en-0-poster.jpg");
    const post = toHomePost(
      feedItem({ media_en: [{ type: "video", path: "media/posts/1-en-0.mp4", poster: "media/posts/1-en-0-poster.jpg" }] }),
      "en",
    );

    expect(post.mediaType).toBe("video");
    expect(post.image).toBe("media/posts/1-en-0.mp4");
    expect(post.fallbackImage).toBe("media/posts/1-en-0-poster.jpg");
    expect(post.posterSrc).toContain("1-en-0-poster-960.webp");
  });

  it("falls back to the generic social image when post media is missing on disk", () => {
    touch("social-image.jpg");
    const post = toHomePost(feedItem({ image_en: "media/posts/1-en-0.jpg" /* not touched: missing on disk */ }), "en");

    expect(post.mediaType).toBe("image");
    expect(post.image).toBe("social-image.jpg");
  });

  it("uses the checked-in generic image when post media is missing", () => {
    const post = toHomePost(feedItem({ image_en: "media/posts/1-en-0.jpg" }), "en");

    expect(post.mediaType).toBe("image");
    expect(post.image).toBe("social-image.jpg");
  });

  it("drops gallery entries whose file is missing on disk", () => {
    touch("media/posts/1-en-0.jpg");
    const post = toHomePost(
      feedItem({
        image_en: "media/posts/1-en-0.jpg",
        media_en: [{ path: "media/posts/1-en-0.jpg" }, { path: "media/posts/1-en-1.jpg" /* not touched */ }],
      }),
      "en",
    );

    expect(post.gallery).toEqual([{ type: "image", path: "media/posts/1-en-0.jpg" }]);
  });

  it("builds the Russian locale url and reads the Russian text", () => {
    const post = toHomePost(feedItem(), "ru");
    expect(post.url).toBe("/ru/1/russkiy-post/");
    expect(post.body).toBe("Русский текст поста");
  });
});
