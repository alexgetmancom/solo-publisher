import { describe, expect, it } from "bun:test";
import type { FeedItem } from "../../../backend/src/public/site-read-model";
import { postImagePath, postMediaGallery, postSocialImagePath, postVisualMedia } from "./media";

function feedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "post:1",
    post_id: 1,
    date: "2026-07-15T10:00:00.000Z",
    text: "",
    text_ru: "",
    text_en: "",
    html: "",
    html_en: "",
    slug_ru: null,
    slug_en: null,
    has_ru: true,
    has_en: true,
    media: [],
    media_en: [],
    image: null,
    image_en: null,
    entities: [],
    views: 0,
    ...overrides,
  };
}

describe("postVisualMedia", () => {
  it("prefers the direct locale image over the media array", () => {
    expect(postVisualMedia(feedItem({ image_en: "media/posts/1-en.jpg", media_en: [{ path: "media/posts/other.jpg" }] }), "en")).toEqual({
      type: "image",
      path: "media/posts/1-en.jpg",
    });
  });

  it("falls back to the media array and detects video by declared type", () => {
    expect(
      postVisualMedia(
        feedItem({ media_en: [{ type: "video", path: "media/posts/1-en.mp4", poster: "media/posts/1-en-poster.jpg" }] }),
        "en",
      ),
    ).toEqual({
      type: "video",
      path: "media/posts/1-en.mp4",
      poster: "media/posts/1-en-poster.jpg",
    });
  });

  it("detects video by file extension when the type field is missing", () => {
    expect(postVisualMedia(feedItem({ media_en: [{ path: "media/posts/1-en.webm" }] }), "en")).toEqual({
      type: "video",
      path: "media/posts/1-en.webm",
    });
  });

  it("falls back to the other locale's media when the requested locale has none", () => {
    expect(postVisualMedia(feedItem({ media: [{ path: "media/posts/1-ru.jpg" }] }), "en")).toEqual({
      type: "image",
      path: "media/posts/1-ru.jpg",
    });
  });

  it("returns null when there is no image or media at all", () => {
    expect(postVisualMedia(feedItem())).toBeNull();
  });
});

describe("postMediaGallery", () => {
  it("puts the direct cover image first and keeps the rest in publishing order", () => {
    expect(
      postMediaGallery(
        feedItem({
          image_en: "media/posts/1-en-0.jpg",
          media_en: [{ path: "media/posts/1-en-1.jpg" }, { path: "media/posts/1-en-2.jpg" }],
        }),
        "en",
      ),
    ).toEqual([
      { type: "image", path: "media/posts/1-en-0.jpg" },
      { type: "image", path: "media/posts/1-en-1.jpg" },
      { type: "image", path: "media/posts/1-en-2.jpg" },
    ]);
  });

  it("drops duplicate paths, keeping the first occurrence", () => {
    expect(
      postMediaGallery(
        feedItem({
          image_en: "media/posts/1-en-0.jpg",
          media_en: [{ path: "media/posts/1-en-0.jpg" }, { path: "media/posts/1-en-1.jpg" }],
        }),
        "en",
      ),
    ).toEqual([
      { type: "image", path: "media/posts/1-en-0.jpg" },
      { type: "image", path: "media/posts/1-en-1.jpg" },
    ]);
  });

  it("drops entries without a path", () => {
    expect(postMediaGallery(feedItem({ media_en: [{ path: "" }, { path: "media/posts/1-en-1.jpg" }] }), "en")).toEqual([
      { type: "image", path: "media/posts/1-en-1.jpg" },
    ]);
  });

  it("is empty when the post has no media", () => {
    expect(postMediaGallery(feedItem())).toEqual([]);
  });
});

describe("postImagePath", () => {
  it("prefers the direct locale image", () => {
    expect(postImagePath(feedItem({ image_en: "media/posts/1-en.jpg" }), "en")).toBe("media/posts/1-en.jpg");
  });

  it("skips video entries and finds the first image in the media array", () => {
    expect(
      postImagePath(feedItem({ media_en: [{ type: "video", path: "media/posts/1-en.mp4" }, { path: "media/posts/1-en-1.jpg" }] }), "en"),
    ).toBe("media/posts/1-en-1.jpg");
  });

  it("returns null when there is nothing to show", () => {
    expect(postImagePath(feedItem())).toBeNull();
  });
});

describe("postSocialImagePath", () => {
  it("uses the post image when one exists", () => {
    expect(postSocialImagePath(feedItem({ media: [{ type: "image", path: "media/post.jpg" }] }), "ru")).toBe("/media/post.jpg");
  });

  it("uses the poster instead of a video file", () => {
    expect(postSocialImagePath(feedItem({ media_en: [{ type: "video", path: "media/post.mp4", poster: "media/post.jpg" }] }), "en")).toBe(
      "/media/post.jpg",
    );
  });

  it("falls back to the generic social image without visual media", () => {
    expect(postSocialImagePath(feedItem(), "en")).toBe("/social-image.jpg");
  });
});
