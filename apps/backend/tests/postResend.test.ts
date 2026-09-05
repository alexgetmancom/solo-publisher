import { describe, expect, it } from "bun:test";
import { drafts, publicationTargets, publishJobs } from "../src/db/schema.js";
import { parseTargets } from "../src/publishing/targets.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const CHANNELS = ["telegram", "x", "discord", "site_en"] as const;

function studioPosts(backendDb: Parameters<Parameters<typeof withDb>[0]>[0]) {
  return createStudioServices(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" })).posts;
}

/** The platform remembered after the post has gone out. Until this existed the
 * only way to add one was `ops retry --target`, which republishes every target
 * it touches: the answer to "it should have gone to X as well" was a second
 * copy of the post everywhere else. */
describe("post resend", () => {
  it("sends a published post to a platform it never went to and refuses the second tap", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 9,
        postId: 900,
        actorId: 42,
        status: "published",
        targets: { telegram: true },
        ru: "Опубликованный пост",
        en: "Published post",
        now,
      });
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:900",
          target: "telegram",
          status: "published",
          payloadJson: { text: "Опубликованный пост" },
          attemptCount: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const posts = studioPosts(backendDb);
      // Only platforms this Studio has actually connected, and never the site:
      // its pages are rendered by their own build.
      expect(posts.resendableTargets(42, 9).map((item) => item.target)).toEqual(["x", "discord"]);

      expect(posts.resendTarget(42, 9, "x")).toMatchObject({ target: "x", outcome: "requeued" });
      expect(backendDb.db.select({ target: publishJobs.target, status: publishJobs.status }).from(publishJobs).all()).toEqual([
        { target: "telegram", status: "published" },
        { target: "x", status: "queued" },
      ]);
      // The delivery is only reported by anything -- the card, progress, the
      // completion notice -- once the draft claims the target as its own.
      const draft = backendDb.db.select({ targetsJson: drafts.targetsJson }).from(drafts).all()[0];
      expect(parseTargets(draft?.targetsJson ?? "{}")).toMatchObject({ telegram: true, x: true });
      expect(posts.resendableTargets(42, 9).map((item) => item.target)).not.toContain("x");

      // The queue already holds it: tapping again must not make a second job.
      expect(() => posts.resendTarget(42, 9, "x")).toThrow("err.resend-already");
      expect(backendDb.db.select({ target: publishJobs.target }).from(publishJobs).all()).toHaveLength(2);
    }, CHANNELS));

  it("refuses a target that already put the post in front of its audience", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 11,
        postId: 1100,
        actorId: 42,
        status: "failed",
        targets: { telegram: true },
        ru: "Опубликованный пост",
        en: "Published post",
        now,
      });
      // A target with a job that failed after its post went out: the id on the
      // durable row is what says so, and resending is a second copy.
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:1100",
          target: "x",
          status: "failed",
          payloadJson: { text: "Published post" },
          attemptCount: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:1100", target: "x", status: "failed", externalId: "1789", updatedAt: now })
        .run();

      expect(() => studioPosts(backendDb).resendTarget(42, 11, "x")).toThrow("err.resend-already");
    }, CHANNELS));

  it("refuses a platform whose language the post has nothing in", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 13,
        postId: 1300,
        actorId: 42,
        status: "published",
        targets: { telegram: true },
        ru: "Только по-русски",
        now,
      });
      expect(() => studioPosts(backendDb).resendTarget(42, 13, "x")).toThrow("err.resend-empty");
    }, CHANNELS));

  it("has nothing to offer on a draft that was never published", () =>
    withDb((backendDb) => {
      seedTextPost(backendDb, { draftId: 15, postId: null, actorId: 42, status: "draft", targets: { telegram: true }, ru: "Черновик" });
      const posts = studioPosts(backendDb);
      expect(posts.resendableTargets(42, 15)).toEqual([]);
      expect(() => posts.resendTarget(42, 15, "x")).toThrow("err.resend-unpublished");
    }, CHANNELS));
});
