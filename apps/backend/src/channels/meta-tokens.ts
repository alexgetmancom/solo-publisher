import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { requestJson } from "../foundation/http.js";
import { log } from "../foundation/logger.js";
import { encryptionKey, fingerprint, open, seal } from "../foundation/secret-box.js";
import { platformToken, storePlatformToken } from "./platform-token-store.js";

/**
 * Meta's long-lived tokens last 60 days and are renewed by asking for a new
 * one, which means the renewal has to be kept somewhere: .env is the host's and
 * read-only. They live sealed in the database, and .env stays the seed and the
 * manual override.
 *
 * A token that has already lapsed cannot be renewed — Meta says so plainly —
 * so renewal happens far from the edge rather than near it. A Studio that was
 * switched off for two months still needs a human, and nothing here pretends
 * otherwise.
 */
const RENEW_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The publication target a Meta credential is stored under, which is also how
 * it is named everywhere else. */
export type MetaTokenTarget = "threads_ru" | "threads_en" | "instagram_ru" | "instagram_en";

type MetaToken = {
  target: MetaTokenTarget;
  setting: keyof BackendConfig & string;
  refreshUrl: (token: string) => string;
};

const TOKENS: MetaToken[] = [
  {
    target: "threads_ru",
    setting: "THREADS_RU_ACCESS_TOKEN",
    refreshUrl: (token) =>
      `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`,
  },
  {
    target: "threads_en",
    setting: "THREADS_EN_ACCESS_TOKEN",
    refreshUrl: (token) =>
      `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`,
  },
  {
    target: "instagram_ru",
    setting: "INSTAGRAM_RU_ACCESS_TOKEN",
    refreshUrl: (token) =>
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`,
  },
  {
    target: "instagram_en",
    setting: "INSTAGRAM_EN_ACCESS_TOKEN",
    refreshUrl: (token) =>
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`,
  },
];

/**
 * Replaces each configured Meta token with the renewal this Studio last made.
 *
 * Called once at startup so the rest of the process reads one name for the
 * effective credential — `config.THREADS_RU_ACCESS_TOKEN` and its siblings —
 * rather than every caller learning that a token has two homes.
 */
export function applyStoredMetaTokens(config: BackendConfig, backendDb: BackendDb): void {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) return;
  const mutable = config as unknown as Record<string, unknown>;
  for (const { target, setting } of TOKENS) {
    const seed = config.metaTokenSeeds[setting];
    const row = platformToken(backendDb, target);
    if (!row) continue;
    // A different value in .env is the operator replacing a token by hand,
    // which is newer than anything renewed before it.
    if (row.seedFingerprint && (!seed || row.seedFingerprint !== fingerprint(seed))) continue;
    try {
      const effective = open(row.sealedToken, key);
      // An account connected through the browser has no seed in .env, so a
      // token sitting there is not the operator's newest intent and does not
      // win. Editing it and seeing nothing change is the trap; say so instead.
      if (row.seedFingerprint === null && seed && seed !== effective)
        log("warn", "stored platform token overrides the one in .env", { target, setting, hint: "reconnect from Studio > Channels" });
      mutable[setting] = effective;
      if (row.accountId && target === "instagram_ru") mutable.INSTAGRAM_RU_USER_ID = row.accountId;
      if (row.accountId && target === "instagram_en") mutable.INSTAGRAM_EN_USER_ID = row.accountId;
    } catch (error) {
      log("warn", "stored platform token could not be opened", { target, error: String(error) });
    }
  }
}

export type RenewalOutcome = { target: string; status: "renewed" | "fresh" | "failed" | "unsealed" };

/** Renews what is close enough to expiry to be worth renewing, and stores it. */
export async function renewMetaTokens(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<RenewalOutcome[]> {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) return [];
  const outcomes: RenewalOutcome[] = [];
  for (const { target, setting, refreshUrl } of TOKENS) {
    const token = config[setting];
    if (typeof token !== "string" || !token) continue;
    const envSeed = config.metaTokenSeeds[setting];
    const row = platformToken(backendDb, target);
    // The stored renewal only counts as this token's history while .env still
    // holds the value it grew from.
    const seed = row && (row.seedFingerprint === null || (envSeed && row.seedFingerprint === fingerprint(envSeed))) ? row : null;
    const age = seed ? now.getTime() - new Date(seed.refreshedAt).getTime() : Number.POSITIVE_INFINITY;
    if (age < RENEW_AFTER_DAYS * DAY_MS) {
      outcomes.push({ target, status: "fresh" });
      continue;
    }
    try {
      const renewed = await requestJson<{ access_token?: string }>(fetchImpl, refreshUrl(token));
      if (!renewed.access_token) throw new Error("no access_token in the response");
      storePlatformToken(backendDb, target, {
        sealedToken: seal(renewed.access_token, key),
        // The seed stays the .env value: it is what tells a later run whether
        // the operator has since replaced it.
        seedFingerprint: seed?.seedFingerprint ?? (envSeed ? fingerprint(envSeed) : null),
        accountId: seed?.accountId ?? instagramAccountId(config, target),
        refreshedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      (config as unknown as Record<string, unknown>)[setting] = renewed.access_token;
      outcomes.push({ target, status: "renewed" });
    } catch (error) {
      // Worth an operator's attention: a token that cannot be renewed will stop
      // publishing on its own, and only re-issuing it by hand brings it back.
      log("warn", "platform token renewal failed", { target, error: String(error) });
      outcomes.push({ target, status: "failed" });
    }
  }
  return outcomes;
}

/** Installs a token issued by this Studio's OAuth callback. It becomes the
 * database-owned credential immediately and on every later restart. */
export function installMetaToken(
  config: BackendConfig,
  backendDb: BackendDb,
  target: MetaToken["target"],
  accessToken: string,
  accountId: string,
  now = new Date(),
): void {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is required for browser OAuth");
  const definition = TOKENS.find((candidate) => candidate.target === target);
  if (!definition) throw new Error(`Unknown Meta token target: ${target}`);
  storePlatformToken(backendDb, target, {
    sealedToken: seal(accessToken, key),
    seedFingerprint: null,
    accountId,
    refreshedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  const mutable = config as unknown as Record<string, unknown>;
  mutable[definition.setting] = accessToken;
  if (target === "instagram_ru") mutable.INSTAGRAM_RU_USER_ID = accountId;
  if (target === "instagram_en") mutable.INSTAGRAM_EN_USER_ID = accountId;
}

function instagramAccountId(config: BackendConfig, target: string): string | null {
  if (target === "instagram_ru") return config.INSTAGRAM_RU_USER_ID ?? null;
  if (target === "instagram_en") return config.INSTAGRAM_EN_USER_ID ?? null;
  return null;
}
