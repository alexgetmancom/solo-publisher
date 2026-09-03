import type { StudioMediaAssetRecord } from "../../application/ports.js";
import { storyTargetsEnabled, targetsRecord } from "../../botTargets.js";
import { effectivePostTargets } from "../../channels/registry.js";
import type { BackendDb } from "../../db/client.js";
import { prepareStoryDerivative } from "../../delivery/story-derivatives.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import { createStudioServices, type StudioServices } from "../../studio/services/index.js";
import { importTelegramAsset } from "./media-import.js";

type TelegramFileApi = {
  getFile(fileId: string): Promise<{ file_path?: string }>;
};

/** Converts Telegram transport file ids into Content-owned assets before a draft is written. */
export async function importTelegramMedia(
  api: TelegramFileApi,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  media: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const studioMedia = createStudioServices(backendDb, config).media;
  const imported: Record<string, unknown>[] = [];
  const assets: StudioMediaAssetRecord[] = [];
  for (const item of media) {
    const result = await importTelegramMediaItem(api, studioMedia, config, actorId, item);
    imported.push(result.item);
    if (result.asset) assets.push(result.asset);
  }
  prepareStoryDerivatives(backendDb, config, assets);
  return imported;
}

/**
 * The Story shapes of what just arrived, started where nobody waits for them.
 *
 * This is post media: the only media a Story is ever made of. A video uploaded
 * for YouTube goes through Content the same way and must not pay for an encode
 * nothing reads. Publishing renders whatever this did not finish, so a failure
 * here costs the operator nothing but the head start.
 */
function prepareStoryDerivatives(backendDb: BackendDb, config: BackendConfig, assets: StudioMediaAssetRecord[]): void {
  // Through the registry, because the stored selection is not the answer on its
  // own: a profile nobody has curated still ticks Story targets with no channel
  // connected for them, and those cannot publish anything.
  const selected = effectivePostTargets(backendDb, targetsRecord(backendDb.studioSettings.profile().defaultTargetsJson));
  if (!storyTargetsEnabled(selected)) return;
  for (const asset of assets) {
    void prepareStoryDerivative(config, asset).catch((error: unknown) => {
      log("warn", "story derivative not prepared at ingress", {
        assetId: asset.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

async function importTelegramMediaItem(
  api: TelegramFileApi,
  studioMedia: StudioServices["media"],
  config: BackendConfig,
  actorId: number,
  item: Record<string, unknown>,
): Promise<{ item: Record<string, unknown>; asset?: StudioMediaAssetRecord }> {
  if (item.asset_id != null || item.local_path != null || item.localPath != null) return { item };
  const fileId = string(item.file_id) ?? string(item.fileId);
  if (!fileId) throw new Error("Telegram media item has no file id.");
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a media file path.");
  const type = String(item.type ?? "photo").toLowerCase();
  const extension = type === "video" ? ".mp4" : ".jpg";
  const asset = await importTelegramAsset(studioMedia, config, actorId, file.file_path, {
    extension,
    filename: `telegram-${fileId}${extension}`,
    contentType: type === "video" ? "video/mp4" : "image/jpeg",
  });
  return {
    item: { ...item, asset_id: asset.id, local_path: asset.localPath, filename: asset.filename, mime_type: asset.mimeType },
    asset,
  };
}

function string(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
