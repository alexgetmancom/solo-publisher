import { describe, expect, it } from "bun:test";
import { creatorArchiveSummary, creatorPostArchive, creatorPostMedia, creatorPostMetrics } from "../src/analytics/reports/post-archive.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { metricSamples } from "../src/db/schema.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";

const at = "2026-07-27T10:00:00.000Z";

function publishedPost(
  backendDb: UnsafeBackendDb,
  options: { postId: number; text?: string | null; updatedAt?: string; mediaCount?: number; dateMsk?: string; status?: string },
): void {
  seedTextPost(backendDb, {
    postId: options.postId,
    ru: options.text ?? "",
    status: options.status ?? "published",
    siteMediaRu: Array.from({ length: options.mediaCount ?? 0 }, (_, index) => ({ type: "photo", index })),
    now: options.dateMsk ?? options.updatedAt ?? at,
  });
}

function sample(
  backendDb: UnsafeBackendDb,
  values: { postId: number; target: string; metricName: string; value: number; sampledAt?: string },
): void {
  backendDb.db
    .insert(metricSamples)
    .values({
      publicationKey: `post:${values.postId}`,
      target: values.target,
      metricName: values.metricName,
      value: values.value,
      sampledAt: values.sampledAt ?? at,
    })
    .run();
}

describe("creatorPostArchive", () => {
  it("lists published posts newest first", () => {
    return withDb((backendDb) => {
      publishedPost(backendDb, { postId: 1, text: "Older post", updatedAt: "2026-07-01T00:00:00.000Z" });
      publishedPost(backendDb, { postId: 2, text: "Newer post", updatedAt: "2026-07-20T00:00:00.000Z" });

      const archive = creatorPostArchive(backendDb);
      expect(archive.items.map((item) => item.id)).toEqual([2, 1]);
      expect(archive.total).toBe(2);
    });
  });

  it("labels a post with no text as a media post", () => {
    return withDb((backendDb) => {
      publishedPost(backendDb, { postId: 1, text: "   " });

      expect(creatorPostArchive(backendDb).items[0]?.label).toBe("Media post");
    });
  });

  it("excludes a post whose publication is not published", () => {
    return withDb((backendDb) => {
      publishedPost(backendDb, { postId: 1, text: "Draft", status: "draft" });

      expect(creatorPostArchive(backendDb).items).toEqual([]);
      expect(creatorPostArchive(backendDb).total).toBe(0);
      expect(creatorPostArchive(backendDb).text).toContain("No published posts yet");
    });
  });

  it("pages ten at a time and keeps the total across pages", () => {
    return withDb((backendDb) => {
      for (let index = 1; index <= 12; index += 1) {
        publishedPost(backendDb, {
          postId: index,
          text: `Post ${index}`,
          updatedAt: `2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`,
        });
      }

      expect(creatorPostArchive(backendDb).items).toHaveLength(10);
      expect(creatorPostArchive(backendDb, 10).items).toHaveLength(2);
      expect(creatorPostArchive(backendDb, 10).total).toBe(12);
    });
  });
});

describe("creatorPostMetrics", () => {
  it("sums only the newest sample per target and metric", () => {
    return withDb((backendDb) => {
      publishedPost(backendDb, { postId: 106, text: "Post text", mediaCount: 2, dateMsk: "2026-07-27T00:00:00.000Z" });
      // An append-only history: summing every row would report 30 views, not 20.
      sample(backendDb, { postId: 106, target: "x", metricName: "views", value: 10 });
      sample(backendDb, { postId: 106, target: "x", metricName: "views", value: 20 });
      sample(backendDb, { postId: 106, target: "x", metricName: "likes", value: 3 });
      sample(backendDb, { postId: 106, target: "telegram", metricName: "views", value: 5 });

      const text = creatorPostMetrics(backendDb, 106);
      expect(text).toContain("Total views: *25*");
      expect(text).toContain("Interactions: *3*");
      expect(text).toContain("Media: *2*");
      expect(text).toContain("🗓 2026-07-27");
      expect(text).toContain("x: 20 views · 3 interactions");
      expect(text).toContain("telegram: 5 views · 0 interactions");
    });
  });

  it("counts every interaction kind in the total", () => {
    return withDb((backendDb) => {
      publishedPost(backendDb, { postId: 1, text: "t" });
      for (const [metricName, value] of Object.entries({ likes: 1, replies: 2, comments: 3, reposts: 4, shares: 5 })) {
        sample(backendDb, { postId: 1, target: "x", metricName, value });
      }

      expect(creatorPostMetrics(backendDb, 1)).toContain("Interactions: *15*");
    });
  });

  it("says so when the post does not exist", () => {
    return withDb((backendDb) => {
      expect(creatorPostMetrics(backendDb, 999)).toBe("Post not found.");
      expect(creatorPostMetrics(backendDb, 999, "ru")).toBe("Пост не найден.");
    });
  });

  it("reports zeroes and a placeholder body for a post with no samples and no text", () => {
    return withDb((backendDb) => {
      publishedPost(backendDb, { postId: 7, text: null });

      const text = creatorPostMetrics(backendDb, 7);
      expect(text).toContain("Total views: *0*");
      expect(text).toContain("[media post]");
    });
  });

  it("does not mix in another post's samples", () => {
    return withDb((backendDb) => {
      publishedPost(backendDb, { postId: 1, text: "mine" });
      publishedPost(backendDb, { postId: 2, text: "theirs" });
      sample(backendDb, { postId: 2, target: "x", metricName: "views", value: 500 });

      expect(creatorPostMetrics(backendDb, 1)).toContain("Total views: *0*");
    });
  });
});

describe("creatorPostMedia", () => {
  it("returns the requested locale's media as plain records", () => {
    return withDb((backendDb) => {
      seedTextPost(backendDb, {
        postId: 1,
        siteMediaRu: [{ type: "photo", url: "/ru.jpg" }],
        siteMediaEn: [{ type: "photo", url: "/en.jpg" }],
        now: at,
      });

      expect(creatorPostMedia(backendDb, 1, "ru")).toEqual([{ type: "photo", url: "/ru.jpg" }]);
      expect(creatorPostMedia(backendDb, 1, "en")).toEqual([{ type: "photo", url: "/en.jpg" }]);
    });
  });

  it("returns an empty list for a missing locale row or a payload that is not an array", () => {
    return withDb((backendDb) => {
      expect(creatorPostMedia(backendDb, 1, "en")).toEqual([]);

      seedTextPost(backendDb, { postId: 2, now: at });
      backendDb.sqlite.query("UPDATE post_locales SET site_media_json='{\"type\":\"photo\"}' WHERE draft_id=2 AND locale='en'").run();
      expect(creatorPostMedia(backendDb, 2, "en")).toEqual([]);
    });
  });

  it("drops null entries rather than passing them to the renderer", () => {
    return withDb((backendDb) => {
      seedTextPost(backendDb, { postId: 3, now: at });
      backendDb.sqlite
        .query("UPDATE post_locales SET site_media_json='[null,{\"type\":\"photo\"}]' WHERE draft_id=3 AND locale='en'")
        .run();

      expect(creatorPostMedia(backendDb, 3, "en")).toEqual([{ type: "photo" }]);
    });
  });
});

describe("creatorArchiveSummary", () => {
  it("counts published posts and videos and mentions both", () => {
    return withDb((backendDb) => {
      publishedPost(backendDb, { postId: 1, text: "one" });
      publishedPost(backendDb, { postId: 2, text: "two" });
      insertPublishedVideo(backendDb, { target: "youtube_shorts", publishedAt: at });

      const summary = creatorArchiveSummary(backendDb);
      expect(summary).toMatchObject({ posts: 2, videos: 1 });
      expect(summary.text).toContain("Posts: *2*");
      expect(summary.text).toContain("Videos: *1*");
    });
  });

  it("agrees with the archive listing on what counts as published", () => {
    return withDb((backendDb) => {
      publishedPost(backendDb, { postId: 1, text: "published" });
      publishedPost(backendDb, { postId: 2, text: "draft", status: "draft" });

      expect(creatorArchiveSummary(backendDb).posts).toBe(creatorPostArchive(backendDb).total);
    });
  });
});
