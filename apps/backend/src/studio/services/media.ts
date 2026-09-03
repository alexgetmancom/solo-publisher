import { importStudioMediaAsset, importStudioMediaFile } from "../../content/assets.js";
import type { BackendDb } from "../../db/client.js";
import { prepareStoryDerivative } from "../../delivery/story-derivatives.js";
import type { BackendConfig } from "../../foundation/config.js";
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
  return {
    import(actorId: number, input: MediaBytesInput) {
      return trackUsageAsync(backendDb, "studio.media.import", async () => {
        const asset = await importStudioMediaAsset(backendDb, config, actorId, input);
        await prepareStoryDerivative(config, asset);
        return asset;
      });
    },
    importFile(actorId: number, input: MediaFileInput) {
      return trackUsageAsync(backendDb, "studio.media.import", async () => {
        const asset = await importStudioMediaFile(backendDb, config, actorId, input);
        await prepareStoryDerivative(config, asset);
        return asset;
      });
    },
  };
}
