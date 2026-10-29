/** Telegram rejects an edit whose text and markup are byte-identical to what
 * the message already shows. Every periodic refresh hits this the moment
 * nothing has changed since the last tick, so it is the expected outcome, not
 * a failure -- but it arrives through the same throw as a broken parse_mode, a
 * deleted chat or a revoked permission, which are worth seeing in the logs.
 *
 * Kept in one place because the match is on Telegram's prose: two copies of
 * the string would drift apart the day the wording changes. */
export function isUnchangedMessageEdit(error: unknown): boolean {
  return String(error).includes("message is not modified");
}
