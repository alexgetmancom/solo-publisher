import { existsSync } from "node:fs";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";

export function videoSourcePath(backendDb: BackendDb, source: { studioMediaAssetId: number | null }): string | null {
  if (source.studioMediaAssetId === null) return null;
  const asset = backendDb.studioMediaAssets.get(source.studioMediaAssetId);
  return asset?.kind === "video" && existsSync(asset.localPath) ? asset.localPath : null;
}

export function videoPublicUrl(backendDb: BackendDb, config: BackendConfig, source: { studioMediaAssetId: number | null }): string {
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  // The public media route is content-addressed by sha256 so the unguessable
  // digest, not the enumerable asset id, is what grants read access.
  const asset = source.studioMediaAssetId === null ? null : backendDb.studioMediaAssets.get(source.studioMediaAssetId);
  if (!asset) throw new Error(`Studio media asset ${source.studioMediaAssetId} has no public URL`);
  return `${base}/media/video/asset/${asset.sha256}`;
}
