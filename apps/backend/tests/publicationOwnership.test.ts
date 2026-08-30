import { describe, expect, it } from "bun:test";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoDraft } from "./helpers/video.js";

/**
 * Who a publication belongs to is checked once per method, by hand.
 *
 * `requireOwnedDraft` and `requireOwnedVideo` are called at the top of some
 * fifty service methods, and a method that forgets the call breaks nothing that
 * anything else can see: it simply answers for a draft the caller does not own,
 * on every surface at once, because all three drive the same services. Four of
 * those methods had a test.
 *
 * So every method is driven here, with an actor who owns nothing. A method is
 * either scoped to a publication -- and must refuse -- or it is scoped to the
 * caller themselves and takes no publication at all. There is no third answer,
 * and a method added without one fails the first assertion rather than
 * quietly joining the checked ones.
 */

const OWNER = 42;
/** Not on the Studio roster. One installation is one editorial boundary, so
 * every configured actor may operate another's work -- the refusal this drives
 * is for someone outside it. */
const STRANGER = 7;

/** Methods that take no publication: they answer about the caller, or create
 * something the caller then owns. */
const POST_ACTOR_SCOPED = ["create", "list", "mediaAssets", "slotTime", "publishArticle"];
const VIDEO_ACTOR_SCOPED = ["create", "list", "slotTime", "immediateTime", "isImmediate", "assetTechnicalCheck"];

/** The few methods that normalize an argument before they ask who is calling.
 * Ownership is still the first thing they check about the *publication*; the
 * sweep just has to hand them something shaped right to get that far. */
const EXTRA_ARGUMENTS: Record<string, unknown[]> = { schedule: [{ values: {} }], edit: [{ locale: "en" }] };

async function refusal(call: () => unknown): Promise<string> {
  try {
    const result = await call();
    return `returned ${JSON.stringify(result) ?? "undefined"}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function services(backendDb: UnsafeBackendDb) {
  return createStudioServices(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: `${OWNER}` }));
}

/** The capabilities a service exposes; `kind` and its like are labels, not
 * something anyone can call. */
function capabilities(service: object, actorScoped: readonly string[]): string[] {
  return Object.entries(service)
    .filter(([name, value]) => typeof value === "function" && !actorScoped.includes(name))
    .map(([name]) => name);
}

describe("a publication answers only to the actor who owns it", () => {
  it("refuses every post capability that takes a draft, to an actor who owns none", () =>
    withDb(async (backendDb) => {
      const draftId = seedTextPost(backendDb, {
        draftId: 501,
        actorId: OWNER,
        status: "draft",
        ru: "Черновик",
        en: "Draft",
        targets: { threads_en: true },
      });
      const posts = services(backendDb).posts;
      const scoped = capabilities(posts, POST_ACTOR_SCOPED);

      expect(scoped.length).toBeGreaterThan(15);
      const answers = new Map<string, string>();
      for (const name of scoped) {
        const extra = EXTRA_ARGUMENTS[name] ?? [];
        answers.set(
          name,
          await refusal(() => (posts as unknown as Record<string, (...args: unknown[]) => unknown>)[name]?.(STRANGER, draftId, ...extra)),
        );
      }

      // Every one of them names ownership. A method that got as far as
      // complaining about a missing argument never checked.
      for (const [name, answer] of answers) expect([name, answer]).toEqual([name, "err.post-not-yours"]);
    }));

  it("refuses every video capability that takes a draft, to an actor who owns none", () =>
    withDb(async (backendDb) => {
      const draftId = createTestVideoDraft(backendDb, OWNER, "/tmp/owned.mp4", 24);
      const videos = services(backendDb).videos;
      const scoped = capabilities(videos, VIDEO_ACTOR_SCOPED);

      expect(scoped.length).toBeGreaterThan(15);
      const answers = new Map<string, string>();
      for (const name of scoped) {
        const extra = EXTRA_ARGUMENTS[name] ?? [];
        answers.set(
          name,
          await refusal(() => (videos as unknown as Record<string, (...args: unknown[]) => unknown>)[name]?.(STRANGER, draftId, ...extra)),
        );
      }

      for (const [name, answer] of answers) expect([name, answer]).toEqual([name, "err.video-not-yours"]);
    }));

  it("classifies every service method as publication-scoped or actor-scoped", () =>
    withDb(async (backendDb) => {
      const studio = services(backendDb);
      // The actor-scoped lists are exceptions, and an exception that names a
      // method the service no longer has is how a list stops being read.
      for (const name of POST_ACTOR_SCOPED) expect(Object.keys(studio.posts)).toContain(name);
      for (const name of VIDEO_ACTOR_SCOPED) expect(Object.keys(studio.videos)).toContain(name);
    }));
});
