import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { encryptionKey, open, seal } from "../foundation/secret-box.js";
import type { VideoLocale } from "../publishing/video-types.js";
import { channelIdentity } from "./identity.js";
import { platformToken, storePlatformToken } from "./platform-token-store.js";

/** Where a connected YouTube channel's renewal credential lives, by language.
 * The name matches the registry's channel id, which is how every other surface
 * already speaks about the same account. */
function youtubeTokenTarget(locale: VideoLocale): string {
  return channelIdentity("youtube", locale);
}

function refreshTokenSetting(locale: VideoLocale): "YOUTUBE_RU_REFRESH_TOKEN" | "YOUTUBE_EN_REFRESH_TOKEN" {
  return locale === "en" ? "YOUTUBE_EN_REFRESH_TOKEN" : "YOUTUBE_RU_REFRESH_TOKEN";
}

/**
 * Puts a connected channel's refresh token under the name the uploader reads.
 *
 * YouTube was the last credential this Studio could only be given through .env:
 * authorizing printed a token for the operator to paste and restart behind. A
 * token obtained by connecting belongs to the database like every other one,
 * and .env keeps working for an install that has not reconnected yet.
 */
export function applyStoredYouTubeTokens(config: BackendConfig, backendDb: BackendDb): void {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) return;
  for (const locale of ["ru", "en"] as const) {
    const row = platformToken(backendDb, youtubeTokenTarget(locale));
    if (!row) continue;
    try {
      config[refreshTokenSetting(locale)] = open(row.sealedToken, key);
    } catch (error) {
      log("warn", "stored YouTube token could not be opened", { target: youtubeTokenTarget(locale), error: String(error) });
    }
  }
}

export function installYouTubeToken(
  config: BackendConfig,
  backendDb: BackendDb,
  locale: VideoLocale,
  refreshToken: string,
  now = new Date(),
): void {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is required to store a connected account");
  const target = youtubeTokenTarget(locale);
  const timestamp = now.toISOString();
  const row = {
    sealedToken: seal(refreshToken, key),
    seedFingerprint: null,
    accountId: null,
    sealedRefreshToken: null,
    // A YouTube refresh token does not expire unless the grant is revoked.
    expiresAt: null,
    refreshedAt: timestamp,
    updatedAt: timestamp,
  };
  storePlatformToken(backendDb, target, row);
  config[refreshTokenSetting(locale)] = refreshToken;
}
