import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { formBody, isInconclusiveExternalFailure, requestJson } from "../foundation/http.js";
import { encryptionKey, open, seal } from "../foundation/secret-box.js";
import { platformToken, storePlatformToken } from "./platform-token-store.js";

const DEVICE_URL = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const USERS_URL = "https://api.twitch.tv/helix/users";
/** Renew this far before the deadline. A Twitch access token lives about four
 * hours, so the worker interval fits inside the margin many times over. */
const REFRESH_AHEAD_MS = 30 * 60 * 1000;

/**
 * What the bot does with a Twitch channel, as scopes.
 *
 * `channel:manage:broadcast` carries the title and the category, which is the
 * whole point of connecting; `user:write:chat` says one line in the chat as the
 * broadcaster. Nothing here reads chat or moderates it: an unused scope is a
 * permission the operator granted for no reason, and it shows on the consent
 * screen as one.
 */
const TWITCH_SCOPES = "channel:manage:broadcast user:write:chat";

/** One account per Studio, so one row. Twitch has no per-language accounts
 * here: the channel is the person, and it streams in whatever language it
 * streams in that day. */
export const TWITCH_TOKEN_TARGET = "twitch";

export type TwitchDeviceStart = {
  verificationUrl: string;
  userCode: string;
  expiresInSeconds: number;
  deviceCode: string;
  intervalSeconds: number;
};

type DeviceResponse = { device_code?: string; user_code?: string; verification_uri?: string; interval?: number; expires_in?: number };
type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; message?: string };
type UsersResponse = { data?: Array<{ id?: string; login?: string; display_name?: string }> };

/** Asks Twitch for the code the operator types on twitch.tv/activate. */
export async function startTwitchDevice(config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<TwitchDeviceStart> {
  const clientId = required(config);
  const device = await requestJson<DeviceResponse>(fetchImpl, DEVICE_URL, {
    method: "POST",
    body: formBody({ client_id: clientId, scopes: TWITCH_SCOPES }),
  });
  if (!device.device_code || !device.user_code || !device.verification_uri) throw new Error("Twitch returned no device code");
  return {
    deviceCode: device.device_code,
    userCode: device.user_code,
    verificationUrl: device.verification_uri,
    intervalSeconds: device.interval ?? 5,
    expiresInSeconds: device.expires_in ?? 1800,
  };
}

/** Trades an approved device code for the pair of tokens, and asks Twitch who
 * approved it: every later call names the broadcaster by id, never by login,
 * because a login can be changed and an id cannot. */
export async function redeemTwitchDevice(
  config: BackendConfig,
  backendDb: BackendDb,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<{ status: "pending" } | { status: "refused"; reason: string } | { status: "connected"; id: string; login: string }> {
  const clientId = required(config);
  let answer: TokenResponse;
  try {
    answer = await requestJson<TokenResponse>(fetchImpl, TOKEN_URL, {
      method: "POST",
      body: formBody({
        client_id: clientId,
        scopes: TWITCH_SCOPES,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
  } catch (error) {
    // Transport loss and Twitch's own faults are not a refusal, and the caller
    // answers a refusal by deleting the device authorization the operator is
    // in the middle of approving.
    if (isInconclusiveExternalFailure(error)) return { status: "pending" };
    answer = { message: String(error) } as TokenResponse;
  }
  // The ordinary answer while the operator is still typing the code in.
  if (answer.message?.includes("authorization_pending")) return { status: "pending" };
  if (!answer.access_token || !answer.refresh_token) return { status: "refused", reason: answer.message ?? "Twitch returned no tokens" };
  const identity = await twitchIdentity(clientId, answer.access_token, fetchImpl);
  storeTwitchTokens(config, backendDb, answer, identity.id, now);
  return { status: "connected", ...identity };
}

/** The credentials a Twitch call needs, renewed if they are close to expiring.
 * Twitch rotates the refresh token on every renewal, so the new pair replaces
 * the old one in the same write that hands the token out. */
export async function twitchAuth(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<TwitchAuth | null> {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  const clientId = config.TWITCH_CLIENT_ID;
  const row = platformToken(backendDb, TWITCH_TOKEN_TARGET);
  if (!key || !clientId || !row?.sealedRefreshToken || !row.accountId) return null;
  const fresh = row.expiresAt !== null && new Date(row.expiresAt).getTime() - now.getTime() > REFRESH_AHEAD_MS;
  if (fresh) return { clientId, token: open(row.sealedToken, key), broadcasterId: row.accountId };
  const answer = await requestJson<TokenResponse>(fetchImpl, TOKEN_URL, {
    method: "POST",
    body: formBody({ client_id: clientId, grant_type: "refresh_token", refresh_token: open(row.sealedRefreshToken, key) }),
  });
  if (!answer.access_token || !answer.refresh_token) throw new Error("Twitch refused to renew the connection; reconnect the account.");
  storeTwitchTokens(config, backendDb, answer, row.accountId, now);
  return { clientId, token: answer.access_token, broadcasterId: row.accountId };
}

export type TwitchAuth = { clientId: string; token: string; broadcasterId: string };

async function twitchIdentity(clientId: string, token: string, fetchImpl: typeof fetch): Promise<{ id: string; login: string }> {
  const profile = await requestJson<UsersResponse>(fetchImpl, USERS_URL, {
    headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId },
  });
  const user = profile.data?.[0];
  if (!user?.id) throw new Error("Twitch returned no account id");
  return { id: user.id, login: user.display_name?.trim() || user.login?.trim() || user.id };
}

function storeTwitchTokens(config: BackendConfig, backendDb: BackendDb, tokens: TokenResponse, accountId: string, now: Date): void {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is required to store a connected account");
  const timestamp = now.toISOString();
  storePlatformToken(backendDb, TWITCH_TOKEN_TARGET, {
    sealedToken: seal(tokens.access_token ?? "", key),
    sealedRefreshToken: seal(tokens.refresh_token ?? "", key),
    seedFingerprint: null,
    accountId,
    expiresAt: new Date(now.getTime() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
    refreshedAt: timestamp,
    updatedAt: timestamp,
  });
}

function required(config: BackendConfig): string {
  if (!config.TWITCH_CLIENT_ID) throw new Error("TWITCH_CLIENT_ID is not configured");
  return config.TWITCH_CLIENT_ID;
}
