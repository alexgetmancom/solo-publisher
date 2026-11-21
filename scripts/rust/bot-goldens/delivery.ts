import { publicationRef } from "../../../apps/backend/src/application/publication-ref.js";
import { unsafeDb } from "../../../apps/backend/src/db/client.js";
import { refreshPublicationStatus } from "../../../apps/backend/src/publishing/publication-status.js";
import { settleJob } from "../../../apps/backend/src/publishing/queue-state.js";
import type { Harness } from "./harness.ts";

type Outcome = { status: "published" | "failed" | "verification_required"; error?: string };

/** What the delivery workers would have written once the platforms answered:
 * each named target's job settles with that outcome (through `settleJob`, the
 * delivery write path, for the target row and its journal event), site jobs are
 * settled in place, and the publication status is refreshed, which emits the
 * completion events. The workers themselves call the platforms, so they are not
 * run; this is the state they leave. */
export function deliverPost(h: Harness, draftId: number, outcomes: Record<string, Outcome>): void {
  const { db, sqlite } = unsafeDb(h.backendDb);
  const postId = (sqlite.prepare("SELECT post_id FROM drafts WHERE id=?").get(draftId) as { post_id: number | null } | null)?.post_id;
  if (postId == null) throw new Error(`draft ${draftId} has no post`);
  const key = publicationRef("post", postId);
  const now = new Date().toISOString();
  for (const [target, outcome] of Object.entries(outcomes)) {
    if (target === "site_ru" || target === "site_en") {
      sqlite
        .prepare("UPDATE site_jobs SET status=?, last_error=?, updated_at=? WHERE publication_key=? AND reason=?")
        .run(outcome.status, outcome.error ?? null, now, key, target);
      continue;
    }
    const job = sqlite.prepare("SELECT job_id FROM publish_jobs WHERE publication_key=? AND target=?").get(key, target) as {
      job_id: number;
    } | null;
    if (!job) throw new Error(`no ${target} job for post ${postId}`);
    // The claim a worker holds while it publishes; settleJob's write is fenced on it.
    sqlite.prepare("UPDATE publish_jobs SET locked_by='goldens', locked_at=? WHERE job_id=?").run(now, job.job_id);
    db.transaction((tx) => {
      settleJob(
        tx,
        job.job_id,
        {
          patch: {
            status: outcome.status,
            lastError: outcome.error ?? null,
            lockedBy: null,
            lockedAt: null,
            updatedAt: now,
          },
          fence: "goldens",
        },
        key,
        target,
        {
          status: outcome.status,
          error: outcome.error ?? null,
          updatedAt: now,
          ...(outcome.status === "published" ? { publishedAt: now, url: `https://example.invalid/${target}/${postId}` } : {}),
        },
        {
          type: outcome.status === "published" ? "publish.job.published" : "publish.job.failed",
          severity: outcome.status === "published" ? "info" : "error",
          message: `${target} ${outcome.status}`,
          details: { post_id: postId, target },
        },
      );
    });
  }
  refreshPublicationStatus(h.backendDb, postId);
  h.note(`Delivery settled post #${postId} (draft ${draftId}): ${JSON.stringify(outcomes)}`);
}

/** A video target's final state as the video worker would leave it. */
export function settleVideoTarget(
  h: Harness,
  videoDraftId: number,
  target: "youtube_shorts" | "instagram_reels",
  fields: {
    status: string;
    lastError?: string;
    deliveryProvider?: string;
    providerAccountId?: string;
    providerPostId?: string;
    externalUrl?: string;
  },
): number {
  const row = unsafeDb(h.backendDb)
    .sqlite.prepare(
      `UPDATE video_targets SET status=?, last_error=?, delivery_provider=coalesce(?, delivery_provider),
         provider_account_id=coalesce(?, provider_account_id), provider_post_id=coalesce(?, provider_post_id),
         external_url=coalesce(?, external_url), updated_at=? WHERE video_draft_id=? AND target=? RETURNING id`,
    )
    .get(
      fields.status,
      fields.lastError ?? null,
      fields.deliveryProvider ?? null,
      fields.providerAccountId ?? null,
      fields.providerPostId ?? null,
      fields.externalUrl ?? null,
      new Date().toISOString(),
      videoDraftId,
      target,
    ) as { id: number } | null;
  if (!row) throw new Error(`no ${target} on video ${videoDraftId}`);
  h.note(`Video #${videoDraftId} ${target} settled as ${JSON.stringify(fields)}`);
  return row.id;
}
