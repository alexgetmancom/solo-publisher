import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { createStudioServices } from "../studio/services/index.js";

/** What the settings screens hold. */
export function settingsReport(backendDb: BackendDb, config: BackendConfig) {
  const settings = createStudioServices(backendDb, config).settings;
  const profile = settings.studioProfile();
  return {
    timezone: profile.timezone,
    youtubeSignature: settings.youtubeSignature(),
    backup: settings.backup(),
    administrators: config.CONTROLLER_ADMIN_IDS.map((actorId) => ({
      actorId,
      locale: settings.locale(actorId),
      notifications: settings.notifications(actorId),
    })),
  };
}
