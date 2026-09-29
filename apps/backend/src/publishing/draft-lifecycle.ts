import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales, publicationCancellations, publishJobs, siteJobs } from "../db/schema.js";
import { discardDraftStoryCards } from "../story-cards/store.js";

export function scheduledDrafts(backendDb: BackendDb): Array<{ id: number; scheduledAt: string | null; scheduledEnAt: string | null }> {
  return unsafeDb(backendDb)
    .db.select({ id: drafts.id, scheduledAt: drafts.scheduledAt, scheduledEnAt: drafts.scheduledEnAt })
    .from(drafts)
    .where(eq(drafts.status, "scheduled"))
    .orderBy(asc(sql`coalesce(${drafts.scheduledAt}, ${drafts.scheduledEnAt})`), asc(drafts.id))
    .all();
}

export function cancelDraft(backendDb: BackendDb, draftId: number, actorId: number): void {
  const now = new Date().toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
    const publication = tx.select({ postId: drafts.postId }).from(drafts).where(eq(drafts.id, draftId)).get();
    const postId = publication?.postId;
    tx.update(drafts)
      .set({ status: "cancelled", scheduledAt: null, scheduledEnAt: null, updatedAt: now })
      .where(eq(drafts.id, draftId))
      .run();
    if (!postId) return;
    const publicationKey = publicationRef("post", postId);
    const finalSocialCount =
      tx
        .select({ count: count() })
        .from(publishJobs)
        .where(
          and(
            eq(publishJobs.publicationKey, publicationKey),
            inArray(publishJobs.status, ["publishing", "published", "skipped", "verification_required"]),
          ),
        )
        .get()?.count ?? 0;
    const finalSiteCount =
      tx
        .select({ count: count() })
        .from(siteJobs)
        .where(and(eq(siteJobs.publicationKey, publicationKey), inArray(siteJobs.status, ["rendering", "published"])))
        .get()?.count ?? 0;
    const finalCount = finalSocialCount + finalSiteCount;
    if (finalCount > 0) {
      // Something of this publication is already out, so the jobs stay as the
      // record of it -- and the cancellation is declared, so a worker that has
      // one of them in hand cannot start another delivery under it.
      tx.insert(publicationCancellations).values({ publicationKey, actorId, requestedAt: now }).onConflictDoNothing().run();
      tx.update(publishJobs)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(publishJobs.publicationKey, publicationKey), inArray(publishJobs.status, ["queued", "failed"])))
        .run();
      tx.update(siteJobs)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(siteJobs.publicationKey, publicationKey), inArray(siteJobs.status, ["queued", "failed"])))
        .run();
      return;
    }
    tx.delete(publishJobs).where(eq(publishJobs.publicationKey, publicationKey)).run();
    tx.delete(siteJobs).where(eq(siteJobs.publicationKey, publicationKey)).run();
    tx.update(postLocales)
      .set({
        slug: null,
        html: null,
        storyMediaJson: null,
        siteMediaJson: null,
        siteEnabled: 0,
        publishAt: null,
        publishedAt: null,
        updatedAt: now,
      })
      .where(eq(postLocales.draftId, draftId))
      .run();
    tx.update(drafts)
      .set({ postId: null, publishMode: null, scheduledAt: null, scheduledEnAt: null, updatedAt: now })
      .where(eq(drafts.id, draftId))
      .run();
  });
  discardDraftStoryCards(unsafeDb(backendDb).db, draftId);
  backendDb.events.record({
    ref: publicationRef("draft", draftId),
    type: "publishing.draft.cancelled",
    severity: "info",
    message: `Publication for draft #${draftId} cancelled`,
  });
}
