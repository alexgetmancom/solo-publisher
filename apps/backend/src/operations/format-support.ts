import { asc, eq, sql } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { TARGETS } from "../botTargets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, formatSupport, mediaTestCases, publicationTargets } from "../db/schema.js";

const MEDIA_TEST_CASES = [
  ["T01", "text_only", "Text only", "Send a plain text message."],
  ["T02", "text_picture", "Text + picture", "Send 1 photo with caption."],
  ["T03", "text_pictures", "Text + pictures", "Send album with 2 photos and caption."],
  ["T04", "text_video", "Text + video", "Send 1 video with caption."],
  ["T05", "text_videos", "Text + videos", "Send album with 2 videos and caption."],
  ["T06", "pictures_only", "Pictures only", "Send album with 2 photos, no caption."],
  ["T07", "videos_only", "Videos only", "Send album with 2 videos, no caption."],
  ["T08", "video_picture", "Video + picture", "Send album with 1 video and 1 photo with caption."],
  ["T09", "videos_pictures", "Videos + pictures", "Send mixed photo/video album with caption."],
] as const;

// The curated subset a media-format test is graded against — deliberately not
// every target in TARGETS (stories and X are hand-driven and would keep every
// case "pending"). Validated against TARGETS at seed time so a renamed or
// removed target fails loudly here instead of quietly narrowing the grade.
const expectedTargets = ["telegram", "site_ru", "site_en", "threads_ru"];

/** Operations fixture registry for the media formats each target carries. */
export function seedFormatSupport(backendDb: BackendDb): void {
  const known = new Set<string>(TARGETS.map(({ id }) => id));
  const unknown = expectedTargets.filter((target) => !known.has(target));
  if (unknown.length) throw new Error(`format fixture references unknown targets: ${unknown.join(", ")}`);
  const now = new Date().toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const [testId, formatKey, title, recipe] of MEDIA_TEST_CASES) {
      tx.insert(mediaTestCases)
        .values({
          testId,
          formatKey,
          title,
          inputRecipe: recipe,
          expectedTargetsJson: JSON.stringify(expectedTargets),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: mediaTestCases.testId,
          set: { formatKey, title, inputRecipe: recipe, expectedTargetsJson: JSON.stringify(expectedTargets), updatedAt: now },
        })
        .run();
      for (const { id: target } of TARGETS)
        tx.insert(formatSupport).values({ target, formatKey, status: "unknown", updatedAt: now }).onConflictDoNothing().run();
    }
  });
}

export function recordFormatEvidence(backendDb: BackendDb, testId: string, postId: number, notes?: string): string {
  seedFormatSupport(backendDb);
  const test = unsafeDb(backendDb).db.select().from(mediaTestCases).where(eq(mediaTestCases.testId, testId)).get();
  if (!test) throw new Error(`unknown test: ${testId}`);
  const post = unsafeDb(backendDb).db.select({ postId: drafts.postId }).from(drafts).where(eq(drafts.postId, postId)).get();
  if (!post?.postId) throw new Error(`post not found: ${postId}`);
  const publicationKey = publicationRef("post", post.postId);
  const rows = unsafeDb(backendDb).db.select().from(publicationTargets).where(eq(publicationTargets.publicationKey, publicationKey)).all();
  const byTarget = new Map(rows.map((row) => [row.target, row]));
  const expected = JSON.parse(test.expectedTargetsJson) as string[];
  const statuses: string[] = [];
  const now = new Date().toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const { id: target } of TARGETS) {
      const row = byTarget.get(target);
      const status = row?.status === "published" ? "supported" : row?.skipped ? "blocked" : row?.status === "failed" ? "failed" : "unknown";
      if (expected.includes(target)) statuses.push(status);
      if (expected.includes(target) && ["supported", "failed", "blocked"].includes(status)) {
        tx.insert(formatSupport)
          .values({
            target,
            formatKey: test.formatKey,
            status,
            evidenceTestId: testId,
            evidenceMessageId: postId,
            evidenceUrl: row?.url ?? row?.externalId ?? null,
            notes: notes ?? null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [formatSupport.target, formatSupport.formatKey],
            set: {
              status,
              evidenceTestId: testId,
              evidenceMessageId: postId,
              evidenceUrl: row?.url ?? row?.externalId ?? null,
              notes: notes ?? null,
              updatedAt: now,
            },
          })
          .run();
      }
    }
    const testStatus = statuses.every((value) => value === "supported")
      ? "pass"
      : statuses.some((value) => value === "failed")
        ? "fail"
        : statuses.some((value) => value === "supported")
          ? "partial"
          : "pending";
    tx.update(mediaTestCases)
      .set({ status: testStatus, lastMessageId: postId, ...(notes ? { notes } : {}), updatedAt: now })
      .where(eq(mediaTestCases.testId, testId))
      .run();
  });
  return (
    unsafeDb(backendDb).db.select({ status: mediaTestCases.status }).from(mediaTestCases).where(eq(mediaTestCases.testId, testId)).get()
      ?.status ?? "pending"
  );
}

export function formatSupportSummary(backendDb: BackendDb): Record<string, unknown>[] {
  return unsafeDb(backendDb)
    .db.select({
      testId: mediaTestCases.testId,
      title: mediaTestCases.title,
      formatKey: mediaTestCases.formatKey,
      status: mediaTestCases.status,
      lastMessageId: mediaTestCases.lastMessageId,
      targets: sql<string>`json_group_object(${formatSupport.target}, ${formatSupport.status})`,
    })
    .from(mediaTestCases)
    .leftJoin(formatSupport, eq(formatSupport.formatKey, mediaTestCases.formatKey))
    .groupBy(mediaTestCases.testId)
    .orderBy(asc(mediaTestCases.testId))
    .all();
}
