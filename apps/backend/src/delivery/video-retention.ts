import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { postLocales, studioMediaAssets, videoDrafts } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { jsonRecordArray } from "../json.js";
import { storyVariantPaths } from "./story-derivatives.js";

/** Reclaims video source files whose drafts are final and past their
 * retention window. Runs at the tail of every video cycle; deliberately
 * separate from job execution — it touches no jobs, locks or targets. */
export function pruneExpiredVideos(config: BackendConfig, backendDb: BackendDb): void {
  const now = new Date().toISOString();
  const legacyDraftExpiresAt = new Date(Date.now() - config.VIDEO_MEDIA_RETENTION_HOURS * 60 * 60_000).toISOString();
  const rows = unsafeDb(backendDb)
    .db.select()
    .from(videoDrafts)
    .where(
      and(
        // The source is reclaimed exactly once. retentionUntil cannot record
        // that: it is recomputed from scratch on every target change, and the
        // sweep itself used to clear it — so a long-finished draft matched the
        // legacy branch again one retention window later, and every window
        // after that, re-touching updatedAt (which orders the Studio video
        // list) on a draft nobody had opened in months.
        isNull(videoDrafts.sourcePrunedAt),
        or(
          and(
            lte(videoDrafts.retentionUntil, now),
            or(
              eq(videoDrafts.status, "published"),
              eq(videoDrafts.status, "partial"),
              eq(videoDrafts.status, "cancelled"),
              eq(videoDrafts.status, "editing"),
            ),
          ),
          // Before Studio assets gained the same retention policy, final drafts
          // had their deadline cleared while their source file lived forever.
          // Pick those up once they have been final for a full retention window.
          and(
            isNull(videoDrafts.retentionUntil),
            inArray(videoDrafts.status, ["published", "partial", "cancelled"]),
            lte(videoDrafts.updatedAt, legacyDraftExpiresAt),
          ),
          and(eq(videoDrafts.status, "editing"), isNull(videoDrafts.retentionUntil), lte(videoDrafts.createdAt, legacyDraftExpiresAt)),
        ),
      ),
    )
    .all();
  for (const row of rows) {
    // Claim the draft before touching the file. The decision above is a
    // snapshot, and a retry or a reschedule arriving in that window puts the
    // draft back to work — deleting its source afterwards would leave a job
    // pointing at bytes that are gone. The claim carries the status and the
    // deadline it was decided on, so a draft that moved is simply skipped and
    // the next sweep re-decides it.
    const claimed = unsafeDb(backendDb)
      .db.update(videoDrafts)
      .set({
        status: row.status === "editing" ? "cancelled" : row.status,
        retentionUntil: null,
        sourcePrunedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(videoDrafts.id, row.id),
          isNull(videoDrafts.sourcePrunedAt),
          eq(videoDrafts.status, row.status),
          row.retentionUntil == null ? isNull(videoDrafts.retentionUntil) : eq(videoDrafts.retentionUntil, row.retentionUntil),
        ),
      )
      .returning({ id: videoDrafts.id })
      .get();
    if (!claimed) continue;
    pruneStudioAssetSource(config, backendDb, row.studioMediaAssetId, now);
  }
}

/** Studio metadata remains available for published-history and analytics, but
 * the original upload is disposable after every draft using it is final. */
function pruneStudioAssetSource(config: BackendConfig, backendDb: BackendDb, assetId: number, now: string): void {
  const drafts = unsafeDb(backendDb)
    .db.select({ status: videoDrafts.status, retentionUntil: videoDrafts.retentionUntil })
    .from(videoDrafts)
    .where(eq(videoDrafts.studioMediaAssetId, assetId))
    .all();
  if (
    !drafts.length ||
    !drafts.every(
      (draft) =>
        ["published", "partial", "cancelled"].includes(draft.status) && (draft.retentionUntil == null || draft.retentionUntil <= now),
    )
  )
    return;
  // Never remove a shared source merely because the video side became final.
  if (postDraftReferencesAsset(backendDb, assetId)) return;
  const asset = unsafeDb(backendDb)
    .db.select({ localPath: studioMediaAssets.localPath, kind: studioMediaAssets.kind })
    .from(studioMediaAssets)
    .where(eq(studioMediaAssets.id, assetId))
    .get();
  if (!asset || !isManagedVideoSource(config, asset.localPath)) return;
  fs.rmSync(asset.localPath, { force: true });
  // A Story variant is kept for exactly as long as the source it was made from:
  // it is named after that source's content hash and nothing else will ever look
  // for it again. Left behind, it is a file no path in the system can reach --
  // 20 MB per video, forever.
  for (const variant of Object.values(storyVariantPaths(config, asset.localPath, asset.kind === "video")))
    fs.rmSync(variant, { force: true });
}

/** Post attachments still use durable JSON rather than a foreign key, so the
 * only way to know an asset is unreferenced is to read every draft's media. */
export function postDraftReferencesAsset(backendDb: BackendDb, assetId: number): boolean {
  return unsafeDb(backendDb)
    .db.select({ mediaJson: postLocales.mediaJson })
    .from(postLocales)
    .all()
    .some((locale) => jsonRecordArray(locale.mediaJson).some((item) => Number(item.asset_id) === assetId));
}

function isManagedVideoSource(config: BackendConfig, source: string): boolean {
  const resolved = path.resolve(source);
  const directory = path.resolve(config.STUDIO_MEDIA_DIR);
  return resolved.startsWith(`${directory}${path.sep}`);
}
