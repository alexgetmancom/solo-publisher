import { META_PROVIDERS, type MetaOauthPlatform } from "../channels/meta-providers.js";
import { listChannels } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { instagramCredentialsForLocale, instagramGraphHost } from "../foundation/external/instagram.js";
import { type ThreadsTarget, threadsCredentials } from "../foundation/external/threads.js";
import { type VideoLocale, youtubeAccessToken, youtubeCredentials } from "../foundation/external/youtube.js";
import { ExternalHttpError, requestJson } from "../foundation/http.js";
import { log } from "../foundation/logger.js";
import { recordAuthFailure, recordAuthSuccess, recordTokenPing, shouldPingToken } from "./auth-circuit.js";

// A dead credential otherwise stays invisible until something tries to
// publish with it and burns part of the retry budget on a guaranteed 401.
// This probes each configured platform's cheapest "am I still authenticated"
// endpoint on its own cadence and feeds the result into the same auth circuit
// breaker publish failures use, so a token that died between posts is caught
// (and publishing paused) before the next real publish attempt.
const PING_INTERVAL_SECONDS = 60 * 60;
// Retry cadence after an inconclusive probe (network error, unrelated 5xx) —
// short enough that a transient blip does not buy a dead token another hour of
// invisibility, long enough not to hammer a provider that is already struggling.
const PING_RETRY_SECONDS = 5 * 60;
// Meta's debug_token tells us exactly when a Graph API token expires; warn
// once it's inside this window so a human can rotate it ahead of the failure
// instead of after a burst of dead publishes.
const EXPIRY_WARNING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** What one probe learned about a credential. Both fields are optional
 * because most providers answer neither question: a probe that only proves the
 * token still authenticates returns an empty result, not a special case. */
type ProbeResult = {
  /** An ISO expiry timestamp when the provider can report one. */
  expiresAt?: string | null;
  /** Permissions this Studio's code needs that the token was not granted.
   * Empty when the grant is complete; absent when the provider will not say. */
  missingScopes?: string[];
};

type Probe = {
  target: string;
  configured: (config: BackendConfig) => boolean;
  run: (config: BackendConfig, fetchImpl: typeof fetch) => Promise<ProbeResult>;
};

/** Best-effort token expiry lookup; a failure here must not turn an otherwise
 * healthy probe into a reported auth failure. Meta reports a non-expiring
 * token as expires_at: 0, which must not be treated the same as "lookup
 * failed" (a plain falsy check on the number would conflate the two). */
async function debugToken(
  target: string,
  host: string,
  version: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ expiresAt: string | null; scopes: string[] | null }> {
  try {
    const data = await requestJson<{ data?: { expires_at?: number; scopes?: unknown } }>(
      fetchImpl,
      `https://${host}/${version}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
    );
    const expiresAtSeconds = data.data?.expires_at;
    const granted = data.data?.scopes;
    return {
      expiresAt: typeof expiresAtSeconds === "number" && expiresAtSeconds > 0 ? new Date(expiresAtSeconds * 1000).toISOString() : null,
      scopes: Array.isArray(granted) ? granted.filter((scope): scope is string => typeof scope === "string") : null,
    };
  } catch (error) {
    // graph.instagram.com rejects debug_token for Instagram Login tokens with
    // a 403 unless called with an app access token (needs an app id/secret we
    // don't have configured) - expected and not worth alerting on, but still
    // worth a breadcrumb so "why don't we know this token's expiry" is
    // answerable from the logs instead of looking like silent data loss.
    log("debug", "token debug lookup failed", {
      target,
      host,
      error: error instanceof Error ? error.message : String(error),
    });
    return { expiresAt: null, scopes: null };
  }
}

/**
 * The permissions a token was granted, against the ones the connect flow asks
 * for. Those are the same list this Studio's code was written against, so a
 * token minted before a permission was added -- or by hand, or through another
 * Studio -- is a token that publishes until it reaches the one call it cannot
 * make. Threads answers a refused reply with an empty HTTP 500 rather than a
 * permission error, which is a whole outage's worth of looking in the wrong
 * place; asking `debug_token` up front is how that becomes one warning.
 */
function missingMetaScopes(platform: MetaOauthPlatform, granted: string[] | null): string[] | undefined {
  if (!granted) return undefined;
  const required = META_PROVIDERS[platform].scope
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return required.filter((scope) => !granted.includes(scope));
}

async function graphMeCheck(
  target: string,
  platform: MetaOauthPlatform,
  host: string,
  version: string,
  id: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ProbeResult> {
  await requestJson(fetchImpl, `https://${host}/${version}/${id}?fields=id&access_token=${encodeURIComponent(token)}`);
  const { expiresAt, scopes } = await debugToken(target, host, version, token, fetchImpl);
  const missingScopes = missingMetaScopes(platform, scopes);
  // The key is omitted rather than set to undefined: "the provider would not
  // say" and "the grant is complete" are different answers, and only the
  // absent key carries the first one.
  return missingScopes ? { expiresAt, missingScopes } : { expiresAt };
}

function youtubeProbe(target: string, locale: VideoLocale): Probe {
  return {
    target,
    configured: (config) => {
      const credentials = youtubeCredentials(config, locale);
      return Boolean(credentials.clientId && credentials.clientSecret && credentials.refreshToken);
    },
    run: async (config, fetchImpl) => {
      const token = await youtubeAccessToken(config, fetchImpl, locale);
      await requestJson(fetchImpl, "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return {};
    },
  };
}

function instagramProbe(target: string, locale: VideoLocale): Probe {
  return {
    target,
    configured: (config) => {
      const credentials = instagramCredentialsForLocale(config, locale);
      return Boolean(credentials.accessToken && credentials.userId);
    },
    run: (config, fetchImpl) => {
      const { accessToken: token, userId } = instagramCredentialsForLocale(config, locale);
      if (!token || !userId) throw new Error(`${target} credentials are missing`);
      return graphMeCheck(target, "instagram", instagramGraphHost(token), config.INSTAGRAM_GRAPH_API_VERSION, userId, token, fetchImpl);
    },
  };
}

function threadsProbe(target: ThreadsTarget): Probe {
  return {
    target,
    configured: (config) => Boolean(threadsCredentials(config, target).accessToken),
    run: async (config, fetchImpl) => {
      const { accessToken } = threadsCredentials(config, target);
      if (!accessToken) throw new Error(`${target} credentials are missing`);
      return graphMeCheck(target, "threads", "graph.threads.net", "v1.0", "me", accessToken, fetchImpl);
    },
  };
}

const probes: Probe[] = [
  {
    target: "controller_bot",
    configured: (c) => Boolean(c.controllerBotToken),
    run: async (config, fetchImpl) => {
      await requestJson(fetchImpl, `${config.TELEGRAM_API_BASE_URL}/bot${config.controllerBotToken}/getMe`);
      return {};
    },
  },
  {
    target: "x",
    configured: (c) => Boolean(c.X_CLIENT_ID && c.X_CLIENT_SECRET && c.X_ACCESS_TOKEN && c.X_REFRESH_TOKEN),
    run: async (config, fetchImpl) => {
      const url = "https://api.x.com/2/users/me";
      await requestJson(fetchImpl, url, { headers: { Authorization: `Bearer ${config.X_ACCESS_TOKEN}` } });
      return {};
    },
  },
  threadsProbe("threads_ru"),
  threadsProbe("threads_en"),
  instagramProbe("instagram_stories", "en"),
  instagramProbe("instagram_stories_ru", "ru"),
];

function videoChannelProbes(backendDb: BackendDb): Probe[] {
  return listChannels(backendDb).flatMap((channel) => {
    if (channel.provider === "zernio") return [];
    const locale = channel.locale === "en" ? "en" : "ru";
    if (channel.platform === "youtube") return [youtubeProbe(channel.id, locale)];
    if (channel.platform === "instagram") return [instagramProbe(channel.id, locale)];
    return [];
  });
}

/** Runs due live probes and feeds their outcome into the auth circuit
 * breaker/expiry alerts. Returns how many probes actually ran this cycle. */
export async function checkTokenHealth(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch = fetch): Promise<number> {
  let checked = 0;
  for (const probe of [...probes, ...videoChannelProbes(backendDb)]) {
    if (!probe.configured(config) || !shouldPingToken(backendDb, probe.target, PING_INTERVAL_SECONDS)) continue;
    checked += 1;
    try {
      const result = await probe.run(config, fetchImpl);
      const expiresAt = result.expiresAt ?? undefined;
      recordTokenPing(backendDb, probe.target, expiresAt);
      recordAuthSuccess(backendDb, probe.target);
      // A token can authenticate perfectly and still be unable to do the job:
      // the grant is checked here rather than at the call that needs it,
      // because that call is a publish in front of an audience.
      if (result.missingScopes?.length) {
        backendDb.events.record({
          target: probe.target,
          type: "credential.token_missing_scope",
          severity: "warn",
          message: `${probe.target}: token is missing ${result.missingScopes.join(", ")}; reconnect it from Studio > Channels`,
          details: { target: probe.target, missingScopes: result.missingScopes },
          cooldownSeconds: 24 * 60 * 60,
        });
      }
      if (expiresAt && new Date(expiresAt).getTime() - Date.now() < EXPIRY_WARNING_WINDOW_MS) {
        backendDb.events.record({
          target: probe.target,
          type: "credential.token_expiring_soon",
          severity: "warn",
          message: `${probe.target}: access token expires ${expiresAt}; rotate it before it starts failing publishes`,
          details: { target: probe.target, expiresAt },
          cooldownSeconds: 24 * 60 * 60,
        });
      }
    } catch (error) {
      const status = error instanceof ExternalHttpError ? error.status : null;
      // Only 401/403 mean the credential itself is dead; a network hiccup or
      // an unrelated 5xx must not trip the breaker and pause real publishes.
      const conclusive = status === 401 || status === 403;
      // An inconclusive probe must not consume the whole hour: that is exactly
      // the window in which a token that died between posts stays invisible.
      recordTokenPing(
        backendDb,
        probe.target,
        undefined,
        conclusive ? {} : { backdateSeconds: PING_INTERVAL_SECONDS - PING_RETRY_SECONDS },
      );
      if (conclusive) recordAuthFailure(backendDb, probe.target);
    }
  }
  return checked;
}
