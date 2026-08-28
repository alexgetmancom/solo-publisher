import { and, eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../db/client.js";
import { publicationTargets } from "../db/schema.js";

/**
 * What a publication turned out to be, learned from somewhere other than the
 * delivery that made it.
 *
 * `publication_targets` is the row that says what the audience has, and
 * Delivery owns writing it. Analytics learns things about the same publication
 * — an export lists a post the queue never delivered, a metrics collector is
 * handed the canonical permalink — and used to write those findings into the
 * column itself, in its own hand-written SQL, next to the delivery's. Two areas
 * spelling the same upsert is how one of them ends up missing the condition the
 * other one carries.
 *
 * So the findings come here instead. Analytics still decides what it observed;
 * this decides what that is allowed to do to a delivery.
 */

export type ObservedPublication = {
  publicationKey: string;
  target: string;
  externalId: string;
  externalIds: string[];
  url: string;
  observedAt: string;
  evidence: Record<string, unknown>;
};

/** Records publications an import found on the platform.
 *
 * Runs inside the caller's transaction, on the raw handle the importer already
 * holds: one prepared statement reused across an export's worth of rows.
 *
 * `deleted` is excluded on purpose — it is a decision about the remote object,
 * and an export taken before the takedown still lists the post. Every other
 * state is analytics catching delivery up. */
export function recordObservedPublications(sqlite: UnsafeBackendDb["sqlite"], observations: readonly ObservedPublication[]): number {
  if (observations.length === 0) return 0;
  const statement = sqlite.prepare(
    `INSERT INTO publication_targets (publication_key, target, status, external_id, external_ids_json, url, error, skipped, updated_at, raw_json)
     VALUES (?, ?, 'published', ?, ?, ?, NULL, 0, ?, ?)
     ON CONFLICT(publication_key, target) DO UPDATE SET
       status='published', external_id=excluded.external_id, external_ids_json=excluded.external_ids_json,
       url=excluded.url, error=NULL, skipped=0, updated_at=excluded.updated_at, raw_json=excluded.raw_json
     WHERE publication_targets.status <> 'deleted'`,
  );
  let written = 0;
  for (const observation of observations) {
    written += Number(
      statement.run(
        observation.publicationKey,
        observation.target,
        observation.externalId,
        JSON.stringify(observation.externalIds),
        observation.url,
        observation.observedAt,
        JSON.stringify(observation.evidence),
      ).changes,
    );
  }
  return written;
}

/** Records the canonical link a collector was handed for a publication that is
 * already delivered. Only the address is learned here, so only the address is
 * written: a collector must not be able to move a target's status or its
 * external id, which are the delivery's own answer. */
export function recordObservedPublicationUrl(
  tx: UnsafeBackendDb["db"],
  publicationKey: string,
  target: string,
  url: string,
  observedAt: string,
): void {
  tx.update(publicationTargets)
    .set({ url, updatedAt: observedAt })
    .where(and(eq(publicationTargets.publicationKey, publicationKey), eq(publicationTargets.target, target)))
    .run();
}
