import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
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
  for (const item of media) imported.push(await importTelegramMediaItem(api, studioMedia, config, actorId, item));
  return imported;
}

async function importTelegramMediaItem(
  api: TelegramFileApi,
  studioMedia: StudioServices["media"],
  config: BackendConfig,
  actorId: number,
  item: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (item.asset_id != null || item.local_path != null || item.localPath != null) return item;
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
    ...item,
    asset_id: asset.id,
    local_path: asset.localPath,
    filename: asset.filename,
    mime_type: asset.mimeType,
  };
}

function string(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
