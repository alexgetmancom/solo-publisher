import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts } from "../db/schema.js";
import { insertEvent } from "./queue-state.js";
import { type RequeueResult, requeuePublicationTargetsTx } from "./requeue.js";
import { AUDIENCE_MUTATION_RETRYABLE_STATUSES } from "./state.js";
import { parseTargets } from "./targets.js";

export type ExtraDeliveryScope = { draftId: number; postId: number; publicationKey: string };

/**
 * Sends a settled publication to one more platform.
 *
 * The author remembers a platform after the post has gone out, and until now
 * the only way to add it was `ops retry --target`, which republishes. This is
 * the same job creation with the button's safety: `resume` refuses a target
 * that already put something in front of the audience, so tapping twice cannot
 * post twice.
 *
 * The draft's target list and the job are written together. A target delivered
 * but absent from `targets_json` is invisible to progress, the card and the
 * completion notice -- the delivery would happen and nothing would report it.
 */
export function deliverExtraTarget(
  backendDb: BackendDb,
  scope: ExtraDeliveryScope,
  target: string,
  source: () => Record<string, unknown>,
): RequeueResult {
  return unsafeDb(backendDb).db.transaction((tx) => {
    const now = new Date().toISOString();
    const [result] = requeuePublicationTargetsTx(tx, { postId: scope.postId, publicationKey: scope.publicationKey }, [target], {
      from: AUDIENCE_MUTATION_RETRYABLE_STATUSES,
      createMissing: true,
      audienceReached: "resume",
      source,
    });
    if (!result) throw new Error(`requeue returned no result for ${target}`);
    if (result.outcome !== "requeued") return result;
    const row = tx.select({ targetsJson: drafts.targetsJson }).from(drafts).where(eq(drafts.id, scope.draftId)).get();
    const targets = { ...parseTargets(row?.targetsJson ?? "{}"), [target]: true };
    tx.update(drafts)
      .set({ targetsJson: JSON.stringify(targets), updatedAt: now })
      .where(eq(drafts.id, scope.draftId))
      .run();
    insertEvent(
      tx,
      scope.publicationKey,
      target,
      "delivery.post.target.added",
      "info",
      `Post #${scope.postId} was sent to ${target} after publication`,
      { draft_id: scope.draftId, post_id: scope.postId, target },
      now,
    );
    return result;
  });
}
