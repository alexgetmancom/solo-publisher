import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, videoDrafts } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import type { VideoTarget } from "../publishing/video-types.js";
import { createStudioServices } from "../studio/services/index.js";
import { parseOperationSchedule } from "./commands.js";

/**
 * Publishing, scheduling and calling off a publication, from the command line.
 *
 * These are the capabilities the bot has always had on a card and no other
 * surface had at all: an agent could repair a delivery that went wrong but
 * could not call off one that had not started, and could not send a draft that
 * was already written. What was missing was the command, not the mechanism --
 * so nothing is reimplemented here. Each one calls the same Studio service the
 * button calls, as its owner, which is how `reschedule` has always worked.
 */
type DraftAction = { draftId: number; apply: boolean; at?: string | undefined; locale?: "ru" | "en" | "both" | undefined };

function postDraft(backendDb: BackendDb, draftId: number): { id: number; actorId: number; postId: number | null; status: string } {
  const draft = unsafeDb(backendDb)
    .db.select({ id: drafts.id, actorId: drafts.actorId, postId: drafts.postId, status: drafts.status })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .get();
  if (!draft) throw new Error(`draft not found: ${draftId}`);
  return draft;
}

function videoDraft(backendDb: BackendDb, draftId: number): { id: number; actorId: number; status: string; label: string } {
  const draft = unsafeDb(backendDb)
    .db.select({ id: videoDrafts.id, actorId: videoDrafts.actorId, status: videoDrafts.status, label: videoDrafts.label })
    .from(videoDrafts)
    .where(eq(videoDrafts.id, draftId))
    .get();
  if (!draft) throw new Error(`video draft not found: ${draftId}`);
  return draft;
}

function plan(action: string, subject: Record<string, unknown>, apply: boolean, hint: string): Record<string, unknown> | null {
  return apply ? null : { ok: true, action, ...subject, applied: false, hint };
}

export function publishPostDraft(backendDb: BackendDb, config: BackendConfig, input: DraftAction): Record<string, unknown> {
  const draft = postDraft(backendDb, input.draftId);
  const subject = { draft_id: draft.id, post_id: draft.postId, status: draft.status };
  const held = plan("draft-publish", subject, input.apply, "re-run with apply to send it to every enabled platform now");
  if (held) return held;
  const posts = createStudioServices(backendDb, config).posts;
  const postId = posts.publish(draft.actorId, draft.id);
  return { ok: true, action: "draft-publish", ...subject, post_id: postId, applied: true };
}

export function schedulePostDraft(backendDb: BackendDb, config: BackendConfig, input: DraftAction): Record<string, unknown> {
  if (!input.at?.trim()) throw new Error("missing schedule time");
  const locale = input.locale ?? "both";
  const draft = postDraft(backendDb, input.draftId);
  const at = parseOperationSchedule(input.at, config);
  const subject = { draft_id: draft.id, post_id: draft.postId, locale, at: at.toISOString() };
  const held = plan("draft-schedule", subject, input.apply, "re-run with apply to put it in the queue for that time");
  if (held) return held;
  const posts = createStudioServices(backendDb, config).posts;
  const postId = posts.schedule(draft.actorId, draft.id, posts.scheduleAt(draft.actorId, draft.id, locale, at));
  const updated = posts.get(draft.actorId, draft.id);
  return {
    ok: true,
    action: "draft-schedule",
    ...subject,
    post_id: postId,
    ru_at: updated.scheduled_at,
    en_at: updated.scheduled_en_at,
    applied: true,
  };
}

export function cancelPostDraft(backendDb: BackendDb, config: BackendConfig, input: DraftAction): Record<string, unknown> {
  const draft = postDraft(backendDb, input.draftId);
  const subject = { draft_id: draft.id, post_id: draft.postId, status: draft.status };
  const held = plan("draft-cancel", subject, input.apply, "re-run with apply to call it off; anything already delivered stays where it is");
  if (held) return held;
  createStudioServices(backendDb, config).posts.cancel(draft.actorId, draft.id);
  return { ok: true, action: "draft-cancel", ...subject, applied: true };
}

export async function publishVideoDraft(backendDb: BackendDb, config: BackendConfig, input: DraftAction): Promise<Record<string, unknown>> {
  const draft = videoDraft(backendDb, input.draftId);
  const subject = { draft_id: draft.id, label: draft.label, status: draft.status };
  const held = plan("video-publish", subject, input.apply, "re-run with apply to send it to every chosen platform");
  if (held) return held;
  const technical = await createStudioServices(backendDb, config).videos.publish(draft.actorId, draft.id);
  return { ok: true, action: "video-publish", ...subject, seconds: technical.seconds, applied: true };
}

export async function scheduleVideoDraft(
  backendDb: BackendDb,
  config: BackendConfig,
  input: DraftAction,
): Promise<Record<string, unknown>> {
  if (!input.at?.trim()) throw new Error("missing schedule time");
  const draft = videoDraft(backendDb, input.draftId);
  const at = parseOperationSchedule(input.at, config);
  const subject = { draft_id: draft.id, label: draft.label, at: at.toISOString() };
  const held = plan("video-schedule", subject, input.apply, "re-run with apply to put every chosen platform in the queue for that time");
  if (held) return held;
  // Every platform this video is going to, at the one time given: a per-target
  // time is a card with a picker behind it, not a command line argument.
  const targets = backendDb.studioVideos.targets(draft.id).map((row) => row.target as VideoTarget);
  if (!targets.length) throw new Error(`video draft ${draft.id} has no platforms chosen`);
  const schedule = Object.fromEntries(targets.map((target) => [target, at])) as Partial<Record<VideoTarget, Date>>;
  const technical = await createStudioServices(backendDb, config).videos.schedule(draft.actorId, draft.id, schedule);
  return { ok: true, action: "video-schedule", ...subject, targets, seconds: technical.seconds, applied: true };
}

export async function cancelVideoDraft(backendDb: BackendDb, config: BackendConfig, input: DraftAction): Promise<Record<string, unknown>> {
  const draft = videoDraft(backendDb, input.draftId);
  const subject = { draft_id: draft.id, label: draft.label, status: draft.status };
  const held = plan(
    "video-cancel",
    subject,
    input.apply,
    "re-run with apply to call it off; a YouTube upload already made is held private and anything published needs removing by hand",
  );
  if (held) return held;
  const cancellation = await createStudioServices(backendDb, config).videos.cancel(draft.actorId, draft.id);
  return { ok: true, action: "video-cancel", ...subject, ...cancellation, applied: true };
}
