import { eq } from "drizzle-orm";
import { isSiteTarget } from "../botTargets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts } from "../db/schema.js";
import { deliverExtraTarget } from "../publishing/extra-delivery.js";
import type { ResolvedPublicationRef } from "./publication-ref.js";

type ResendInput = {
  ref: ResolvedPublicationRef;
  target: string;
  apply: boolean;
  actorType: string;
};

/** Sends a settled publication to a platform it never went to.
 *
 * `retry` is the wrong answer to this: it republishes what a target already
 * delivered, which is what an operator restoring a removed post is asking for
 * and never what "it should have gone to X as well" means. This creates the one
 * job the target never had, and refuses a target that already published --
 * so it is the same operation the card's button performs, and neither surface
 * can put the post in front of an audience twice.
 */
export function resendPublicationTarget(backendDb: BackendDb, input: ResendInput): Record<string, unknown> {
  const { ref, target } = input;
  if (ref.postId == null) throw new Error(`${ref.publicationKey} has no publication to send again`);
  // The site is rendered by its own build from the pages a publication owns;
  // `repair-content` is what makes one after the fact.
  if (isSiteTarget(target)) throw new Error(`${target} is built, not delivered: use repair-content`);
  const postId = ref.postId;
  const draftId = unsafeDb(backendDb).db.select({ id: drafts.id }).from(drafts).where(eq(drafts.postId, postId)).get()?.id;
  if (draftId == null) throw new Error(`no draft found for post ${postId}`);
  const plan = { ok: true, action: "resend", publication_key: ref.publicationKey, post_id: postId, draft_id: draftId, target };
  if (!input.apply) return { ...plan, applied: false, hint: "re-run with apply to send the published post to this target" };

  const result = deliverExtraTarget(backendDb, { draftId, postId, publicationKey: ref.publicationKey }, target, () =>
    backendDb.studioPosts.publicationSource(postId),
  );
  return { ...plan, ok: result.outcome === "requeued", applied: true, result, actor_type: input.actorType };
}
