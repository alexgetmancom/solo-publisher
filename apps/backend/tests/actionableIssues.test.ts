import { describe, expect, it } from "bun:test";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { draftStoryCards, drafts, publicationTargets, siteJobs, videoDrafts, videoTargets } from "../src/db/schema.js";
import { commandCenterAttention } from "../src/operations/command-center.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoAsset } from "./helpers/video.js";

const NOW = "2026-08-21T00:00:00.000Z";

function seedDraft(backendDb: UnsafeBackendDb, id: number, postId: number, actorId = 42): void {
  backendDb.db.insert(drafts).values({ id, actorId, status: "published", targetsJson: "{}", postId, createdAt: NOW, updatedAt: NOW }).run();
}

/** Each case is a way a publication can be stuck that the Command Center used
 * to render green: its dot asked `publish_jobs.status = 'failed'` and nothing else. */
describe("actionable issues", () => {
  it("sees a publication that reached the audience without a readable proof", () =>
    withDb((backendDb) => {
      seedDraft(backendDb, 1, 800);
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:800", target: "threads_ru", status: "verification_required", updatedAt: NOW })
        .run();

      expect(backendDb.actionableIssues.list()).toMatchObject([
        { kind: "post", publicationKey: "post:800", target: "threads_ru", status: "verification_required", draftId: 1, actorId: 42 },
      ]);
      expect(commandCenterAttention(loadTestConfig({}), backendDb).hasActionableIssue).toBe(true);
    }));

  it("sees a terminal site failure", () =>
    withDb((backendDb) => {
      seedDraft(backendDb, 1, 800);
      backendDb.db
        .insert(siteJobs)
        .values({ publicationKey: "post:800", reason: "publish", status: "failed", createdAt: NOW, updatedAt: NOW })
        .run();

      expect(backendDb.actionableIssues.list()).toMatchObject([{ kind: "site", publicationKey: "post:800", status: "failed" }]);
      expect(commandCenterAttention(loadTestConfig({}), backendDb).hasActionableIssue).toBe(true);
    }));

  it("sees a failed Story card", () =>
    withDb((backendDb) => {
      seedDraft(backendDb, 1, 800);
      backendDb.db
        .insert(draftStoryCards)
        .values({
          draftId: 1,
          locale: "ru",
          sourceHash: "hash",
          headline: "headline",
          status: "failed",
          templateVersion: "1",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();

      expect(backendDb.actionableIssues.list()).toMatchObject([{ kind: "story", draftId: 1, target: "ru", status: "failed" }]);
      expect(commandCenterAttention(loadTestConfig({}), backendDb).hasActionableIssue).toBe(true);
    }));

  it("sees a failed video target, but not one under a draft still being written", () =>
    withDb((backendDb) => {
      backendDb.db
        .insert(videoDrafts)
        .values([
          {
            id: 1,
            actorId: 42,
            locale: "ru",
            label: "published",
            studioMediaAssetId: createTestVideoAsset(backendDb),
            status: "published",
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: 2,
            actorId: 42,
            locale: "ru",
            label: "editing",
            studioMediaAssetId: createTestVideoAsset(backendDb),
            status: "editing",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ])
        .run();
      backendDb.db
        .insert(videoTargets)
        .values([
          {
            id: 1,
            videoDraftId: 1,
            target: "youtube_shorts",
            metadataJson: { title: "clip", description: "", tags: [], videoDurationMs: 24_000 },
            status: "failed",
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: 2,
            videoDraftId: 2,
            target: "youtube_shorts",
            metadataJson: { title: "clip", description: "", tags: [], videoDurationMs: 24_000 },
            status: "failed",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ])
        .run();

      expect(backendDb.actionableIssues.list()).toMatchObject([{ kind: "video", publicationKey: "video:1", draftId: 1 }]);
      expect(commandCenterAttention(loadTestConfig({}), backendDb).hasActionableIssue).toBe(true);
    }));

  it("leaves a settled publication alone and scopes to the actor asking", () =>
    withDb((backendDb) => {
      seedDraft(backendDb, 1, 800, 42);
      seedDraft(backendDb, 2, 801, 7);
      backendDb.db
        .insert(publicationTargets)
        .values([
          { publicationKey: "post:800", target: "telegram", status: "published", updatedAt: NOW },
          // A site card has its own job table; its row here is not the failure.
          { publicationKey: "post:800", target: "site_ru", status: "failed", updatedAt: NOW },
          { publicationKey: "post:801", target: "threads_ru", status: "failed", updatedAt: NOW },
        ])
        .run();

      expect(backendDb.actionableIssues.list([42])).toEqual([]);
      expect(backendDb.actionableIssues.list([7])).toMatchObject([{ publicationKey: "post:801", actorId: 7 }]);
      expect(commandCenterAttention(loadTestConfig({}), backendDb).hasActionableIssue).toBe(true);
    }));
});
