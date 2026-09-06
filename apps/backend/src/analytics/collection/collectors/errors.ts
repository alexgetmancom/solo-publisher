/** A collector error that must freeze its checkpoint instead of retrying. */
export class TerminalMetricError extends Error {
  readonly terminal = true;
}

export function isTerminalMetricError(error: unknown): error is TerminalMetricError {
  return error instanceof TerminalMetricError;
}

/** The day's API budget, spent. It is not a broken credential and not a missing
 * post: the provider hands it back at its own reset, so a row that hit it must
 * neither freeze nor spend the retry budget it shares with real failures. */
export class QuotaExhaustedError extends Error {
  readonly quotaExhausted = true;
}

export function isQuotaExhausted(error: unknown): error is QuotaExhaustedError {
  return error instanceof QuotaExhaustedError;
}

/** Google says it in the error body rather than in the status: a spent quota
 * and a revoked token are both 403. */
const QUOTA_SPENT = /quotaExceeded|exceeded your (?:<[^>]*>)?quota/i;

/** The alert an operator reads is one line of a Telegram message, and a raw
 * transport error there is a request URL, a redacted token and a trace id —
 * nothing that says what happened or whether it needs an answer. The raw text
 * stays on the event as `reason`; this is what the alert says instead. */
export function describeMetricFreeze(ref: string, target: string, raw: string): string {
  return `${target} metrics stopped for ${ref}: ${freezeCause(raw)}`;
}

/** The same sentence without a video attached, for a report that groups many
 * rows by the one thing that stopped them. */
export function metricFailureCause(raw: string): string {
  return freezeCause(raw);
}

function freezeCause(raw: string): string {
  if (QUOTA_SPENT.test(raw)) return "the platform's daily quota for this account is spent; collection resumes when it resets";
  if (/does not exist|error_subcode\D*33|\b404\b|deleted/i.test(raw))
    return "the platform no longer has this post — deleted, or made private. Nothing to do unless you expected it to be live";
  if (/\b(?:401|403)\b|missing permissions|insufficient(?:\s+authentication)?\s+scopes?|access_denied|token/i.test(raw))
    return "the credential no longer grants access to it. Reconnect the channel to resume collection";
  if (/unsupported(?:\s+field|\s+metric)|metrics_not_implemented/i.test(raw)) return "the platform stopped serving these metrics for it";
  return "collection kept failing and its retry budget ran out";
}

export function terminalIfMissingRemoteObject(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (QUOTA_SPENT.test(message)) return new QuotaExhaustedError(message);
  return /(?:\b(?:400|401|403|404)\b|unsupported(?:\s+field|\s+metric|\s+get request)?|metrics_not_implemented|insufficient(?:\s+authentication)?\s+scopes?|does not exist|missing permissions|access_denied|error_subcode\D*33)/i.test(
    message,
  )
    ? new TerminalMetricError(message)
    : error instanceof Error
      ? error
      : new Error(message);
}
