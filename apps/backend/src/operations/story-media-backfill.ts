import fs from "node:fs";
import { eq } from "drizzle-orm";
import { storyTargetsEnabled } from "../botTargets.js";
import { publishesStory, registeredPostTargetIds } from "../channels/registry.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales, studioMediaAssets } from "../db/schema.js";
import { ensureStoryDerivative, storyDerivativePresent } from "../delivery/story-derivatives.js";
import type { BackendConfig } from "../foundation/config.js";
import { jsonObject } from "../json.js";

type Source = { localPath: string; video: boolean; origin: "asset" | "draft"; wanted: boolean };

/**
 * Renders the Story shapes that a publication is going to ask for and not find.
 *
 * Preparation happens where a draft says it publishes a Story, and delivery only
 * ever reads the result. This exists for what predates that path or lost its
 * files with a disk: without it, delivery is where the gap would surface, and it
 * would surface as a refused publication.
 *
 * `missing_wanted` is the number that matters -- a draft that publishes a Story
 * points at that file, so the publication will refuse. `missing_unused` is media
 * no Story has been asked of; it is reported because a draft can still turn a
 * Story target on, and left alone because rendering it is 8-12 seconds per video
 * spent on a question nobody has asked. `all` renders those too.
 *
 * The work is one encode at a time and `limit` is how it is run in batches; a
 * source whose file is gone is reported rather than rendered, because there is
 * nothing left to render it from.
 */
export async function backfillStoryMedia(
  backendDb: BackendDb,
  config: BackendConfig,
  apply: boolean,
  limit: number,
  all = false,
): Promise<Record<string, unknown>> {
  const connected = Object.fromEntries([...registeredPostTargetIds(backendDb)].map((target) => [target, true]));
  if (!storyTargetsEnabled(connected))
    return { ok: true, applied: false, story_targets_connected: false, missing_wanted: 0, note: "this Studio publishes no Stories" };
  const sources = collectSources(backendDb);
  const gone: Source[] = [];
  const prepared: Source[] = [];
  const missing: Source[] = [];
  for (const source of sources) {
    if (!fs.existsSync(source.localPath)) gone.push(source);
    else if (storyDerivativePresent(config, source.localPath, source.video)) prepared.push(source);
    else missing.push(source);
  }
  // Wanted first either way: a publication that is going to refuse is the work,
  // and the rest is preparation for a decision nobody has made yet.
  const queue = [...missing.filter((source) => source.wanted), ...(all ? missing.filter((source) => !source.wanted) : [])];
  const base = {
    story_targets_connected: true,
    sources: sources.length,
    prepared: prepared.length,
    missing_wanted: missing.filter((source) => source.wanted).length,
    missing_unused: missing.filter((source) => !source.wanted).length,
    source_file_gone: gone.length,
    all,
    plan: queue.slice(0, limit).map((source) => ({ local_path: source.localPath, video: source.video, origin: source.origin })),
  };
  if (!apply || queue.length === 0) return { ok: true, applied: false, ...base };
  const rendered: string[] = [];
  const failed: Array<{ local_path: string; error: string }> = [];
  for (const source of queue.slice(0, limit)) {
    try {
      await ensureStoryDerivative(config, source.localPath, source.video, { source: "backfill" });
      rendered.push(source.localPath);
    } catch (error) {
      failed.push({ local_path: source.localPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: failed.length === 0, applied: true, ...base, rendered: rendered.length, failed, remaining: queue.length - rendered.length };
}

/** Every local file a Story could be made of, each one once, and whether a draft
 * that publishes a Story actually points at it. Two origins name the same file
 * whenever a draft points at an asset, and the content-addressed path is what
 * says they are the same. */
function collectSources(backendDb: BackendDb): Source[] {
  const wanted = new Set<string>();
  const byPath = new Map<string, Source>();
  for (const locale of unsafeDb(backendDb)
    .db.select({ targetsJson: drafts.targetsJson, mediaJson: postLocales.mediaJson })
    .from(postLocales)
    .innerJoin(drafts, eq(drafts.id, postLocales.draftId))
    .all()) {
    const draftWantsStory = publishesStory(backendDb, locale.targetsJson);
    for (const item of mediaItems(locale.mediaJson)) {
      const localPath = pathOf(item);
      if (!localPath) continue;
      if (draftWantsStory) wanted.add(localPath);
      const existing = byPath.get(localPath);
      if (existing) existing.wanted ||= draftWantsStory;
      else byPath.set(localPath, { localPath, video: isVideo(item), origin: "draft", wanted: draftWantsStory });
    }
  }
  for (const asset of unsafeDb(backendDb)
    .db.select({ localPath: studioMediaAssets.localPath, kind: studioMediaAssets.kind })
    .from(studioMediaAssets)
    .all()) {
    if (!asset.localPath || byPath.has(asset.localPath)) continue;
    byPath.set(asset.localPath, {
      localPath: asset.localPath,
      video: asset.kind === "video",
      origin: "asset",
      wanted: wanted.has(asset.localPath),
    });
  }
  return [...byPath.values()];
}

function pathOf(item: Record<string, unknown>): string | null {
  if (typeof item.local_path === "string") return item.local_path;
  return typeof item.localPath === "string" ? item.localPath : null;
}

function isVideo(item: Record<string, unknown>): boolean {
  return String(item.type ?? "")
    .toLowerCase()
    .includes("video");
}

function mediaItems(value: unknown): Record<string, unknown>[] {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  return Array.isArray(parsed) ? parsed.map(jsonObject) : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}
