import { and, desc, eq, isNull } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { videoPublicUrl } from "../content/video-assets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoJobs, videoTargets } from "../db/schema.js";
import { publishZernioInstagramReel, zernioPostOutcome } from "../delivery/zernio.js";
import type { BackendConfig } from "../foundation/config.js";
import { getVideoDraft, refreshVideoDraftStatus } from "./video-data.js";
import { zernioPublishFence } from "./video-fence.js";
import type { InstagramMetadata } from "./video-types.js";

/**
 * Asks the provider what became of a video publication whose outcome this
 * Studio never learned, and records the answer.
 *
 * A publish that lost its worker cannot be retried blindly — nobody knows
 * whether the audience already has it — so the target sat unanswered with no
 * way to ask. Asking is safe because the publication is fenced by its job's
 * request id: re-issuing it returns the post the provider already made rather
 * than making a second one.
 *
 * Three answers, three states. The platform link means published. A provider-side
 * failure means the audience got nothing, so the target goes back to `failed`
 * where the ordinary retry can pick it up — and that retry, being a new job,
 * carries a new fence and can create the publication this attempt never made.
 * Anything else is still in flight and stays in verification_required, which is
 * the only state the reconciliation sweep watches.
 *
 * Deliberately provider-only. A native YouTube or Instagram upload has no such
 * fence, and re-sending one is how a video gets published twice.
 */
export async function settleVideoTarget(
  config: BackendConfig,
  backendDb: BackendDb,
  input: {
    videoDraftId: number;
    target: string;
    apply: boolean;
    known?: { providerPostId?: string | undefined; externalId?: string | undefined; url?: string | undefined };
  },
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const row = unsafeDb(backendDb)
    .db.select()
    .from(videoTargets)
    .where(and(eq(videoTargets.videoDraftId, input.videoDraftId), eq(videoTargets.target, input.target)))
    .get();
  if (!row) throw new Error(`${publicationRef("video", input.videoDraftId)} has no ${input.target} target`);
  // What this answers is "the provider took it, the platform has not confirmed",
  // which a target wears either as verification_required or as a published row
  // with nothing to link to. Anything carrying a link is already settled.
  if (row.externalId || row.externalUrl) throw new Error(`${input.target} already has its platform publication`);
  if (row.status !== "verification_required" && row.status !== "published")
    throw new Error(`${input.target} is ${row.status}, and only a target awaiting its platform link is settled this way`);
  if (row.deliveryProvider !== "zernio")
    throw new Error(`${input.target} is delivered natively, which has no idempotent replay: settle it from what the platform shows`);
  const accountId = row.providerAccountId;
  if (!accountId) throw new Error(`${input.target} has no provider account id`);

  // What the operator can see on the platform outranks anything this Studio can
  // work out from the provider: a publication the provider recorded as failed
  // can still be live, and the account is the fact.
  if (input.known?.externalId || input.known?.url) {
    const observed = {
      providerPostId: input.known.providerPostId ?? row.providerPostId,
      externalId: input.known.externalId ?? null,
      url: input.known.url ?? null,
      failure: null,
    };
    if (!input.apply) return { ref: publicationRef("video", input.videoDraftId), target: input.target, observed, applied: false };
    return { ...record(backendDb, config, row, input.videoDraftId, observed), observed };
  }

  const publishJob = unsafeDb(backendDb)
    .db.select({ id: videoJobs.id, runAt: videoJobs.runAt })
    .from(videoJobs)
    .where(and(eq(videoJobs.videoTargetId, row.id), eq(videoJobs.kind, "publish")))
    .orderBy(desc(videoJobs.id))
    .get();
  if (!publishJob) throw new Error(`${input.target} has no publish job to ask about`);
  const requestId = zernioPublishFence(publishJob);
  const plan = { ref: publicationRef("video", input.videoDraftId), target: input.target, provider: "zernio", requestId, applied: false };
  if (!input.apply) return plan;

  // A publication we already know the id of is asked about; one we do not is
  // asked for, under the fence that makes asking indistinguishable from having
  // asked before.
  const result = row.providerPostId
    ? await zernioPostOutcome(config, row.providerPostId, "instagram", fetchImpl)
    : {
        ...(await publishZernioInstagramReel(
          config,
          {
            accountId,
            publicUrl: videoPublicUrl(backendDb, config, getVideoDraft(backendDb, input.videoDraftId)),
            metadata: row.metadataJson as InstagramMetadata,
            requestId,
          },
          fetchImpl,
        )),
        failure: null as string | null,
      };

  return { ...plan, ...record(backendDb, config, row, input.videoDraftId, result) };
}

type Outcome = { providerPostId: string | null; externalId: string | null; url: string | null; failure: string | null };

function record(
  backendDb: BackendDb,
  config: BackendConfig,
  row: typeof videoTargets.$inferSelect,
  videoDraftId: number,
  outcome: Outcome,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const landed = Boolean(outcome.externalId || outcome.url);
  const status = landed ? "published" : outcome.failure ? "failed" : "verification_required";
  // Fenced on the state this settlement was decided from. The checks above ran
  // before a provider round-trip that takes as long as it takes, and the
  // reconciliation sweep settles the same target from the same provider under
  // its own fence -- an unconditional write here overwrites whatever it
  // recorded in between with an answer taken before it.
  const settled = unsafeDb(backendDb)
    .db.update(videoTargets)
    .set({
      status,
      providerPostId: outcome.providerPostId,
      externalId: outcome.externalId,
      externalUrl: outcome.url,
      publishedAt: landed ? (row.publishedAt ?? now) : null,
      lastError: landed ? null : (outcome.failure ?? "awaiting the platform link from the provider"),
      confirmationSource: landed ? "provider_verify" : "idempotency_replay",
      verifiedAt: landed ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(videoTargets.id, row.id),
        eq(videoTargets.status, row.status),
        isNull(videoTargets.externalId),
        isNull(videoTargets.externalUrl),
      ),
    )
    .returning({ id: videoTargets.id })
    .get();
  if (!settled) throw new Error(`${row.target} was settled by something else while the provider was being asked; read its state again`);
  refreshVideoDraftStatus(backendDb, videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
  return {
    applied: true,
    providerPostId: outcome.providerPostId,
    externalId: outcome.externalId,
    url: outcome.url,
    failure: outcome.failure,
    status,
  };
}
