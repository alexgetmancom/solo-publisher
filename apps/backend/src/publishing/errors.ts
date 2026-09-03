import type { JsonValue } from "../db/schema.js";
import { retryAfterSecondsFromHeaders } from "../foundation/http.js";
import { redactExternalSecrets } from "../foundation/redact.js";

const transientStatusCodes = new Set([408, 425, 429, 500, 502, 503, 504]);
// 401/403 are split out of the generic permanent bucket: they specifically mean
// "this credential is dead", which the auth circuit breaker (auth-circuit.ts)
// needs to distinguish from other non-retryable errors like a bad request body.
const authStatusCodes = new Set([401, 403]);
const permanentStatusCodes = new Set([400, 404, 409, 410, 413, 415, 422]);

export type PublishErrorClass = "transient" | "permanent" | "auth" | "unknown";

export class HttpPublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

/** The publish error a provider's failed HTTP response becomes. Redaction and
 * the provider's retry-after header are part of that shape, not a decision each
 * platform adapter gets to make differently. */
export function httpPublishError(response: Response, body: string, label: string): HttpPublishError {
  const safeBody = redactExternalSecrets(body);
  return new HttpPublishError(
    `${label} ${response.status}: ${safeBody}`,
    response.status,
    safeBody,
    retryAfterSecondsFromHeaders(response.headers),
  );
}

/** A provider's JSON response, or the publish error its failure becomes. An
 * empty body is an empty object: several providers answer a successful mutation
 * with no content at all. */
export async function publishJson<T>(response: Response, label: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw httpPublishError(response, body, label);
  return body ? (JSON.parse(body) as T) : ({} as T);
}

/** Reads a provider-specified retry delay off any thrown HTTP error (HttpPublishError
 * or foundation/http.ts's ExternalHttpError both carry this field structurally). */
export function retryAfterSecondsFromError(error: unknown): number | null {
  if (typeof error !== "object" || error == null || !("retryAfterSeconds" in error)) return null;
  const value = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function classifyPublishError(error: unknown): PublishErrorClass {
  const status = typeof error === "object" && error != null && "status" in error && typeof error.status === "number" ? error.status : null;
  if (status != null) {
    if (transientStatusCodes.has(status)) return "transient";
    if (authStatusCodes.has(status)) return "auth";
    if (permanentStatusCodes.has(status)) return "permanent";
  }
  const text = String(error instanceof Error ? error.message : (error ?? "")).toLowerCase();
  // The worker stopped waiting for an external call. It is deliberately not
  // retried automatically: a late provider success must never create a
  // duplicate publication. An operator can reconcile and retry explicitly.
  if (text.includes("delivery_execution_timeout")) return "permanent";
  // The auth circuit breaker (auth-circuit.ts) short-circuits calls to a target
  // with a known-dead credential instead of hitting the provider again; treat
  // that as transient so the job keeps retrying on the normal backoff schedule
  // once the breaker clears, rather than burning its whole retry budget.
  if (text.includes("auth_circuit_open")) return "transient";
  if (matchesMarkers(text, ["timeout", "timed out", "temporarily", "connection reset", "network"], [502, 503, 504, 429])) {
    return "transient";
  }
  if (matchesMarkers(text, ["unauthorized", "forbidden", "invalid token"], [401, 403])) {
    return "auth";
  }
  if (matchesMarkers(text, ["permission", "unsupported", "validation"], [400])) {
    return "permanent";
  }
  return "unknown";
}

/** Phrases match anywhere, but bare status codes only as standalone numbers:
 * an error message that happens to embed 429 in an id or timestamp must not
 * reclassify the failure. */
function matchesMarkers(text: string, phrases: readonly string[], statusCodes: readonly number[]): boolean {
  if (phrases.some((phrase) => text.includes(phrase))) return true;
  return statusCodes.some((code) => new RegExp(`(?<!\\d)${code}(?!\\d)`).test(text));
}

export function nextRetryAt(
  attemptCount: number,
  baseSeconds: number,
  maxSeconds: number,
  now = new Date(),
  retryAfterSeconds: number | null = null,
): string {
  // A provider that returns Retry-After/X-RateLimit-Reset is telling us exactly
  // how long it wants silence; honor that instead of guessing with the
  // exponential curve, capped by the same ceiling as normal backoff.
  if (retryAfterSeconds != null) return new Date(now.getTime() + Math.min(retryAfterSeconds, maxSeconds) * 1000).toISOString();
  const delaySeconds = Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, attemptCount - 1));
  // Full jitter: spreads out retries that were all scheduled by the same
  // failure event so they don't all land on the provider in the same instant.
  const jitteredSeconds = delaySeconds * (0.5 + Math.random() * 0.5);
  return new Date(now.getTime() + jitteredSeconds * 1000).toISOString();
}

export type PublishResult = {
  ok?: boolean;
  skipped?: boolean;
  id?: string | number | null;
  ids?: unknown[] | null;
  url?: string | null;
  error?: string | null;
  reason?: string | null;
  retryable?: boolean;
  partial?: boolean;
  /** A provider-side operation that has started but has not reached an audience.
   * The queue persists the adapter-owned state and releases the worker until the
   * requested next check. */
  deferred?: boolean;
  retryAfterMs?: number;
  /** Where a partially finished publication leaves what it already did, so the
   * next attempt resumes instead of repeating it. The adapter names its own
   * payload key; the queue only stores and returns it. */
  resumeKey?: string;
  resumeValue?: JsonValue;
  [key: string]: unknown;
};

export function normalizePublishResult(record: PublishResult | null | undefined) {
  const result = record && typeof record === "object" ? { ...record } : {};
  const ok = Boolean(result.ok);
  const skipped = Boolean(result.skipped);
  const status = ok ? "published" : skipped ? "skipped" : "failed";
  const ids = Array.isArray(result.ids) ? result.ids.map(String) : null;
  let externalId = result.id == null ? null : String(result.id);
  const url = typeof result.url === "string" ? result.url : null;
  if (!externalId && ids && ids.length > 0) externalId = String(ids[0]);
  if (!externalId && url) externalId = url;
  const error = result.error ?? result.reason ?? null;
  if (!ok && !skipped && result.retryable == null) {
    result.retryable = classifyPublishError(error) === "transient";
  }
  return {
    status,
    externalId,
    externalIds: ids,
    url: url ?? (externalId?.startsWith("http") ? externalId : null),
    error: error == null ? null : String(error),
    skipped: skipped ? 1 : 0,
    rawJson: JSON.stringify(result),
  };
}
