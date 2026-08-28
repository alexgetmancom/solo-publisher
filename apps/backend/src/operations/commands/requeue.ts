import { eq } from "drizzle-orm";
import { targetLocale } from "../../botTargets.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../../db/client.js";
import { publicationTargets, publishJobs } from "../../db/schema.js";
import { attemptPublishedTargetRemovals, type TargetRemovalAttempt, type TargetRemovalResult } from "../../delivery/external-removals.js";
import type { BackendConfig } from "../../foundation/config.js";
import { RETRY_UNLESS_HELD, requeuePublicationTargetsTx } from "../../publishing/requeue.js";
import type { ResolvedPublicationRef } from "../publication-ref.js";

/** `ops retry` over one publication: which targets it names, and how its
 * result reads to an operator. The requeue itself belongs to Publishing, which
 * Studio's retry button also goes through — one job, one mechanism. */
function requeuePublicationTx(
  db: UnsafeBackendDb["db"],
  ref: ResolvedPublicationRef,
  source: Record<string, unknown>,
  target?: string,
): Record<string, unknown> {
  const scope = { postId: ref.postId, publicationKey: ref.publicationKey, messageId: ref.messageId };
  const targets = target ? [target] : jobbedTargets(db, ref);
  if (targets.length === 0) throw new Error("no publish jobs found");
  const results = requeuePublicationTargetsTx(db, scope, targets, {
    from: RETRY_UNLESS_HELD,
    // An operator naming one target may be restoring a publication whose job
    // rows were never created — after a channel was connected late, or a
    // publication was planned without it.
    createMissing: Boolean(target),
    // `ops retry` is the operator restoring a publication whatever state it
    // reached, including one they removed from the platform on purpose.
    audienceReached: "republish",
    source: () => source,
  });
  return {
    // Every target still held means nothing was requeued, and an operator
    // reading `ok: true` off `ops retry` would believe otherwise.
    ok: results.some((row) => row.outcome !== "not_retryable"),
    post_id: ref.postId,
    publication_key: ref.publicationKey,
    message_id: ref.messageId,
    target: target ?? null,
    targets: results.map((row) => row.target),
    results,
  };
}

/** Targets this publication has ever delivered to, newest job per target. */
function jobbedTargets(db: UnsafeBackendDb["db"], ref: ResolvedPublicationRef): string[] {
  const whereRef = eq(publishJobs.publicationKey, ref.publicationKey);
  return [
    ...new Set(
      db
        .select({ target: publishJobs.target })
        .from(publishJobs)
        .where(whereRef)
        .all()
        .map((row) => row.target),
    ),
  ];
}

export function requeuePublicationScopeTx(
  db: UnsafeBackendDb["db"],
  ref: ResolvedPublicationRef,
  source: Record<string, unknown>,
  target?: string,
  locale?: "ru" | "en",
): Record<string, unknown> {
  if (target || !locale) return requeuePublicationTx(db, ref, source, target);
  const targets = db
    .select({ target: publicationTargets.target })
    .from(publicationTargets)
    .where(eq(publicationTargets.publicationKey, ref.publicationKey))
    .all()
    .map((row) => row.target)
    .filter((value) => targetLocale(value) === locale);
  // A mutation that matched nothing is not a success. Silently returning an
  // empty result set reads as "done" to an operator running `ops retry`.
  if (targets.length === 0) throw new Error(`no ${locale} targets found for ${ref.publicationKey}`);
  return { ok: true, locale, results: targets.map((value) => requeuePublicationTx(db, ref, source, value)) };
}

export function requeueAfterRemovalTx(
  db: UnsafeBackendDb["db"],
  ref: ResolvedPublicationRef,
  source: Record<string, unknown>,
  removals: TargetRemovalResult[],
  target?: string,
): Record<string, unknown> {
  const succeeded = removals.filter((row) => row.ok === true && typeof row.target === "string").map((row) => row.target as string);
  // An explicitly selected target with no durable remote row is already gone;
  // it is safe to create its replacement. A deletion that was *attempted and
  // failed* is not that case, and falling back to the requested target on any
  // empty success list published a replacement next to a post still standing.
  const attempted = new Set(removals.filter((row) => row.skipped !== true).map((row) => row.target));
  const targets = target && !succeeded.includes(target) ? (attempted.has(target) ? [] : [target]) : succeeded;
  return { ok: targets.length > 0, results: targets.map((value) => requeuePublicationTx(db, ref, source, value)) };
}

/** Takes down and re-publishes the targets an edit could not reach in place.
 *
 * Which those are is the edit's own answer, not a second list here: a target
 * that reported `ok` was already rewritten, and deleting it afterwards produced
 * an edit, a deletion and a fresh publication of the same post. */
export async function attemptTextFallbackRemovals(
  backendDb: BackendDb,
  ref: ResolvedPublicationRef,
  config: BackendConfig,
  target: string | undefined,
  locale: "ru" | "en",
  fetchImpl: typeof fetch,
  edited: Array<Record<string, unknown>>,
): Promise<Array<{ target: string; attempts: TargetRemovalAttempt[] }>> {
  const rewritten = new Set(edited.filter((row) => row.ok === true && typeof row.target === "string").map((row) => row.target as string));
  const targets = unsafeDb(backendDb)
    .db.select({ target: publicationTargets.target })
    .from(publicationTargets)
    .where(eq(publicationTargets.publicationKey, ref.publicationKey))
    .all()
    .map((row) => row.target)
    .filter((value) => (!target || value === target) && targetLocale(value) === locale && !rewritten.has(value));
  const results: Array<{ target: string; attempts: TargetRemovalAttempt[] }> = [];
  for (const value of targets) {
    const attempts = await attemptPublishedTargetRemovals(
      backendDb,
      config,
      { publicationKey: ref.publicationKey, target: value },
      fetchImpl,
    );
    results.push({ target: value, attempts });
  }
  return results;
}
