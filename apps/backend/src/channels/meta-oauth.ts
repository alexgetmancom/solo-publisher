import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BackendConfig } from "../foundation/config.js";
import { formBody, requestJson } from "../foundation/http.js";
import { encryptionKey } from "../foundation/secret-box.js";
import type { VideoLocale } from "../publishing/video-types.js";
import { META_PROVIDERS, type MetaOauthPlatform, type MetaProvider } from "./meta-providers.js";

export type { MetaOauthPlatform } from "./meta-providers.js";
export type MetaOauthState = { platform: MetaOauthPlatform; locale: VideoLocale };

const STATE_TTL_MS = 10 * 60 * 1000;

type StatePayload = MetaOauthState & { expiresAt: number; nonce: string };

export function metaOauthConnectUrl(config: BackendConfig, platform: MetaOauthPlatform, locale: VideoLocale, now = new Date()): string {
  assertConfigured(config, platform);
  const state = signState(config, {
    platform,
    locale,
    expiresAt: now.getTime() + STATE_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
  });
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/${platform}/start?state=${encodeURIComponent(state)}`;
}

export function metaOauthConnectPath(config: BackendConfig, platform: MetaOauthPlatform, locale: VideoLocale): string {
  assertConfigured(config, platform);
  return `/oauth/${platform}/start?locale=${locale}`;
}

export function metaOauthAuthorizeUrl(config: BackendConfig, state: string, now = new Date()): string {
  const parsed = verifyMetaOauthState(config, state, now);
  return metaAuthorizeUrl(config, parsed.platform, state);
}

/** The consent screen itself. The terminal fallback opens it without a state,
 * because nothing is coming back to a route that would verify one. */
export function metaAuthorizeUrl(config: BackendConfig, platform: MetaOauthPlatform, state?: string): string {
  const provider = META_PROVIDERS[platform];
  const query = new URLSearchParams({
    client_id: required(provider.appId(config), provider.appIdName),
    redirect_uri: metaOauthRedirectUri(config, platform),
    response_type: "code",
    scope: provider.scope,
    ...provider.authorizeExtras,
  });
  if (state) query.set("state", state);
  return `${provider.authorizeUrl}?${query}`;
}

export function verifyMetaOauthState(config: BackendConfig, state: string, now = new Date()): MetaOauthState {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) throw new Error("OAuth state is malformed");
  const expected = stateSignature(config, encoded);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer))
    throw new Error("OAuth state is invalid");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<StatePayload>;
  if ((payload.platform !== "threads" && payload.platform !== "instagram") || (payload.locale !== "ru" && payload.locale !== "en"))
    throw new Error("OAuth state has an invalid destination");
  if (typeof payload.expiresAt !== "number" || payload.expiresAt < now.getTime()) throw new Error("OAuth link has expired");
  if (typeof payload.nonce !== "string" || payload.nonce.length < 16) throw new Error("OAuth state has no nonce");
  return { platform: payload.platform, locale: payload.locale };
}

export function metaOauthRedirectUri(config: BackendConfig, platform: MetaOauthPlatform): string {
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/${platform}`;
}

/**
 * Trades the consent code for the long-lived token this Studio publishes with,
 * and reads the account behind it.
 *
 * The profile call belongs here, not in whoever started the flow: it is part of
 * knowing which account was just connected, and leaving it out for one platform
 * is what put a network call in the HTTP route.
 */
export async function exchangeMetaCode(
  config: BackendConfig,
  platform: MetaOauthPlatform,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; userId: string; username: string }> {
  const provider = META_PROVIDERS[platform];
  const appId = required(provider.appId(config), provider.appIdName);
  const appSecret = required(provider.appSecret(config), provider.appSecretName);
  const shortLived = await requestJson<{ access_token?: string; user_id?: number | string }>(fetchImpl, provider.tokenUrl, {
    method: "POST",
    body: formBody({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: metaOauthRedirectUri(config, platform),
      code,
    }),
  });
  if (!shortLived.access_token) throw new Error(`${provider.label} returned no access token for that code`);
  const exchange = new URLSearchParams({
    grant_type: provider.exchangeGrant,
    client_secret: appSecret,
    access_token: shortLived.access_token,
  });
  const longLived = await requestJson<{ access_token?: string }>(fetchImpl, `${provider.exchangeUrl}?${exchange}`);
  if (!longLived.access_token) throw new Error(`${provider.label} refused to issue a long-lived token`);
  const profileQuery = new URLSearchParams({ fields: "id,username", access_token: longLived.access_token });
  const profile = await requestJson<{ id?: number | string; username?: string }>(fetchImpl, `${provider.profileUrl}?${profileQuery}`);
  const userId = String(profile.id ?? shortLived.user_id ?? "");
  if (!userId) throw new Error(`${provider.label} returned no account id`);
  return { accessToken: longLived.access_token, userId, username: profile.username?.trim() ?? "" };
}

function signState(config: BackendConfig, payload: StatePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${stateSignature(config, encoded)}`;
}

function stateSignature(config: BackendConfig, encoded: string): string {
  const key = encryptionKey(required(config.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY"));
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is required for browser OAuth");
  return createHmac("sha256", key).update(encoded).digest("base64url");
}

function assertConfigured(config: BackendConfig, platform: MetaOauthPlatform): void {
  const provider: MetaProvider = META_PROVIDERS[platform];
  required(config.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY");
  required(provider.appId(config), provider.appIdName);
  required(provider.appSecret(config), provider.appSecretName);
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required for browser OAuth`);
  return value.trim();
}
