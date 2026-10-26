import type { BackendConfig } from "../foundation/config.js";
import { youtubeCredentials } from "../foundation/external/youtube.js";
import type { VideoLocale } from "../publishing/video-types.js";
import { metaOauthConnectUrl } from "./meta-oauth.js";
import { META_PROVIDERS, type MetaOauthPlatform } from "./meta-providers.js";
import { xOauthAuthorizeUrl } from "./x-oauth.js";
import { youtubeOauthAuthorizeUrl } from "./youtube-oauth.js";

const LINK_TTL_MINUTES = 10;
export const CONNECT_PLATFORMS = ["threads", "instagram", "x", "youtube"] as const;
export type ConnectPlatform = (typeof CONNECT_PLATFORMS)[number];
type ConnectProvider = {
  label: string;
  perLocale: boolean;
  missing: (config: BackendConfig, locale: VideoLocale) => string[];
  link: (config: BackendConfig, locale: VideoLocale, now: Date) => string;
};
export type ConnectStart = {
  platform: ConnectPlatform;
  locale: VideoLocale | null;
  kind: "redirect";
  url: string;
  expiresInMinutes: number;
};
const CONNECT_PROVIDERS: Record<ConnectPlatform, ConnectProvider> = {
  threads: metaConnectProvider("threads"),
  instagram: metaConnectProvider("instagram"),
  x: {
    label: "X",
    perLocale: false,
    missing: (config) => ["X_CLIENT_ID", "X_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"].filter((name) => !config[name as keyof BackendConfig]),
    link: (config, _locale, now) => xOauthAuthorizeUrl(config, now),
  },
  youtube: {
    label: "YouTube",
    perLocale: true,
    missing: (config, locale) => {
      const suffix = locale === "en" ? "EN" : "RU";
      const credentials = youtubeCredentials(config, locale);
      return [
        credentials.clientId ? null : `YOUTUBE_${suffix}_CLIENT_ID`,
        credentials.clientSecret ? null : `YOUTUBE_${suffix}_CLIENT_SECRET`,
        config.TOKEN_ENCRYPTION_KEY ? null : "TOKEN_ENCRYPTION_KEY",
      ].filter((name): name is string => name !== null);
    },
    link: (config, locale, now) => youtubeOauthAuthorizeUrl(config, locale, now),
  },
};

export async function startConnect(
  config: BackendConfig,
  platform: ConnectPlatform,
  locale: VideoLocale,
  now = new Date(),
): Promise<ConnectStart> {
  const provider = CONNECT_PROVIDERS[platform];
  const missing = provider.missing(config, locale);
  if (missing.length) throw new Error(`${provider.label} is not configured: ${missing.join(", ")}`);
  return {
    platform,
    locale: provider.perLocale ? locale : null,
    kind: "redirect",
    url: provider.link(config, locale, now),
    expiresInMinutes: LINK_TTL_MINUTES,
  };
}
function metaConnectProvider(platform: MetaOauthPlatform): ConnectProvider {
  const meta = META_PROVIDERS[platform];
  return {
    label: meta.label,
    perLocale: true,
    missing: (config) =>
      [
        meta.appId(config) ? null : meta.appIdName,
        meta.appSecret(config) ? null : meta.appSecretName,
        config.TOKEN_ENCRYPTION_KEY ? null : "TOKEN_ENCRYPTION_KEY",
      ].filter((name): name is string => name !== null),
    link: (config, locale, now) => metaOauthConnectUrl(config, platform, locale, now),
  };
}
