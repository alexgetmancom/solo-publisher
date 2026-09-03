import { describe, expect, it } from "bun:test";
import { recentSocialComments } from "../src/analytics/reports/audience.js";
import { socialComments, studioMediaAssets, videoDrafts, videoTargets } from "../src/db/schema.js";
import { withDb } from "./helpers/db.js";

/** The video platforms answer under a video, so the reader has to walk target
 * and draft to say which video was commented on. That walk is the part that
 * breaks silently when either table is reshaped. */
describe("video platform comments", () => {
  it("names the video and platform each comment was left under", () =>
    withDb((backendDb) => {
      backendDb.db
        .insert(studioMediaAssets)
        .values({
          id: 1,
          actorId: 1,
          kind: "video",
          mimeType: "video/mp4",
          filename: "clip.mp4",
          localPath: "/tmp/clip.mp4",
          byteSize: 10,
          sha256: "abc",
          source: "telegram",
          createdAt: "2026-09-01T00:00:00.000Z",
        })
        .run();
      backendDb.db
        .insert(videoDrafts)
        .values({
          id: 5,
          actorId: 1,
          label: "Shorts about agents",
          studioMediaAssetId: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        })
        .run();
      backendDb.db
        .insert(videoTargets)
        .values({
          id: 9,
          videoDraftId: 5,
          target: "youtube_shorts",
          metadataJson: {},
          externalUrl: "https://youtube.com/shorts/xyz",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        })
        .run();
      backendDb.db
        .insert(socialComments)
        .values([
          {
            platform: "youtube",
            commentId: "c1",
            videoTargetId: 9,
            author: "Viewer",
            text: "older",
            likeCount: 1,
            publishedAt: "2026-09-02T09:00:00.000Z",
            fetchedAt: "2026-09-02T10:00:00.000Z",
          },
          {
            platform: "youtube",
            commentId: "c2",
            videoTargetId: 9,
            author: "Viewer",
            text: "newer",
            likeCount: 3,
            publishedAt: "2026-09-02T11:00:00.000Z",
            fetchedAt: "2026-09-02T12:00:00.000Z",
          },
        ])
        .run();

      const [thread] = recentSocialComments(backendDb, 10);
      expect(thread?.platform).toBe("youtube");
      expect(thread?.target).toBe("youtube_shorts");
      expect(thread?.label).toBe("Shorts about agents");
      expect(thread?.url).toBe("https://youtube.com/shorts/xyz");
      expect(thread?.comments.map((comment) => comment.text)).toEqual(["newer", "older"]);
    }));

  it("says nothing when nothing was written", () => withDb((backendDb) => expect(recentSocialComments(backendDb, 10)).toEqual([])));
});
