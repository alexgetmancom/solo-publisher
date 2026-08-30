import type { ApplicationPorts, DraftRecord } from "../../application/ports.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { jsonRecordArray } from "../../json.js";
import { isPostDraftMutable } from "../../publishing/state.js";
import { canAccessStudioOwner } from "../access.js";

/** Refuse material post edits shortly before delivery so one locale cannot
 * silently publish the old payload while another publishes the new one. */
const POST_EDIT_LOCK_MINUTES = 2;

/** Shared access and decoding rules for post use cases. */
export function requireOwnedDraft(ports: Pick<ApplicationPorts, "drafts">, config: BackendConfig, actorId: number, draftId: number) {
  const draft = ports.drafts.get(draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (!canAccessStudioOwner(config, actorId, draft.actor_id)) throw new StudioError("err.post-not-yours");
  return draft;
}

export function requireMutableDraft(
  ports: Pick<ApplicationPorts, "drafts">,
  config: BackendConfig,
  actorId: number,
  draftId: number,
): DraftRecord {
  const draft = requireOwnedDraft(ports, config, actorId, draftId);
  if (!isPostDraftMutable(draft.status)) throw new StudioError("err.post-locked");
  return draft;
}

/** Prevents payload-changing edits from racing a due publication. The schedule
 * command remains available so an operator can explicitly replan a draft; this
 * guard applies to content, media, target and policy mutations only. */
export function requirePostEditAllowed(
  ports: Pick<ApplicationPorts, "drafts">,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  now: Date,
  locale?: "ru" | "en",
): DraftRecord {
  const draft = requireMutableDraft(ports, config, actorId, draftId);
  const lockUntil = now.getTime() + POST_EDIT_LOCK_MINUTES * 60_000;
  const scheduledTimes = (
    locale === "ru" ? [draft.scheduled_at] : locale === "en" ? [draft.scheduled_en_at] : [draft.scheduled_at, draft.scheduled_en_at]
  )
    .filter((value): value is string => value != null)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (scheduledTimes.some((scheduledAt) => scheduledAt <= lockUntil)) throw new StudioError("err.post-too-close-to-publish");
  return draft;
}

export function draftMedia(draft: DraftRecord, locale: "ru" | "en"): Record<string, unknown>[] {
  return jsonRecordArray(locale === "ru" ? draft.media_ru_json : draft.media_en_json);
}
