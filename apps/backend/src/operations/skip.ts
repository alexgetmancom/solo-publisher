import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { publishJobs, siteJobs } from "../db/schema.js";
import { abandonPublicationTargets } from "../publishing/abandon.js";
import { refreshPublicationOwner } from "../publishing/publication-owner.js";
import type { ResolvedPublicationRef } from "./publication-ref.js";

type SkipInput = {
  ref: ResolvedPublicationRef;
  target?: string | undefined;
  apply: boolean;
  actorType: string;
};

/** Gives up on a delivery target that did not land, from the command line.
 *
 * The bot has had this since it had a retry button next to it -- the two
 * answers to the same question, one publication finished with the target and
 * one finished without it -- while an operator or an agent at the CLI had only
 * the retry. So the way out of a publication nothing can deliver was to keep
 * retrying it, or to edit the database.
 *
 * The abandonment itself belongs to Publishing, which the bot's button also
 * goes through: one job, one mechanism, whichever surface asks for it. */
export function skipPublicationTargets(backendDb: BackendDb, input: SkipInput): Record<string, unknown> {
  const targets = input.target ? [input.target] : jobbedTargets(backendDb, input.ref);
  if (targets.length === 0) throw new Error(`no delivery targets found for ${input.ref.publicationKey}`);
  const plan = {
    ok: true,
    action: "skip",
    publication_key: input.ref.publicationKey,
    post_id: input.ref.postId,
    targets,
  };
  if (!input.apply) return { ...plan, applied: false, hint: "re-run with apply to finish the publication without these targets" };

  const results = abandonPublicationTargets(backendDb, { postId: input.ref.postId, publicationKey: input.ref.publicationKey }, targets);
  const abandoned = results.filter((row) => row.outcome === "abandoned").length;
  // The publication was being held open by the very jobs just abandoned; this
  // is what takes it, and its draft, out of the attention list.
  refreshPublicationOwner(backendDb, input.ref.publicationKey);
  return { ...plan, applied: true, abandoned, results, actor_type: input.actorType };
}

/** Every target this publication has a delivery row for, social and site alike:
 * `abandon` decides for itself which of them are in a state it may give up on,
 * and saying so twice is how the two lists drift. */
function jobbedTargets(backendDb: BackendDb, ref: ResolvedPublicationRef): string[] {
  const db = unsafeDb(backendDb).db;
  return [
    ...new Set([
      ...db
        .select({ target: publishJobs.target })
        .from(publishJobs)
        .where(eq(publishJobs.publicationKey, ref.publicationKey))
        .all()
        .map((row) => row.target),
      ...db
        .select({ reason: siteJobs.reason })
        .from(siteJobs)
        .where(eq(siteJobs.publicationKey, ref.publicationKey))
        .all()
        .map((row) => row.reason),
    ]),
  ];
}
