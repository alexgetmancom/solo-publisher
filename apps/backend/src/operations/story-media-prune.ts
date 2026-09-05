import fs from "node:fs";
import path from "node:path";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { publishJobs } from "../db/schema.js";
import { storyDirectory } from "../delivery/story-media.js";
import type { BackendConfig } from "../foundation/config.js";
import { orphanedStoryVariants } from "./disk-report.js";

/**
 * Removes Story variants whose source is gone.
 *
 * Retention now takes a variant with the source it was made from, so this is for
 * what accumulated before that and for the residue of routes that no longer
 * exist -- files named for a draft rather than for their source's content, which
 * nothing in the system can reach any more.
 *
 * A file a publish job's payload still names is never removed, whatever the
 * report says about it: the payload is what a delivery already put in front of
 * an audience or is about to, and a Story it points at must stay readable until
 * that job is done with it.
 */
export function pruneOrphanedStoryMedia(backendDb: BackendDb, config: BackendConfig, apply: boolean): Record<string, unknown> {
  const directory = storyDirectory(config);
  const orphans = orphanedStoryVariants(backendDb, config);
  const claimed = payloadNamedFiles(backendDb);
  const removable = orphans.orphaned.filter((name) => !claimed.has(name));
  const held = orphans.orphaned.filter((name) => claimed.has(name));
  const bytes = removable.reduce((total, name) => total + fileBytes(path.join(directory, name)), 0);
  const base = {
    variants: orphans.total,
    orphaned: orphans.orphaned.length,
    removable: removable.length,
    removable_megabytes: Math.round((bytes / 1_048_576) * 10) / 10,
    held_by_a_publish_job: held,
    plan: removable.slice(0, 50),
  };
  if (!apply || removable.length === 0) return { ok: true, applied: false, ...base };
  let removed = 0;
  for (const name of removable) {
    fs.rmSync(path.join(directory, name), { force: true });
    removed += 1;
  }
  return { ok: true, applied: true, ...base, removed };
}

/** Every file name any publish job payload mentions. The payload's shape differs
 * per target and per era, so this reads it as the text it is stored as rather
 * than teaching this one command every spelling of a media item. */
function payloadNamedFiles(backendDb: BackendDb): Set<string> {
  const names = new Set<string>();
  const payloads = unsafeDb(backendDb).db.select({ payloadJson: publishJobs.payloadJson }).from(publishJobs).all();
  for (const row of payloads) {
    const text = typeof row.payloadJson === "string" ? row.payloadJson : JSON.stringify(row.payloadJson ?? "");
    for (const match of text.matchAll(/[A-Za-z0-9._-]+-story-(?:standard|telegram)[A-Za-z0-9._-]*\.(?:jpg|mp4)/g)) names.add(match[0]);
  }
  return names;
}

function fileBytes(target: string): number {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}
