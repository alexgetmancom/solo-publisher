import { type BackendDb, unsafeDb } from "../db/client.js";

/**
 * What every analytics answer was built from, cheap enough to ask each time.
 *
 * The halves of the dashboard each load a history once and cut every comparison
 * window from it, but until now each render loaded its own. A clock is the wrong
 * key for keeping one: an operator tapping through periods is slower than any
 * TTL worth having, so every tap reloaded everything, while any tap inside the
 * window could still be served data that had just changed. Raising the number
 * trades one fault for the other.
 *
 * This asks the question a cache actually has: has anything the answer depends
 * on moved? On the larger production Studio this costs 2.7 ms warm and 94 ms
 * cold, against 200-950 ms for the loads it saves. Callers compute it once per
 * screen request. One version for the whole read model rather than one per half --
 * they are read together, on one render, and a second name for "has the
 * dashboard's data changed" would be a second answer to drift from the first.
 *
 * Three kinds of change, all of which have to be caught. An insert moves a
 * count and a maximum id. A deletion moves the count but neither maximum. An
 * update to a row already there moves neither, which is why every table also
 * contributes its newest timestamp. And the answer depends on more than the
 * measurements themselves: the follower figures come from profile snapshots and
 * the catalogue from the connected channels, so a background collection or a
 * channel connected from another surface has to invalidate this too.
 */
export function analyticsDataVersion(backendDb: BackendDb): string {
  const row = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT (SELECT COUNT(*) FROM metric_samples) AS samples,
              (SELECT MAX(id) FROM metric_samples) AS lastSample,
              (SELECT MAX(sampled_at) FROM metric_samples) AS sampleTouched,
              (SELECT COUNT(*) FROM drafts) AS drafts,
              (SELECT MAX(updated_at) FROM drafts) AS draftTouched,
              (SELECT COUNT(*) FROM publication_targets) AS publicationTargets,
              (SELECT MAX(updated_at) FROM publication_targets) AS publicationTouched,
              (SELECT COUNT(*) FROM post_metrics) AS postMetrics,
              (SELECT MAX(sampled_at) FROM post_metrics) AS lastPostMetric,
              (SELECT COUNT(*) FROM video_metric_snapshots) AS snapshots,
              (SELECT MAX(id) FROM video_metric_snapshots) AS lastSnapshot,
              (SELECT MAX(sampled_at) FROM video_metric_snapshots) AS snapshotTouched,
              (SELECT COUNT(*) FROM video_targets) AS targets,
              (SELECT MAX(updated_at) FROM video_targets) AS targetTouched,
              (SELECT COUNT(*) FROM x_activity_items) AS xItems,
              (SELECT MAX(last_seen_at) FROM x_activity_items) AS lastXItem,
              (SELECT COUNT(*) FROM x_activity_metric_snapshots) AS xSnapshots,
              (SELECT MAX(id) FROM x_activity_metric_snapshots) AS lastXSnapshot,
              (SELECT COUNT(*) FROM creator_profiles) AS profiles,
              (SELECT MAX(updated_at) FROM creator_profiles) AS lastProfile,
              (SELECT COUNT(*) FROM creator_profile_snapshots) AS profileSnapshots,
              (SELECT MAX(id) FROM creator_profile_snapshots) AS lastProfileSnapshot,
              (SELECT COUNT(*) FROM channel_connections) AS channels,
              (SELECT MAX(updated_at) FROM channel_connections) AS channelTouched`,
    )
    .get() as Record<string, number | string | null>;
  return Object.values(row).join("|");
}

/**
 * One loaded history, kept until the data behind it moves.
 *
 * The video half carries its history on its bundle; the text and X halves had
 * no equivalent and reloaded theirs on every render -- 350-950 ms and 150-550 ms
 * of one Studio's, paid again for each tap. Same rule for all three: the answer
 * is good while the data is the version it was computed from.
 */
const histories = new WeakMap<BackendDb, Map<string, { version: string; value: unknown }>>();
const MAX_HISTORIES = 6;

export function cachedHistory<T>(backendDb: BackendDb, key: string, version: string, load: () => T): T {
  const entries = histories.get(backendDb) ?? new Map<string, { version: string; value: unknown }>();
  histories.set(backendDb, entries);
  const existing = entries.get(key);
  if (existing && existing.version === version) return existing.value as T;
  const value = load();
  entries.delete(key);
  entries.set(key, { version, value });
  while (entries.size > MAX_HISTORIES) {
    const oldest = entries.keys().next().value;
    if (typeof oldest !== "string") break;
    entries.delete(oldest);
  }
  return value;
}
