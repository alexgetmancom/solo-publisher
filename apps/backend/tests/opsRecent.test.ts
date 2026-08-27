import { afterEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { publicationTargets } from "../src/db/schema.js";
import { findPublication, formatRecentPublications, recentPublications } from "../src/operations/recent.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";

let backendDb: UnsafeBackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

const USUAL = ["telegram", "threads_ru", "x"];

function seed(db: UnsafeBackendDb, count: number, gap: { postId: number; target: string }): void {
  const now = new Date().toISOString();
  for (let postId = 1; postId <= count; postId += 1) {
    seedTextPost(db, {
      postId,
      ru: `Headline ${postId}\n\nBody copy that identifies nothing.`,
      now: `2026-08-${String(postId).padStart(2, "0")}T10:00:00.000Z`,
    });
    for (const target of USUAL) {
      if (postId === gap.postId && target === gap.target) continue;
      db.db
        .insert(publicationTargets)
        .values({ publicationKey: `post:${postId}`, target, status: "published", updatedAt: now })
        .run();
    }
  }
}

describe("ops recent", () => {
  it("names a target the post never had without calling it a failure", () => {
    backendDb = openBackendDb(":memory:");
    seed(backendDb, 12, { postId: 12, target: "x" });

    const report = recentPublications(backendDb, 3);

    expect(report.expectedTargets).toEqual(USUAL);
    expect(report.posts[0]).toMatchObject({ ref: "post:12", headline: "Headline 12", absentTargets: ["x"], undelivered: [] });
    expect(report.posts[1]?.absentTargets).toEqual([]);
    expect(report.posts).toHaveLength(3);
  });

  /** The distinction the report exists for: sending a post to one channel on
   * purpose is not the same event as a channel refusing it, and reporting both
   * as MISSING made a fortnight of deliberate choices read as eight faults. */
  it("separates a target that failed from one that was never sent", () => {
    backendDb = openBackendDb(":memory:");
    seed(backendDb, 12, { postId: 12, target: "x" });
    backendDb.db
      .update(publicationTargets)
      .set({ status: "failed" })
      .where(and(eq(publicationTargets.publicationKey, "post:11"), eq(publicationTargets.target, "x")))
      .run();

    const text = formatRecentPublications(recentPublications(backendDb, 2));

    expect(text).toContain("not sent: x");
    expect(text).toContain("FAILED x=failed");
    expect(text).not.toContain("MISSING");
  });

  /** The JSON form runs to hundreds of lines, which is what sent the last
   * investigation to raw SQL instead of reading the answer off the screen. */
  it("prints two lines per post, delivery state first", () => {
    backendDb = openBackendDb(":memory:");
    seed(backendDb, 12, { postId: 12, target: "x" });

    const text = formatRecentPublications(recentPublications(backendDb, 5));

    expect(text.split("\n")).toHaveLength(12);
    expect(text).toContain("not sent: x");
    expect(text).toContain("Headline 12");
    expect(text).not.toContain("https://");
  });

  it("resolves a ref from the post text", () => {
    backendDb = openBackendDb(":memory:");
    seed(backendDb, 4, { postId: 4, target: "x" });

    const found = findPublication(backendDb, "headline 2");

    expect(found.matches.map((match) => match.ref)).toEqual(["post:2"]);
  });

  /** A match reported as complete by `find` and as a gap by `recent` would be
   * two answers to one question. */
  it("measures a match against the same baseline recent uses", () => {
    backendDb = openBackendDb(":memory:");
    seed(backendDb, 12, { postId: 12, target: "x" });

    const found = findPublication(backendDb, "headline 12");

    expect(found.expectedTargets).toEqual(USUAL);
    expect(found.matches[0]?.absentTargets).toEqual(["x"]);
  });
});
