import type { StudioMediaAssetRecord } from "../../application/ports.js";
import { storyTargetsEnabled, targetsRecord } from "../../botTargets.js";
import { effectivePostTargets } from "../../channels/registry.js";
import { importStudioMediaAsset, importStudioMediaFile } from "../../content/assets.js";
import type { BackendDb } from "../../db/client.js";
import { prepareStoryDerivative } from "../../delivery/story-derivatives.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import { trackUsageAsync } from "../../observability/usage.js";

type MediaBytesInput = Parameters<typeof importStudioMediaAsset>[3];
type MediaFileInput = Parameters<typeof importStudioMediaFile>[3];

/**
 * Content media ingress exposed through the Studio boundary.
 *
 * Adapters may choose bytes or a temporary file depending on what the
 * transport provides, but validation, hashing, deduplication and ownership
 * always happen in Content through this service.
 */
export function mediaService(backendDb: BackendDb, config: BackendConfig) {
  const prepareStory = async (asset: StudioMediaAssetRecord) => {
    // A Studio that publishes no Stories has nothing to prepare them for, and
    // the encode is the heaviest thing this process does. Read the selection the
    // way the operator's own screen reads it: through the registry, because a
    // profile nobody has curated still carries Story targets with no channel
    // connected for them.
    const selected = effectivePostTargets(backendDb, targetsRecord(backendDb.studioSettings.profile().defaultTargetsJson));
    if (!storyTargetsEnabled(selected)) return;
    // Best effort by design: this is the fast path, not the only one. Publishing
    // renders what is missing, so a failed encode must not cost the operator the
    // upload -- least of all the eighth file of an album.
    await prepareStoryDerivative(config, asset).catch((error: unknown) => {
      log("warn", "story derivative not prepared at ingress", {
        assetId: asset.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  return {
    import(actorId: number, input: MediaBytesInput) {
      return trackUsageAsync(backendDb, "studio.media.import", async () => {
        const asset = await importStudioMediaAsset(backendDb, config, actorId, input);
        await prepareStory(asset);
        return asset;
      });
    },
    importFile(actorId: number, input: MediaFileInput) {
      return trackUsageAsync(backendDb, "studio.media.import", async () => {
        const asset = await importStudioMediaFile(backendDb, config, actorId, input);
        await prepareStory(asset);
        return asset;
      });
    },
  };
}
