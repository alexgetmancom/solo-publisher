import fs from "node:fs";
import path from "node:path";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { postLocales, studioMediaAssets } from "../db/schema.js";
import { storyDirectory } from "../delivery/story-media.js";
import type { BackendConfig } from "../foundation/config.js";
import { requiredDataDirectories } from "../foundation/runtime/data-dirs.js";
import { jsonRecordArray } from "../json.js";

type DirectoryUsage = { name: string; path: string; files: number; bytes: number };

/**
 * What this deployment's data volume is holding, and how much of it nothing
 * points at any more.
 *
 * The question this answers is whether the housekeeping is keeping up, so it
 * names the two kinds of leftover separately. Media caches age out on a TTL and
 * are supposed to hold something. Story derivatives do not: they are named after
 * their source's content hash and kept for as long as the source is, so a
 * variant whose source is gone is a file nothing will ever read or delete.
 */
export function diskReport(backendDb: BackendDb, config: BackendConfig): Record<string, unknown> {
  const directories = [
    ...requiredDataDirectories(config).map((entry) => usage(entry.name, entry.path)),
    usage("story-media", storyDirectory(config)),
  ];
  const database = fileBytes(config.PIPELINE_DB) + fileBytes(`${config.PIPELINE_DB}-wal`) + fileBytes(`${config.PIPELINE_DB}-shm`);
  const orphans = orphanedStoryVariants(backendDb, config);
  return {
    ok: true,
    database_bytes: database,
    directories: directories.map((entry) => ({ ...entry, megabytes: megabytes(entry.bytes) })),
    story_variants: {
      files: orphans.total,
      orphaned: orphans.orphaned.length,
      orphaned_bytes: orphans.bytes,
      orphaned_megabytes: megabytes(orphans.bytes),
      // Named, because an orphan is a bug's residue rather than a number to
      // watch: nothing removes these when the source they were made from goes.
      orphaned_files: orphans.orphaned.slice(0, 20),
    },
  };
}

/** A Story variant whose source is no longer on disk. The variant's name starts
 * with the source's content-addressed stem, which is the only link between the
 * two -- there is no table, on purpose. */
function orphanedStoryVariants(backendDb: BackendDb, config: BackendConfig): { total: number; orphaned: string[]; bytes: number } {
  const live = new Set<string>();
  for (const source of knownSources(backendDb)) if (fs.existsSync(source)) live.add(path.basename(source).replace(/\.[^.]+$/, ""));
  const directory = storyDirectory(config);
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : [];
  const variants = entries.filter((entry) => entry.isFile() && !entry.name.startsWith("."));
  const orphaned = variants.filter((entry) => !live.has(entry.name.replace(/-story-(standard|telegram)\.[^.]+$/, "")));
  return {
    total: variants.length,
    orphaned: orphaned.map((entry) => entry.name),
    bytes: orphaned.reduce((total, entry) => total + fileBytes(path.join(directory, entry.name)), 0),
  };
}

function knownSources(backendDb: BackendDb): string[] {
  const assets = unsafeDb(backendDb).db.select({ localPath: studioMediaAssets.localPath }).from(studioMediaAssets).all();
  const media = unsafeDb(backendDb).db.select({ mediaJson: postLocales.mediaJson }).from(postLocales).all();
  return [
    ...assets.map((asset) => asset.localPath),
    ...media.flatMap((locale) =>
      jsonRecordArray(locale.mediaJson).flatMap((item) => {
        const localPath = typeof item.local_path === "string" ? item.local_path : item.localPath;
        return typeof localPath === "string" ? [localPath] : [];
      }),
    ),
  ];
}

function usage(name: string, directory: string): DirectoryUsage {
  let files = 0;
  let bytes = 0;
  const walk = (current: string): void => {
    for (const entry of fs.existsSync(current) ? fs.readdirSync(current, { withFileTypes: true }) : []) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) {
        files += 1;
        bytes += fileBytes(target);
      }
    }
  };
  walk(directory);
  return { name, path: directory, files, bytes };
}

function fileBytes(target: string): number {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}

function megabytes(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 10) / 10;
}
