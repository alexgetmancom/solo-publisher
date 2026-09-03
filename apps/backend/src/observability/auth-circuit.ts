import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { credentialChecks } from "../db/schema.js";

// A dead token retried on every publish attempt just re-triggers the same
// 401/403 against the provider, which is exactly the kind of repeated
// unauthorized traffic that gets an IP or app flagged. Trip the breaker after
// a few consecutive auth failures and stop calling the provider until either
// the cooldown elapses or a manual/automatic credential refresh succeeds.
const AUTH_FAILURE_THRESHOLD = 3;
const AUTH_BLOCK_COOLDOWN_SECONDS = 30 * 60;

type AuthCircuitDetails = {
  authFailureStreak?: number;
  blockedUntil?: string | null;
  lastAuthFailureAt?: string;
  lastPingAt?: string;
  /** When this target's provider last answered a call with this credential --
   * a publish or a health probe alike. It is the only evidence there is that a
   * platform is up while one delivery keeps being refused. */
  lastAnswerAt?: string;
};

function parseDetails(json: string | null | undefined): AuthCircuitDetails {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Called after a publish attempt fails with errorClass "auth". */
export function recordAuthFailure(backendDb: BackendDb, target: string): void {
  const now = new Date();
  const row = unsafeDb(backendDb).db.select().from(credentialChecks).where(eq(credentialChecks.target, target)).get();
  const details = parseDetails(row?.detailsJson);
  const streak = (details.authFailureStreak ?? 0) + 1;
  const tripped = streak >= AUTH_FAILURE_THRESHOLD;
  const blockedUntil = tripped
    ? new Date(now.getTime() + AUTH_BLOCK_COOLDOWN_SECONDS * 1000).toISOString()
    : (details.blockedUntil ?? null);
  // Preserve unrelated fields the same way recordAuthSuccess does. Rebuilding
  // the blob from scratch used to drop token-health.ts's lastPingAt, which
  // un-throttled the live token probes for exactly the dead credential the
  // breaker is meant to stop calling.
  const nextDetails: AuthCircuitDetails = { ...details, authFailureStreak: streak, blockedUntil, lastAuthFailureAt: now.toISOString() };
  if (row) {
    unsafeDb(backendDb)
      .db.update(credentialChecks)
      .set({ detailsJson: JSON.stringify(nextDetails) })
      .where(eq(credentialChecks.target, target))
      .run();
  } else {
    unsafeDb(backendDb)
      .db.insert(credentialChecks)
      .values({
        target,
        status: "unknown",
        requiredEnvJson: "[]",
        missingEnvJson: "[]",
        lastCheckedAt: now.toISOString(),
        detailsJson: JSON.stringify(nextDetails),
      })
      .run();
  }
  if (tripped && streak === AUTH_FAILURE_THRESHOLD) {
    backendDb.events.record({
      target,
      type: "credential.auth_circuit_tripped",
      severity: "error",
      message: `${target}: ${streak} consecutive auth failures, pausing publishes for ${AUTH_BLOCK_COOLDOWN_SECONDS / 60}m`,
      details: { target, streak, blockedUntil },
      cooldownSeconds: AUTH_BLOCK_COOLDOWN_SECONDS,
    });
  }
}

/** Called after a call to `target` succeeds: it clears any tripped breaker and
 * records that the provider answered. The timestamp is kept even when there was
 * no breaker to clear, because it is read by a half-finished delivery deciding
 * whether it is waiting out an outage or repeating a refusal. */
export function recordAuthSuccess(backendDb: BackendDb, target: string): void {
  const row = unsafeDb(backendDb).db.select().from(credentialChecks).where(eq(credentialChecks.target, target)).get();
  if (!row) return;
  const details = parseDetails(row.detailsJson);
  // Preserve unrelated fields (e.g. token-health.ts's lastPingAt) instead of
  // wiping the whole details blob, but still clear every circuit-breaker field.
  const nextDetails: AuthCircuitDetails = {
    ...details,
    authFailureStreak: 0,
    blockedUntil: null,
    lastAnswerAt: new Date().toISOString(),
  };
  delete nextDetails.lastAuthFailureAt;
  unsafeDb(backendDb)
    .db.update(credentialChecks)
    .set({ detailsJson: JSON.stringify(nextDetails) })
    .where(eq(credentialChecks.target, target))
    .run();
}

/** When this target's provider last answered, or null if it never has here.
 *
 * A publication that got half-way out is retried for hours on the theory that
 * the platform is down. This is what tests that theory: the platform answering
 * anything at all -- another publish, an hourly credential probe -- says the
 * refusal belongs to this one call, and hours of repeating it only delay
 * telling someone who can look at it. */
export function providerAnsweredAt(backendDb: BackendDb, target: string): string | null {
  const row = unsafeDb(backendDb).db.select().from(credentialChecks).where(eq(credentialChecks.target, target)).get();
  return parseDetails(row?.detailsJson).lastAnswerAt ?? null;
}

/** Checked before a publish call is attempted for `target`. */
export function isTargetAuthBlocked(backendDb: BackendDb, target: string): boolean {
  const row = unsafeDb(backendDb).db.select().from(credentialChecks).where(eq(credentialChecks.target, target)).get();
  if (!row) return false;
  const details = parseDetails(row.detailsJson);
  if (!details.blockedUntil) return false;
  // Compare instants, not ISO strings: string ordering only happens to work
  // while every writer uses the same UTC `Z` format.
  const blockedUntilMs = new Date(details.blockedUntil).getTime();
  return Number.isFinite(blockedUntilMs) && blockedUntilMs > Date.now();
}

/** What the breaker holds for every target it has an opinion about.
 *
 * The breaker is read on the publish path and nowhere else, so a target whose
 * credential is failing stops publishing while every report about it still says
 * `ready`: the channel is connected, the token is stored, and the queue simply
 * stops. Published here so a channels report can say so. */
export function authCircuitStates(backendDb: BackendDb, now = new Date()): AuthCircuitState[] {
  return unsafeDb(backendDb)
    .db.select()
    .from(credentialChecks)
    .all()
    .map((row) => {
      const details = parseDetails(row.detailsJson);
      const blockedUntilMs = details.blockedUntil ? new Date(details.blockedUntil).getTime() : Number.NaN;
      return {
        target: row.target,
        blocked: Number.isFinite(blockedUntilMs) && blockedUntilMs > now.getTime(),
        blockedUntil: details.blockedUntil ?? null,
        authFailureStreak: details.authFailureStreak ?? 0,
        lastAuthFailureAt: details.lastAuthFailureAt ?? null,
        lastPingAt: details.lastPingAt ?? null,
        tokenExpiresAt: row.expiresAt ?? null,
      };
    });
}

export type AuthCircuitState = {
  target: string;
  blocked: boolean;
  blockedUntil: string | null;
  authFailureStreak: number;
  lastAuthFailureAt: string | null;
  lastPingAt: string | null;
  tokenExpiresAt: string | null;
};

/** Throttles token-health.ts's live pings independently of the 5-minute
 * observability cadence, so we don't hit every provider's "whoami" endpoint
 * every cycle. */
export function shouldPingToken(backendDb: BackendDb, target: string, intervalSeconds: number): boolean {
  const row = unsafeDb(backendDb).db.select().from(credentialChecks).where(eq(credentialChecks.target, target)).get();
  const details = parseDetails(row?.detailsJson);
  if (!details.lastPingAt) return true;
  return Date.now() - new Date(details.lastPingAt).getTime() >= intervalSeconds * 1000;
}

/** Records that a live token probe ran, and its discovered expiry if the
 * provider reported one (see credentialChecks.expiresAt).
 *
 * `options.backdateSeconds` records the ping as having happened earlier than it
 * did, so the next probe becomes due sooner than the normal interval. It exists
 * for inconclusive probes (a network blip, an unrelated 5xx): those learned
 * nothing about the credential, so charging them a full interval would hide a
 * dead token for exactly as long as the probe was meant to prevent. */
export function recordTokenPing(
  backendDb: BackendDb,
  target: string,
  tokenExpiresAt?: string | null,
  options: { backdateSeconds?: number } = {},
): void {
  const now = new Date().toISOString();
  const row = unsafeDb(backendDb).db.select().from(credentialChecks).where(eq(credentialChecks.target, target)).get();
  const details = parseDetails(row?.detailsJson);
  const lastPingAt = options.backdateSeconds ? new Date(Date.now() - options.backdateSeconds * 1000).toISOString() : now;
  const nextDetails: AuthCircuitDetails = { ...details, lastPingAt };
  if (row) {
    unsafeDb(backendDb)
      .db.update(credentialChecks)
      .set({ detailsJson: JSON.stringify(nextDetails), ...(tokenExpiresAt !== undefined ? { expiresAt: tokenExpiresAt } : {}) })
      .where(eq(credentialChecks.target, target))
      .run();
  } else {
    unsafeDb(backendDb)
      .db.insert(credentialChecks)
      .values({
        target,
        status: "unknown",
        requiredEnvJson: "[]",
        missingEnvJson: "[]",
        lastCheckedAt: now,
        detailsJson: JSON.stringify(nextDetails),
        expiresAt: tokenExpiresAt ?? null,
      })
      .run();
  }
}
