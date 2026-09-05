import crypto from "node:crypto";
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import type { Clock, DraftTranslationStore } from "../../application/ports.js";
import { draftTranslations } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for the machine-translation queue. One row per draft, claimed
 * under a lease so a worker killed mid-translation does not lose the draft's
 * English: the next cycle takes the row back and asks the model again. */
export function createDraftTranslationStore(db: BackendDatabase, clock: Clock): DraftTranslationStore {
  const stamp = () => clock.now().toISOString();
  return {
    queue(draftId: number): void {
      const now = stamp();
      db.insert(draftTranslations)
        .values({
          draftId,
          status: "queued",
          attemptCount: 0,
          nextAttemptAt: now,
          lockedBy: null,
          lockedAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        })
        // An edited draft is translated again, and the row it left behind is the
        // same work item: re-queueing resets the attempts rather than stacking a
        // second one the primary key would refuse anyway.
        .onConflictDoUpdate({
          target: draftTranslations.draftId,
          set: { status: "queued", attemptCount: 0, nextAttemptAt: now, lockedBy: null, lockedAt: null, lastError: null, updatedAt: now },
        })
        .run();
    },

    pending(draftId: number): boolean {
      const row = db
        .select({ status: draftTranslations.status })
        .from(draftTranslations)
        .where(eq(draftTranslations.draftId, draftId))
        .get();
      return Boolean(row) && row?.status !== "failed";
    },

    claimDue(leaseMs: number) {
      const now = stamp();
      const cutoff = new Date(clock.now().getTime() - leaseMs).toISOString();
      // A claim abandoned mid-translation is taken back on its lease, and a row
      // left "translating" with no timestamp is already unowned: recover it on
      // sight rather than leaving it claimed forever.
      const due = or(
        and(eq(draftTranslations.status, "queued"), or(isNull(draftTranslations.nextAttemptAt), lte(draftTranslations.nextAttemptAt, now))),
        and(eq(draftTranslations.status, "translating"), or(isNull(draftTranslations.lockedAt), lt(draftTranslations.lockedAt, cutoff))),
      );
      const candidate = db
        .select({ draftId: draftTranslations.draftId })
        .from(draftTranslations)
        .where(due)
        .orderBy(asc(draftTranslations.createdAt), asc(draftTranslations.draftId))
        .get();
      if (!candidate) return null;
      const lockedBy = `translation:${process.pid}:${crypto.randomUUID()}`;
      // The claim carries the condition it was chosen under: another worker that
      // took this row between the select and here leaves it no longer due, and
      // this update then changes nothing instead of stealing a live claim.
      const claimed = db
        .update(draftTranslations)
        .set({ status: "translating", lockedBy, lockedAt: now, updatedAt: now })
        .where(and(eq(draftTranslations.draftId, candidate.draftId), due))
        .returning({ draftId: draftTranslations.draftId, attemptCount: draftTranslations.attemptCount })
        .get();
      return claimed ? { draftId: claimed.draftId, attemptCount: claimed.attemptCount, lockedBy } : null;
    },

    settle(draftId: number, lockedBy: string): void {
      db.delete(draftTranslations)
        .where(and(eq(draftTranslations.draftId, draftId), eq(draftTranslations.lockedBy, lockedBy)))
        .run();
    },

    fail(draftId: number, lockedBy: string, error: string, maxAttempts: number): void {
      const now = stamp();
      const attempt =
        (db
          .select({ attemptCount: draftTranslations.attemptCount })
          .from(draftTranslations)
          .where(eq(draftTranslations.draftId, draftId))
          .get()?.attemptCount ?? 0) + 1;
      const retry = attempt < maxAttempts;
      db.update(draftTranslations)
        .set({
          status: retry ? "queued" : "failed",
          attemptCount: attempt,
          nextAttemptAt: retry ? new Date(clock.now().getTime() + attempt * 5_000).toISOString() : null,
          lockedBy: null,
          lockedAt: null,
          lastError: error.slice(0, 500),
          updatedAt: now,
        })
        .where(and(eq(draftTranslations.draftId, draftId), eq(draftTranslations.lockedBy, lockedBy)))
        .run();
    },
  };
}
