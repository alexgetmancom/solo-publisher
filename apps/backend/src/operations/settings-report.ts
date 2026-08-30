import { syncStateFor } from "../analytics/snapshots/creator-store.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { createStudioServices } from "../studio/services/index.js";

/** What the settings screens hold, plus what the daily digest actually did.
 * A digest that fails records its error and then is not due again for a day,
 * so the failure is otherwise visible only in a log line that a redeploy takes
 * with it. */
export function settingsReport(backendDb: BackendDb, config: BackendConfig) {
  const settings = createStudioServices(backendDb, config).settings;
  const newsDigest = settings.newsDigest();
  const profile = settings.studioProfile();
  return {
    // The Studio's zone: the one the daily schedules below actually fire in.
    timezone: profile.timezone,
    youtubeSignature: settings.youtubeSignature(),
    newsDigest: {
      enabled: newsDigest.enabled,
      at: `${String(newsDigest.hour).padStart(2, "0")}:${String(newsDigest.minute).padStart(2, "0")}`,
      promptCharacters: newsDigest.prompt.length,
      effort: newsDigest.effort,
      runs: syncStateFor(backendDb, "news_digest:"),
    },
    weeklyDigest: settings.weeklyDigest(),
    backup: settings.backup(),
    administrators: config.CONTROLLER_ADMIN_IDS.map((actorId) => ({
      actorId,
      locale: settings.locale(actorId),
      notifications: settings.notifications(actorId),
    })),
  };
}
