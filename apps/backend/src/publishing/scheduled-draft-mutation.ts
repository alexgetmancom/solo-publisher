import type { DomainEventInput, DraftPatch, DraftRecord } from "../application/ports.js";
import { isStoryTarget } from "../botTargets.js";
import { effectivePostTargets, registeredPostTargetIds } from "../channels/registry.js";
import { draftLocaleContent } from "../content/draft-content.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { createDraftStore } from "../db/repositories/drafts.js";
import { recordEvent } from "../db/repositories/events.js";
import { queueDraftStoryCards, readyStoryCardMedia, storyCardsForDraft } from "../story-cards/store.js";
import { assertPublicationPreflight } from "./preflight.js";
import { createPublicationPlan } from "./publication-plan.js";
import { refreshPublicationStatus } from "./publication-status.js";
import { persistPublicationPlanTx } from "./publication-writer.js";
import { parseTargets } from "./targets.js";

type ScheduledDraftMutation = {
  patch: DraftPatch;
  queueStoryCards?: boolean;
  event?: DomainEventInput;
};

/** Changes a scheduled draft and its replaceable delivery plan under one write
 * lock. The root update is fenced on the status and revision that Studio read;
 * a worker or another interface that moved it first wins without being erased. */
export function mutateScheduledDraft(backendDb: BackendDb, draft: DraftRecord, mutation: ScheduledDraftMutation): boolean {
  if (draft.status !== "scheduled" || draft.post_id == null) return false;
  const replanned = unsafeDb(backendDb).db.transaction(
    (tx) => {
      const drafts = createDraftStore(tx, backendDb.clock);
      if (!drafts.updateIfCurrent(draft.id, "scheduled", draft.updated_at, mutation.patch)) return null;
      if (mutation.queueStoryCards) queueDraftStoryCards(tx, draft.id);
      const updated = drafts.get(draft.id);
      if (!updated?.post_id) throw new Error(`scheduled draft ${draft.id} lost its post id`);
      assertPublicationPreflight({
        ...updated,
        targets_json: JSON.stringify(effectivePostTargets(backendDb, parseTargets(updated.targets_json))),
      });
      if (!waitForStoryCards(tx, backendDb, updated)) persistReplan(tx, backendDb, updated);
      if (mutation.event) recordEvent(tx, backendDb.clock, mutation.event);
      return updated.post_id;
    },
    { behavior: "immediate" },
  );
  if (replanned != null) refreshPublicationStatus(backendDb, replanned);
  return replanned != null;
}

type Transaction = Parameters<Parameters<ReturnType<typeof unsafeDb>["db"]["transaction"]>[0]>[0];

function waitForStoryCards(tx: Transaction, backendDb: BackendDb, draft: DraftRecord): boolean {
  const targets = effectivePostTargets(backendDb, parseTargets(draft.targets_json));
  const hasStoryTarget = Object.entries(targets).some(([target, enabled]) => enabled && isStoryTarget(target));
  const hasMedia = draftLocaleContent(draft, "ru").media.length > 0 || draftLocaleContent(draft, "en").media.length > 0;
  const failed = storyCardsForDraft(tx, draft.id).some((card) => card.status === "failed");
  return (
    (draft.story_publish_mode === "all" || draft.story_publish_mode === "site_only") &&
    hasStoryTarget &&
    !hasMedia &&
    !failed &&
    !readyStoryCardMedia(tx, draft.id)
  );
}

function persistReplan(tx: Transaction, backendDb: BackendDb, draft: DraftRecord): void {
  const targets = effectivePostTargets(backendDb, parseTargets(draft.targets_json));
  const effectiveDraft = { ...draft, targets_json: JSON.stringify(targets) };
  assertPublicationPreflight(effectiveDraft);
  const now = backendDb.clock.now().toISOString();
  const storyCards = readyStoryCardMedia(tx, draft.id);
  const registered = registeredPostTargetIds(backendDb);
  const plan = createPublicationPlan(
    effectiveDraft,
    draft.id,
    draft.post_id as number,
    { mode: "scheduled", ruAt: draft.scheduled_at, enAt: draft.scheduled_en_at },
    now,
    registered.size ? registered : undefined,
    storyCards ?? undefined,
  );
  persistPublicationPlanTx(tx, plan);
}
