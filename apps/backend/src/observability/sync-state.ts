import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { analyticsSync } from "../db/schema.js";

type SyncClaim = {
  intervalSeconds: number;
  owner: string;
  /** Override only for work whose own timeout exceeds the normal API cycle. */
  leaseSeconds?: number;
};

const DEFAULT_SYNC_LEASE_SECONDS = 15 * 60;

/** Atomically reserves a due sync for one worker instance. Refresh cadence and
 * crash recovery are independent: a daily job must not hold a two-day lease. */
export function claimSync(backendDb: BackendDb, source: string, claim: SyncClaim): boolean {
  const now = new Date().toISOString();
  const dueBefore = new Date(Date.now() - claim.intervalSeconds * 1000).toISOString();
  const staleBefore = new Date(Date.now() - (claim.leaseSeconds ?? DEFAULT_SYNC_LEASE_SECONDS) * 1000).toISOString();
  unsafeDb(backendDb)
    .db.insert(analyticsSync)
    .values({ source, lastSyncedAt: new Date(0).toISOString(), lastSuccessAt: null, lastError: null, lockedBy: null, lockedAt: null })
    .onConflictDoNothing()
    .run();
  return Boolean(
    unsafeDb(backendDb)
      .db.update(analyticsSync)
      .set({ lockedBy: claim.owner, lockedAt: now })
      .where(
        and(
          eq(analyticsSync.source, source),
          lte(analyticsSync.lastSyncedAt, dueBefore),
          or(isNull(analyticsSync.lockedBy), isNull(analyticsSync.lockedAt), lt(analyticsSync.lockedAt, staleBefore)),
        ),
      )
      .returning({ source: analyticsSync.source })
      .get(),
  );
}

export function markSynced(backendDb: BackendDb, source: string, error: string | null = null, owner?: string): void {
  const lastSyncedAt = new Date().toISOString();
  if (!owner) {
    unsafeDb(backendDb)
      .db.insert(analyticsSync)
      .values({ source, lastSyncedAt, lastSuccessAt: error ? null : lastSyncedAt, lastError: error, lockedBy: null, lockedAt: null })
      .onConflictDoUpdate({
        target: analyticsSync.source,
        set: {
          lastSyncedAt,
          ...(error ? { lastError: error } : { lastSuccessAt: lastSyncedAt, lastError: null }),
          lockedBy: null,
          lockedAt: null,
        },
      })
      .run();
    return;
  }
  unsafeDb(backendDb)
    .db.update(analyticsSync)
    .set({
      lastSyncedAt,
      ...(error ? { lastError: error } : { lastSuccessAt: lastSyncedAt, lastError: null }),
      lockedBy: null,
      lockedAt: null,
    })
    .where(owner ? and(eq(analyticsSync.source, source), eq(analyticsSync.lockedBy, owner)) : eq(analyticsSync.source, source))
    .run();
}
