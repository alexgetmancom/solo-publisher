import { afterEach, describe, expect, it } from "bun:test";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { publicationTargets } from "../src/db/schema.js";
import { verifyPostTargets } from "../src/operations/verify.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";

const now = "2026-07-27T10:00:00.000Z";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** verifyPostTargets reaches for the global fetch, so a stub has to replace it
 * rather than be passed in; no-network.ts throws on anything left unstubbed. */
function stubFetch(handler: (url: string) => Response | Promise<Response>): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      return handler(url);
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
  return { urls };
}

function insertPost(backendDb: UnsafeBackendDb, overrides: { postId: number; messageId: number }): void {
  seedTextPost(backendDb, { postId: overrides.postId, messageId: overrides.messageId, now });
}

function insertTarget(
  backendDb: UnsafeBackendDb,
  values: { publicationKey: string; target: string; status: string; url?: string | null; error?: string | null },
): void {
  backendDb.db
    .insert(publicationTargets)
    .values({
      publicationKey: values.publicationKey,
      target: values.target,
      status: values.status,
      url: values.url ?? null,
      error: values.error ?? null,
      updatedAt: now,
    })
    .run();
}

describe("verifyPostTargets", () => {
  it("resolves a post:<id> ref and reports a live publication as ok", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postId: 106, messageId: 106 });
      insertTarget(backendDb, { publicationKey: "post:106", target: "telegram", status: "published", url: "https://t.me/alexgetman/106" });
      const { urls } = stubFetch(() => new Response("ok", { status: 200 }));

      expect(await verifyPostTargets(backendDb, "post:106")).toEqual([
        {
          target: "telegram",
          status: "published",
          url: "https://t.me/alexgetman/106",
          error: null,
          externalId: null,
          ok: true,
          partial: false,
          reason: "http_200",
        },
      ]);
      expect(urls).toEqual(["https://t.me/alexgetman/106"]);
    });
  });

  it("does not treat a historical Telegram message id as a post id", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postId: 8, messageId: 106 });
      insertTarget(backendDb, { publicationKey: "post:8", target: "telegram", status: "queued" });

      await expect(verifyPostTargets(backendDb, "post:106")).rejects.toThrow("post not found: post:106");
    });
  });

  it("throws for an unknown ref instead of returning an empty verdict", async () => {
    await withDb(async (backendDb) => {
      await expect(verifyPostTargets(backendDb, "post:999")).rejects.toThrow("post not found: post:999");
    });
  });

  it("rejects a non-canonical ref", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postId: 7, messageId: 7 });
      await expect(verifyPostTargets(backendDb, "post:draft-abc")).rejects.toThrow("post not found");
      await expect(verifyPostTargets(backendDb, "post:nope")).rejects.toThrow("post not found");
    });
  });

  it("counts 404 and 410 as failures, so a deleted publication does not verify as ok", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postId: 1, messageId: 1 });
      insertTarget(backendDb, { publicationKey: "post:1", target: "instagram", status: "published", url: "https://example.test/gone" });
      insertTarget(backendDb, { publicationKey: "post:1", target: "threads_ru", status: "published", url: "https://example.test/deleted" });
      stubFetch((url) => new Response(null, { status: url.endsWith("/gone") ? 404 : 410 }));

      expect(await verifyPostTargets(backendDb, "post:1")).toMatchObject([
        { target: "instagram", ok: false, reason: "http_404" },
        { target: "threads_ru", ok: false, reason: "http_410" },
      ]);
    });
  });

  it("treats a provider 5xx as a failure too", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postId: 2, messageId: 2 });
      insertTarget(backendDb, { publicationKey: "post:2", target: "x", status: "published", url: "https://example.test/down" });
      stubFetch(() => new Response(null, { status: 503 }));

      expect(await verifyPostTargets(backendDb, "post:2")).toMatchObject([{ ok: false, reason: "http_503" }]);
    });
  });

  it("surfaces a transport error as the reason rather than throwing", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postId: 3, messageId: 3 });
      insertTarget(backendDb, { publicationKey: "post:3", target: "x", status: "published", url: "https://example.test/unreachable" });
      stubFetch(() => {
        throw new Error("connect ECONNREFUSED");
      });

      expect(await verifyPostTargets(backendDb, "post:3")).toMatchObject([{ ok: false, reason: "connect ECONNREFUSED" }]);
    });
  });

  it("prefers the stored error over the generic reason for an unpublished target", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postId: 4, messageId: 4 });
      insertTarget(backendDb, { publicationKey: "post:4", target: "x", status: "failed", error: "rate limited" });

      expect(await verifyPostTargets(backendDb, "post:4")).toMatchObject([{ ok: false, reason: "rate limited" }]);
    });
  });

  it("never calls out for a target that is not published", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postId: 5, messageId: 5 });
      insertTarget(backendDb, { publicationKey: "post:5", target: "x", status: "queued", url: "https://example.test/not-yet" });
      const { urls } = stubFetch(() => new Response("ok", { status: 200 }));

      expect(await verifyPostTargets(backendDb, "post:5")).toMatchObject([{ ok: false, reason: "not_published" }]);
      expect(urls).toEqual([]);
    });
  });

  it("returns targets ordered by name and ignores other posts' targets", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postId: 6, messageId: 6 });
      insertPost(backendDb, { postId: 7, messageId: 7 });
      for (const target of ["telegram", "instagram", "x"]) {
        insertTarget(backendDb, { publicationKey: "post:6", target, status: "queued" });
      }
      insertTarget(backendDb, { publicationKey: "post:7", target: "site", status: "queued" });

      expect((await verifyPostTargets(backendDb, "post:6")).map((record) => record.target)).toEqual(["instagram", "telegram", "x"]);
    });
  });

  it("does not let a redirect answer for the post", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postId: 121, messageId: 121 });
      insertTarget(backendDb, { publicationKey: "post:121", target: "telegram", status: "published", url: "https://t.me/alexgetman/121" });
      // A deleted post answered by a redirect to a profile page: the 200 at the
      // end of that chain is not the post, and it used to verify as ok.
      const { urls } = stubFetch((url) =>
        url.endsWith("/121")
          ? new Response(null, { status: 301, headers: { location: "https://t.me/alexgetman" } })
          : new Response("profile", { status: 200 }),
      );

      const [result] = await verifyPostTargets(backendDb, "post:121");
      expect(result).toMatchObject({ ok: false, reason: "http_301:https://t.me/alexgetman" });
      // The profile page is never asked: it is not the post.
      expect(urls).toEqual(["https://t.me/alexgetman/121"]);
    });
  });

  it("refuses a stored URL that does not name a public host", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postId: 122, messageId: 122 });
      // The URL is whatever the platform API reported at publish time, so the
      // container must not be talked into fetching its own network.
      insertTarget(backendDb, { publicationKey: "post:122", target: "telegram", status: "published", url: "http://127.0.0.1:8080/admin" });
      const { urls } = stubFetch(() => new Response("should not be asked", { status: 200 }));

      const [result] = await verifyPostTargets(backendDb, "post:122");
      expect(result).toMatchObject({ ok: false, reason: "unverifiable_url" });
      expect(urls).toEqual([]);
    });
  });
});
