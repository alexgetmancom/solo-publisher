import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { studioMediaAssets } from "../db/schema.js";

/** The video a platform importer fetches by content hash while it imports a
 * Reel. Anything that is not a video under that hash does not exist here. */
export function publicVideoAsset(backendDb: BackendDb, sha256: string): { localPath: string; mimeType: string | null } | undefined {
  const asset = unsafeDb(backendDb)
    .db.select({ kind: studioMediaAssets.kind, localPath: studioMediaAssets.localPath, mimeType: studioMediaAssets.mimeType })
    .from(studioMediaAssets)
    .where(eq(studioMediaAssets.sha256, sha256))
    .get();
  return asset?.kind === "video" ? { localPath: asset.localPath, mimeType: asset.mimeType } : undefined;
}
