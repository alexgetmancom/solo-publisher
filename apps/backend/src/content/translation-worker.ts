import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { trackUsageAsync } from "../observability/usage.js";
import { translateDraftText } from "./translation.js";

/** A translation is one model call; past this the claim is abandoned rather
 * than held by a worker that is no longer running. */
const TRANSLATION_LEASE_MS = 2 * 60_000;

/** A model that answers with something unusable answers the same way twice.
 * Past this the draft keeps its Russian and the card says it has no English,
 * which is the state preflight already refuses to publish. */
const TRANSLATION_MAX_ATTEMPTS = 3;

/**
 * Makes the English text of one queued draft.
 *
 * This is the only place a post is translated: an operator's message becomes a
 * draft and a card immediately, and the English arrives here a moment later.
 * The returned ids are the drafts whose card is now out of date, which is the
 * interface's business rather than this one's.
 */
export async function runTranslationCycle(backendDb: BackendDb, config: BackendConfig): Promise<number[]> {
  const claim = backendDb.draftTranslations.claimDue(TRANSLATION_LEASE_MS);
  if (!claim) return [];
  const draft = backendDb.drafts.get(claim.draftId);
  // The draft is gone, so the work item is too: nothing is left to translate and
  // retrying would only rediscover that on every cycle.
  if (!draft) {
    backendDb.draftTranslations.settle(claim.draftId, claim.lockedBy);
    return [];
  }
  try {
    const textEn = await trackUsageAsync(backendDb, "content.draft.translate", () => translateDraftText(backendDb, draft.text_ru, config));
    if (!textEn) throw new Error("translation produced no English text");
    backendDb.drafts.update(draft.id, { textEnMachine: textEn });
    // The English Story card is rendered from the English text, which did not
    // exist when the draft was created: queueing again is what gives that card
    // something to draw.
    backendDb.storyCards.queue(draft.id);
    backendDb.draftTranslations.settle(draft.id, claim.lockedBy);
    return [draft.id];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    backendDb.draftTranslations.fail(draft.id, claim.lockedBy, message, TRANSLATION_MAX_ATTEMPTS);
    log("warn", "draft translation attempt failed", { draftId: draft.id, attempt: claim.attemptCount + 1, error: message });
    // The card still changes: an exhausted draft stops saying its English is on
    // the way and says it has none.
    return [draft.id];
  }
}
