import { type BackendDb, unsafeDb } from "../db/client.js";
import { editorialTexts, matchEditorialPost } from "./x-post-matching.js";

/** Stamped on every row an X analytics export produced: the activity item, the
 * metric samples, and the publication target the link attaches them to. A
 * target carrying it was linked from analytics, never delivered by the queue,
 * which is what tells the consistency report not to compare it to a job. */
export const X_ANALYTICS_SOURCE = "x_csv_export";

type XLink = { xPostId: string; publicationKey: string; matchedBy: "external_id" | "direct_text" };

export type XAttachResult = {
  links: XLink[];
  insertedSamples: number;
  updatedMetrics: number;
};

/** Attaches account-wide X activity to the editorial posts it belongs to, then
 * projects the metrics of every linked item into the post's own history.
 *
 * Both halves are idempotent and cover the whole table, so an import and a
 * later re-run of this same pass produce the same state: linking rules that
 * change reach the rows that were already imported, without re-importing them. */
export function attachXActivityToPosts(backendDb: BackendDb, apply: boolean): XAttachResult {
  const sqlite = unsafeDb(backendDb).sqlite;
  const targets = sqlite
    .prepare("SELECT publication_key, external_id, external_ids_json FROM publication_targets WHERE target='x'")
    .all() as Array<{
    publication_key: string;
    external_id: string | null;
    external_ids_json: string | null;
  }>;
  const postByExternalId = new Map<string, string>();
  const idsByPost = new Map<string, Set<string>>();
  for (const target of targets) {
    const ids = new Set([target.external_id, ...jsonStrings(target.external_ids_json)].filter((id): id is string => Boolean(id)));
    idsByPost.set(target.publication_key, ids);
    for (const id of ids) postByExternalId.set(id, target.publication_key);
  }
  const unlinked = sqlite
    .prepare(
      "SELECT x_post_id AS xPostId, kind, text, published_at AS publishedAt FROM x_activity_items WHERE linked_publication_key IS NULL",
    )
    .all() as Array<{ xPostId: string; kind: string; text: string; publishedAt: string | null }>;
  const editorial = editorialTexts(backendDb);
  const links: XLink[] = [];
  for (const item of unlinked) {
    const byId = postByExternalId.get(item.xPostId);
    const publicationKey = byId ?? (item.kind === "standalone" ? matchEditorialPost(item, editorial) : null);
    if (!publicationKey) continue;
    links.push({ xPostId: item.xPostId, publicationKey, matchedBy: byId ? "external_id" : "direct_text" });
  }
  if (!apply) return { links, insertedSamples: 0, updatedMetrics: 0 };

  // An import must not resurrect a target the operator took down: `deleted` is
  // a decision about the remote object, and an export taken before it still
  // lists the post. Every other state is analytics catching delivery up.
  const linkTarget = sqlite.prepare(
    `INSERT INTO publication_targets (publication_key, target, status, external_id, external_ids_json, url, error, skipped, updated_at, raw_json)
     VALUES (?, 'x', 'published', ?, ?, ?, NULL, 0, ?, ?)
     ON CONFLICT(publication_key, target) DO UPDATE SET
       status='published', external_id=excluded.external_id, external_ids_json=excluded.external_ids_json,
       url=excluded.url, error=NULL, skipped=0, updated_at=excluded.updated_at, raw_json=excluded.raw_json
     WHERE publication_targets.status <> 'deleted'`,
  );
  const linkItem = sqlite.prepare("UPDATE x_activity_items SET linked_publication_key=? WHERE x_post_id=?");
  return sqlite.transaction(() => {
    const now = new Date().toISOString();
    for (const link of links) {
      const ids = idsByPost.get(link.publicationKey) ?? new Set<string>();
      ids.add(link.xPostId);
      idsByPost.set(link.publicationKey, ids);
      linkTarget.run(
        link.publicationKey,
        link.xPostId,
        JSON.stringify([...ids]),
        `https://x.com/i/web/status/${link.xPostId}`,
        now,
        JSON.stringify({ source: X_ANALYTICS_SOURCE, x_post_id: link.xPostId, matched_by: link.matchedBy }),
      );
      linkItem.run(link.publicationKey, link.xPostId);
    }
    // Every snapshot of a linked item belongs in that post's immutable history,
    // and the newest one is what Command Center renders. A live sample that is
    // newer than the export wins: an import must not walk a metric backwards.
    const insertedSamples = sqlite
      .prepare(
        `INSERT INTO metric_samples (publication_key, target, metric_name, value, sampled_at, source)
         SELECT item.linked_publication_key,'x',snapshot.metric_name,snapshot.value,snapshot.sampled_at,'${X_ANALYTICS_SOURCE}'
         FROM x_activity_metric_snapshots AS snapshot
         INNER JOIN x_activity_items AS item ON item.x_post_id=snapshot.x_post_id
         WHERE item.linked_publication_key IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM metric_samples AS sample
             WHERE sample.publication_key=item.linked_publication_key AND sample.target='x'
               AND sample.metric_name=snapshot.metric_name AND sample.sampled_at=snapshot.sampled_at
               AND sample.source='${X_ANALYTICS_SOURCE}')`,
      )
      .run();
    const updatedMetrics = sqlite
      .prepare(
        `INSERT INTO post_metrics (publication_key, target, metric_name, value, unit, source, sampled_at, error, raw_json)
         SELECT item.linked_publication_key,'x',snapshot.metric_name,snapshot.value,'count','${X_ANALYTICS_SOURCE}',snapshot.sampled_at,NULL,
                json_object('x_post_id',snapshot.x_post_id)
         FROM x_activity_metric_snapshots AS snapshot
         INNER JOIN x_activity_items AS item ON item.x_post_id=snapshot.x_post_id
         INNER JOIN (
           SELECT x_post_id,metric_name,max(sampled_at) AS sampled_at
           FROM x_activity_metric_snapshots GROUP BY x_post_id,metric_name
         ) AS latest
           ON latest.x_post_id=snapshot.x_post_id AND latest.metric_name=snapshot.metric_name
             AND latest.sampled_at=snapshot.sampled_at
         WHERE item.linked_publication_key IS NOT NULL
         ON CONFLICT(publication_key, target, metric_name) DO UPDATE SET
           value=excluded.value, unit=excluded.unit, source=excluded.source, sampled_at=excluded.sampled_at,
           error=NULL, raw_json=excluded.raw_json
         WHERE excluded.sampled_at > post_metrics.sampled_at`,
      )
      .run();
    return { links, insertedSamples: Number(insertedSamples.changes), updatedMetrics: Number(updatedMetrics.changes) };
  })();
}

function jsonStrings(value: string | null): string[] {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  } catch {
    return [];
  }
}
