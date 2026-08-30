import type { ChannelInput } from "../channels/registry.js";
import type { BackendConfig } from "../foundation/config.js";
import type { VideoLocale } from "../publishing/video-types.js";
import { channelIdentity } from "./identity.js";
import type { MetaTokenTarget } from "./meta-tokens.js";

export type MetaOauthPlatform = "threads" | "instagram";

/**
 * What one Meta platform is, as data.
 *
 * Threads and Instagram walk the same road — signed state, consent screen, code
 * for a short-lived token, short-lived for a long-lived one, then the profile
 * behind it — and differ only in addresses, one word of a grant type, and what
 * a connected account means in the registry. Those differences used to be five
 * `if (platform === "threads")` spread over three layers, one of which had the
 * HTTP route fetch a profile for one platform and not the other.
 *
 * Kept as a table so a new platform is an entry rather than another branch in
 * the flow every platform shares.
 */
export type MetaProvider = {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Trades the short-lived token for the long-lived one this Studio keeps. */
  exchangeUrl: string;
  exchangeGrant: string;
  profileUrl: string;
  scope: string;
  /** Query the consent screen needs beyond the shared five. */
  authorizeExtras: Record<string, string>;
  appId: (config: BackendConfig) => string | undefined;
  appSecret: (config: BackendConfig) => string | undefined;
  appIdName: string;
  appSecretName: string;
  /** Where the renewable token is stored, by the name `platform_tokens` uses. */
  tokenTarget: (locale: VideoLocale) => MetaTokenTarget;
  /** What a connected account becomes in the channel registry. Threads is a
   * text target; Instagram is a Reels account. A Story route is connected
   * independently because enabling it changes the post screens and queue. */
  registryRow: (locale: VideoLocale, accountId: string, account: string) => Omit<ChannelInput, "source">;
};

export const META_PROVIDERS: Record<MetaOauthPlatform, MetaProvider> = {
  threads: {
    label: "Threads",
    authorizeUrl: "https://threads.net/oauth/authorize",
    tokenUrl: "https://graph.threads.net/oauth/access_token",
    exchangeUrl: "https://graph.threads.net/access_token",
    exchangeGrant: "th_exchange_token",
    profileUrl: "https://graph.threads.net/v1.0/me",
    // Insights is not optional here: this Studio collects the metrics of what
    // it publishes, and a token minted without it is accepted everywhere except
    // the insights call, which fails for the life of the token.
    scope: "threads_basic,threads_content_publish,threads_manage_insights",
    authorizeExtras: {},
    appId: (config) => config.THREADS_APP_ID,
    appSecret: (config) => config.THREADS_APP_SECRET,
    appIdName: "THREADS_APP_ID",
    appSecretName: "THREADS_APP_SECRET",
    tokenTarget: (locale) => channelIdentity("threads", locale),
    registryRow: (locale, accountId, account) => ({
      platform: channelIdentity("threads", locale),
      locale,
      provider: "native",
      providerAccountId: accountId,
      targetId: channelIdentity("threads", locale),
      label: `Threads ${locale.toUpperCase()} · ${account}`,
    }),
  },
  instagram: {
    label: "Instagram",
    authorizeUrl: "https://www.instagram.com/oauth/authorize",
    tokenUrl: "https://api.instagram.com/oauth/access_token",
    exchangeUrl: "https://graph.instagram.com/access_token",
    exchangeGrant: "ig_exchange_token",
    profileUrl: "https://graph.instagram.com/me",
    scope: [
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ].join(","),
    // Instagram offers the Facebook login beside its own and remembers the last
    // account: both would connect an account the operator did not mean to.
    authorizeExtras: { enable_fb_login: "0", force_reauth: "true" },
    appId: (config) => config.INSTAGRAM_APP_ID,
    appSecret: (config) => config.INSTAGRAM_APP_SECRET,
    appIdName: "INSTAGRAM_APP_ID",
    appSecretName: "INSTAGRAM_APP_SECRET",
    tokenTarget: (locale) => channelIdentity("instagram", locale),
    registryRow: (locale, accountId, account) => ({
      platform: "instagram",
      locale,
      provider: "native",
      providerAccountId: accountId,
      label: `Instagram ${locale.toUpperCase()} · ${account}`,
    }),
  },
};
