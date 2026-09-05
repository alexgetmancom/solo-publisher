import { createHash, randomBytes } from "node:crypto";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { youtubeCredentials } from "../foundation/external/youtube.js";
import { formBody, requestJson } from "../foundation/http.js";
import { encryptionKey, open, seal } from "../foundation/secret-box.js";
import type { VideoLocale } from "../publishing/video-types.js";
import { installYouTubeToken } from "./youtube-tokens.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * One scope, because one is enough and one is all that works.
 *
 * `videos.insert` accepts `force-ssl` alongside the general scope, and
 * `commentThreads.list` accepts nothing else -- so the publishing token and the
 * token that can read a video's comments are the same token. This is also why
 * connecting is a redirect and not a device code: Google's device flow accepts
 * only `auth/youtube` and `auth/youtube.readonly` and refuses this one outright.
 */
const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

type YouTubeState = { locale: VideoLocale; verifier: string; expiresAt: number; nonce: string };

function youtubeOauthRedirectUri(config: BackendConfig): string {
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/youtube`;
}

/**
 * The consent link for one language's channel.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google hand over a
 * refresh token, and asking for consent every time is deliberate: Google omits
 * the refresh token on a re-authorization it considers already granted, which
 * would leave a reconnection storing nothing while looking like it worked.
 */
export function youtubeOauthAuthorizeUrl(config: BackendConfig, locale: VideoLocale, now = new Date()): string {
  const key = requiredKey(config);
  const { clientId } = youtubeCredentials(config, locale);
  if (!clientId) throw new Error(`YOUTUBE_${locale === "en" ? "EN" : "RU"}_CLIENT_ID is required to connect YouTube`);
  const verifier = randomBytes(32).toString("base64url");
  const state: YouTubeState = { locale, verifier, expiresAt: now.getTime() + STATE_TTL_MS, nonce: randomBytes(16).toString("hex") };
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: youtubeOauthRedirectUri(config),
    scope: YOUTUBE_SCOPE,
    state: seal(JSON.stringify(state), key),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${query}`;
}

/**
 * Turns the code Google sent back into the stored channel credential.
 *
 * The language rides in the sealed state rather than in the callback URL: one
 * redirect URI is registered with Google, and a query parameter a browser can
 * edit must not decide which channel a token is filed under.
 */
export async function exchangeYouTubeCode(
  config: BackendConfig,
  backendDb: BackendDb,
  code: string,
  state: string,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<{ locale: VideoLocale }> {
  const parsed = readState(config, state, now);
  const { clientId, clientSecret } = youtubeCredentials(config, parsed.locale);
  const answer = await requestJson<{ refresh_token?: string; scope?: string }>(fetchImpl, TOKEN_URL, {
    method: "POST",
    body: formBody({
      grant_type: "authorization_code",
      code,
      client_id: clientId ?? "",
      client_secret: clientSecret ?? "",
      redirect_uri: youtubeOauthRedirectUri(config),
      code_verifier: parsed.verifier,
    }),
  });
  if (!answer.refresh_token)
    throw new Error("Google returned no refresh token. Re-run the connection so the consent screen is shown again.");
  // A grant that came back without the scope is the failure this whole flow
  // exists to end, and it is silent everywhere else: publishing keeps working
  // and only comments come back empty, months later.
  if (answer.scope && !answer.scope.split(" ").includes(YOUTUBE_SCOPE))
    throw new Error(`Google granted ${answer.scope}, which cannot read comments. ${YOUTUBE_SCOPE} has to be granted.`);
  installYouTubeToken(config, backendDb, parsed.locale, answer.refresh_token, now);
  return { locale: parsed.locale };
}

function readState(config: BackendConfig, state: string, now: Date): YouTubeState {
  let parsed: YouTubeState;
  try {
    parsed = JSON.parse(open(state, requiredKey(config))) as YouTubeState;
  } catch {
    throw new Error("YouTube connection link is not valid for this Studio");
  }
  if (!parsed.verifier || (parsed.locale !== "ru" && parsed.locale !== "en")) throw new Error("YouTube connection link is malformed");
  if (parsed.expiresAt <= now.getTime()) throw new Error("YouTube connection link has expired. Start the connection again.");
  return parsed;
}

function requiredKey(config: BackendConfig): Buffer {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is required to connect an account");
  return key;
}
