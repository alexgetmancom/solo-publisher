import type { DraftPatch, DraftRecord, StoryPublishMode } from "../../application/ports.js";
import type { PublicationPipeline, PublicationSchedule } from "../../application/publication-pipeline.js";
import { publicationRef } from "../../application/publication-ref.js";
import { isStoryTarget, PRESETS, presetName, TARGETS, targetLocale, targetsFor } from "../../botTargets.js";
import { postLocales } from "../../channels/locales.js";
import { effectivePostTargets, registeredPostTargetIds } from "../../channels/registry.js";
import { listStudioMediaAssets, mediaItemsFromAssets, requireStudioMediaAssets } from "../../content/assets.js";
import { draftLocaleContent } from "../../content/draft-content.js";
import { createDraftFromMessage } from "../../content/drafts.js";
import type { DraftMessage } from "../../content/message.js";
import { emphasizeTitle } from "../../content/title-emphasis.js";
import type { BackendDb } from "../../db/client.js";
import { recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { truncateUnicode } from "../../foundation/text.js";
import { cancelScheduledNotifications, scheduleReminder } from "../../notifications/jobs.js";
import { trackUsageSync } from "../../observability/usage.js";
import { abandonPublicationTargets } from "../../publishing/abandon.js";
import { cancelDraft, cancelPendingPostJobs } from "../../publishing/draft-lifecycle.js";
import { mediaPolicyForTarget } from "../../publishing/media-policy.js";
import { publicationPreflight } from "../../publishing/preflight.js";
import { refreshPublicationStatus } from "../../publishing/publication-status.js";
import { publishDraftToQueue } from "../../publishing/publication-workflow.js";
import { requeuePublicationTargets } from "../../publishing/requeue.js";
import { assertFutureSchedule, assertValidScheduleDate, parseManualSchedule, publicationSlotTime } from "../../publishing/schedule.js";
import { AUDIENCE_MUTATION_RETRYABLE_STATUSES, isPostTargetRetryable } from "../../publishing/state.js";
import { parseTargets } from "../../publishing/targets.js";

import { accessibleStudioActorIds } from "../access.js";
import { postDeliveryProjections } from "../projections.js";
import { draftMedia, requireMutableDraft, requireOwnedDraft, requirePostEditAllowed } from "./post-access.js";
import { postProgressState } from "./post-progress.js";
import { settingsService } from "./settings.js";

type EditInput = {
  locale: "ru" | "en";
  text: string;
  entities: unknown[];
  media: Record<string, unknown>[];
  replaceMediaOnly?: boolean;
  /** Caller has already recognized an explicit "clear media" command in its own transport. */
  clearMedia?: boolean;
};
type DraftEntityCandidate = { kind: "company" | "model" | "person" | "topic"; slug: string; titleRu: string; titleEn: string | null };
type DraftPatchField = Exclude<keyof DraftPatch, "updatedAt">;

const draftPatchReaders = {
  textRu: (draft: DraftRecord) => draft.text_ru,
  textEnApproved: (draft: DraftRecord) => draft.text_en_approved,
  textRuEntitiesJson: (draft: DraftRecord) => draft.text_ru_entities_json,
  textEnEntitiesJson: (draft: DraftRecord) => draft.text_en_entities_json,
  targetsJson: (draft: DraftRecord) => draft.targets_json,
  mediaRuJson: (draft: DraftRecord) => draft.media_ru_json,
  mediaEnJson: (draft: DraftRecord) => draft.media_en_json,
  threadsChainApproved: (draft: DraftRecord) => draft.threads_chain_approved,
} satisfies Record<DraftPatchField, (draft: DraftRecord) => string | number | null>;

type PostScheduleInput = { ruAt: Date | null; enAt: Date | null; allowPast?: boolean; immediateLocale?: "ru" | "en" };
type PostScheduleScope = "ru" | "en" | "both";

/** Replans a scheduled text-only post after regenerated Story cards are ready. */
export function replanScheduledPostAfterStoryCards(backendDb: BackendDb, config: BackendConfig, draftId: number): boolean {
  return replanScheduled(
    backendDb,
    config,
    draftId,
    (draft) => isStoryPublishMode(draft) && Boolean(backendDb.storyCards.readyMedia(draftId)),
  );
}

/** Replans ordinary delivery after Story-card rendering gives up. */
export function replanScheduledPostAfterStoryCardFailure(backendDb: BackendDb, config: BackendConfig, draftId: number): boolean {
  const replanned = replanScheduled(
    backendDb,
    config,
    draftId,
    (draft) =>
      isStoryPublishMode(draft) &&
      hasStoryTarget(backendDb, draft) &&
      backendDb.storyCards.forDraft(draftId).some((card) => card.status === "failed"),
  );
  if (!replanned) return false;
  recordDomainEvent(backendDb.events, {
    ref: publicationRef("draft", draftId),
    type: "studio.notification.story-cards.failed",
    severity: "error",
    message: `Story cards failed for draft #${draftId}; Story delivery was skipped`,
    details: { draft_id: draftId },
    cooldownSeconds: 3600,
  });
  return true;
}

/** Replans a scheduled post after a durable content or target mutation. */
function replanScheduledPostAfterMutation(backendDb: BackendDb, config: BackendConfig, draftId: number): boolean {
  return replanScheduled(backendDb, config, draftId, (draft) => {
    const hasMedia = draftMedia(draft, "ru").length > 0 || draftMedia(draft, "en").length > 0;
    const hasFailedStoryCard = backendDb.storyCards.forDraft(draftId).some((card) => card.status === "failed");
    return !(
      isStoryPublishMode(draft) &&
      hasStoryTarget(backendDb, draft) &&
      !hasMedia &&
      !hasFailedStoryCard &&
      !backendDb.storyCards.readyMedia(draftId)
    );
  });
}

type ReplanGuard = (draft: DraftRecord) => boolean;

function replanScheduled(backendDb: BackendDb, config: BackendConfig, draftId: number, guard: ReplanGuard): boolean {
  const draft = backendDb.drafts.get(draftId);
  if (draft?.status !== "scheduled" || !guard(draft)) return false;
  schedulePost(backendDb, config, draft.actor_id, draftId, scheduledPostInput(draft));
  return true;
}

function scheduledPostInput(draft: DraftRecord): PostScheduleInput {
  return {
    ruAt: scheduledDate(draft.scheduled_at),
    enAt: scheduledDate(draft.scheduled_en_at),
    allowPast: true,
  };
}

/** Commands for post drafts. These are deliberately transport-free and become the
 * single entry point for Telegram, Web Studio and later MCP mutations. */
export function postService(backendDb: BackendDb, config: BackendConfig) {
  const progress = (actorId: number, draftId: number) => {
    const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
    return postProgressState(backendDb, draft.id);
  };

  const service = {
    kind: "post" as const,
    capabilities: { scheduleAxis: "locale" as const },
    create(actorId: number, message: DraftMessage, configured?: { targets: string[]; storyMode?: StoryPublishMode }): number {
      return trackUsageSync(backendDb, "studio.post.create", () => {
        // Every transport creates drafts through here, so the languages this
        // Studio publishes are checked once rather than by each of them: an
        // operator handing MCP or the CLI English copy for a Studio that has no
        // English channel is told so, instead of storing text nothing can
        // publish and every reader then has to learn to hide.
        if ((message.textEn || message.textEnApproved) && !postLocales(backendDb).includes("en"))
          throw new StudioError("err.post-locale-not-served", { locale: "EN" });
        if (!configured) return createDraftFromMessage(backendDb, actorId, message);
        return createDraftFromMessage(backendDb, actorId, message, {
          targetsJson: JSON.stringify(exactTargets(backendDb, configured.targets)),
          ...(configured.storyMode ? { storyPublishMode: configured.storyMode } : {}),
        });
      });
    },
    get(actorId: number, draftId: number) {
      return requireOwnedDraft(backendDb, config, actorId, draftId);
    },
    list(actorId: number, limit = 50) {
      return backendDb.drafts.list(accessibleStudioActorIds(config, actorId), limit);
    },
    validate(actorId: number, draftId: number) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      return publicationPreflight({
        ...draft,
        targets_json: JSON.stringify(effectivePostTargets(backendDb, parseTargets(draft.targets_json))),
      });
    },
    preview(actorId: number, draftId: number) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const ruContent = draftLocaleContent(draft, "ru");
      const enContent = draftLocaleContent(draft, "en");
      const storyCards = backendDb.storyCards.forDraft(draftId);
      // Ready means every card this draft actually has is rendered. The list
      // used to be spelled out as RU and EN, which waited forever for a card
      // the queue had already decided not to render: a locale with no text has
      // none, and a Studio that publishes one language never has the other.
      const storyCardsReady = storyCards.length > 0 && storyCards.every((card) => card.status === "ready" && card.localPath);
      const targets = effectivePostTargets(backendDb, parseTargets(draft.targets_json));
      return {
        id: draft.id,
        status: draft.status,
        issues: publicationPreflight({
          ...draft,
          targets_json: JSON.stringify(targets),
        }),
        locales: [
          { locale: "ru" as const, ...ruContent },
          { locale: "en" as const, ...enContent },
        ],
        targets,
        mediaPolicy: Object.entries(targets)
          .filter(([, enabled]) => enabled)
          .map(([target]) => mediaPolicyForTarget(target, targetLocale(target) === "ru" ? ruContent.media : enContent.media)),
        delivery: postDeliveryProjections(draft, storyCardsReady),
        storyCards,
      };
    },
    progress,
    status: progress,
    history(actorId: number, draftId: number, limit = 50) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      return backendDb.studioPosts.history(draft.id, draft.post_id, limit);
    },
    mediaAssets(actorId: number, limit = 50) {
      return listStudioMediaAssets(backendDb, actorId, limit, accessibleStudioActorIds(config, actorId));
    },
    attachMediaAssets(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[], replace = false): void {
      const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      const assets = mediaItemsFromAssets(
        requireStudioMediaAssets(backendDb, actorId, assetIds, accessibleStudioActorIds(config, actorId)),
      );
      const key = locale === "ru" ? "mediaRuJson" : "mediaEnJson";
      const current = replace ? [] : draftMedia(draft, locale);
      backendDb.drafts.update(draftId, {
        [key]: JSON.stringify([...current, ...assets]),
        updatedAt: backendDb.clock.now().toISOString(),
      });
      backendDb.storyCards.queue(draftId);
      replanScheduledPostAfterMutation(backendDb, config, draftId);
      recordDomainEvent(backendDb.events, {
        ref: publicationRef("draft", draftId),
        type: "content.draft.media_attached",
        severity: "info",
        message: `Draft #${draftId} media attached`,
        details: { locale, asset_ids: assetIds, replace },
      });
    },
    removeMedia(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[]): void {
      const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      const current = draftMedia(draft, locale);
      const removed = new Set(assetIds);
      const media = current.filter((item) => !removed.has(Number(item.asset_id)));
      backendDb.drafts.update(draftId, {
        [locale === "ru" ? "mediaRuJson" : "mediaEnJson"]: JSON.stringify(media),
        updatedAt: backendDb.clock.now().toISOString(),
      });
      backendDb.storyCards.queue(draftId);
      replanScheduledPostAfterMutation(backendDb, config, draftId);
      recordDomainEvent(backendDb.events, {
        ref: publicationRef("draft", draftId),
        type: "content.draft.media_removed",
        severity: "info",
        message: `Draft #${draftId} media removed`,
        details: { locale, asset_ids: assetIds },
      });
    },
    schedule(actorId: number, draftId: number, input: PostScheduleInput | PublicationSchedule): number {
      return trackUsageSync(backendDb, "studio.post.schedule", () =>
        schedulePost(backendDb, config, actorId, draftId, toPostScheduleInput(input)),
      );
    },
    hasLocaleTargets(actorId: number, draftId: number, locale: "ru" | "en"): boolean {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      return hasLocaleTarget(effectivePostTargets(backendDb, parseTargets(draft.targets_json)), locale);
    },
    slotTime(actorId: number, clock: string): Date {
      const timeConfig = settingsService(backendDb).timeConfig(actorId, config);
      return publicationSlotTime(clock, timeConfig.TIMEZONE, backendDb.clock.now());
    },
    manualSchedule(actorId: number, draftId: number, scope: PostScheduleScope, value: string): PostScheduleInput {
      const timeConfig = settingsService(backendDb).timeConfig(actorId, config);
      return scheduleAt(
        requireOwnedDraft(backendDb, config, actorId, draftId),
        scope,
        parseManualSchedule(value, timeConfig.TIMEZONE, backendDb.clock.now()),
      );
    },
    scheduleAt(actorId: number, draftId: number, scope: PostScheduleScope, value: Date): PostScheduleInput {
      return scheduleAt(requireOwnedDraft(backendDb, config, actorId, draftId), scope, value);
    },
    cancel(actorId: number, draftId: number): void {
      trackUsageSync(backendDb, "studio.post.cancel", () => {
        const draft = requireMutableDraft(backendDb, config, actorId, draftId);
        cancelDraft(backendDb, draftId);
        if (draft.post_id != null) cancelScheduledNotifications(backendDb, publicationRef("post", draft.post_id));
      });
    },
    cancelJobs(actorId: number, draftId: number): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      cancelPendingPostJobs(backendDb, draftId);
      if (draft.post_id != null) cancelScheduledNotifications(backendDb, publicationRef("post", draft.post_id));
    },
    setStoryPublishMode(actorId: number, draftId: number, mode: StoryPublishMode): void {
      requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      backendDb.storyCards.setPublishMode(draftId, mode);
      replanScheduledPostAfterMutation(backendDb, config, draftId);
    },
    replaceEntityCandidates(actorId: number, draftId: number, candidates: DraftEntityCandidate[]): void {
      requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      backendDb.studioPosts.replaceEntityCandidates(draftId, candidates, backendDb.clock.now().toISOString());
      replanScheduledPostAfterMutation(backendDb, config, draftId);
    },
    acceptEntityCandidates(actorId: number, draftId: number): void {
      requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      backendDb.studioPosts.acceptEntityCandidates(draftId, backendDb.clock.now().toISOString());
      replanScheduledPostAfterMutation(backendDb, config, draftId);
    },
    /** Waives the 500-character Threads rule for this draft: the overflow becomes
     * a reply chain. Deliberately has no "off" command — editing the text resets
     * it, and a draft nobody waived is the normal state. */
    approveThreadsChain(actorId: number, draftId: number): void {
      requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      backendDb.drafts.update(draftId, { threadsChainApproved: 1, updatedAt: backendDb.clock.now().toISOString() });
      replanScheduledPostAfterMutation(backendDb, config, draftId);
      recordDomainEvent(backendDb.events, {
        ref: publicationRef("draft", draftId),
        type: "content.draft.threads-chain-approved",
        severity: "info",
        message: `Draft #${draftId} waived the Threads single-post rule`,
        details: {},
      });
    },
    publish(actorId: number, draftId: number): number {
      return trackUsageSync(backendDb, "studio.post.publish", () => {
        requireMutableDraft(backendDb, config, actorId, draftId);
        return publishDraftToQueue(backendDb, draftId);
      });
    },
    retryTarget(actorId: number, draftId: number, target?: string) {
      return trackUsageSync(backendDb, "studio.post.retry", () => {
        const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
        if (draft.post_id == null) throw new StudioError("err.retry-only-failed");
        const retryable = backendDb.studioPosts
          .failedPublicationTargets(draft.post_id)
          .filter((item) => isPostTargetRetryable(item.target, item.status));
        const selected = target ? retryable.filter((item) => item.target === target) : retryable;
        if (selected.length === 0) throw new StudioError("err.retry-only-failed");
        const postId = draft.post_id;
        const results = requeuePublicationTargets(
          backendDb,
          { postId, publicationKey: publicationRef("post", postId), messageId: null },
          selected.map((item) => item.target),
          {
            from: AUDIENCE_MUTATION_RETRYABLE_STATUSES,
            audienceReached: "resume",
            source: () => backendDb.studioPosts.publicationSource(postId),
          },
        );
        const requeued = results.filter((item) => item.outcome === "requeued").length;
        const alreadyQueued = results.filter((item) => item.outcome === "already_queued").length;
        // Held back because the target already put something in front of the
        // audience and carries nothing to continue from. Saying "only failed
        // targets can be retried" about a target that plainly failed is how an
        // operator concludes the bot is lying to them.
        if (requeued === 0 && alreadyQueued === 0 && results.some((item) => item.reason === "already_delivered"))
          throw new StudioError("err.retry-already-delivered");
        if (requeued === 0 && alreadyQueued === 0) throw new StudioError("err.retry-only-failed");
        return { results, requeued, alreadyQueued };
      });
    },
    /** Gives up on a target that did not land: the publication is finished
     * without it. Unlike a retry, an ambiguous `verification_required` target is
     * included -- abandoning it sends nothing, and leaving it is what keeps the
     * post asking for attention forever. */
    skipTarget(actorId: number, draftId: number, target?: string) {
      return trackUsageSync(backendDb, "studio.post.skip", () => {
        const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
        if (draft.post_id == null) throw new StudioError("err.skip-only-failed");
        const failed = backendDb.studioPosts.failedPublicationTargets(draft.post_id);
        const selected = target ? failed.filter((item) => item.target === target) : failed;
        if (selected.length === 0) throw new StudioError("err.skip-only-failed");
        const postId = draft.post_id;
        const results = abandonPublicationTargets(
          backendDb,
          { postId, publicationKey: publicationRef("post", postId), messageId: null },
          selected.map((item) => item.target),
        );
        const abandoned = results.filter((item) => item.outcome === "abandoned").length;
        if (abandoned === 0) throw new StudioError("err.skip-only-failed");
        // The publication was held in `failed` by the very jobs just abandoned;
        // this is what takes it, and the draft, out of the attention list.
        refreshPublicationStatus(backendDb, postId);
        return { results, abandoned };
      });
    },
    toggleTarget(actorId: number, draftId: number, target: string): void {
      const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      assertKnownTarget(backendDb, target);
      const targets = parseTargets(draft.targets_json);
      targets[target] = !targets[target];
      saveTargetsAndReschedule(backendDb, config, actorId, draftId, draft, targets);
    },
    removeTarget(actorId: number, draftId: number, target: string): void {
      const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      assertKnownTarget(backendDb, target);
      const targets = parseTargets(draft.targets_json);
      if (!targets[target]) return;
      targets[target] = false;
      saveTargetsAndReschedule(backendDb, config, actorId, draftId, draft, targets);
    },
    cycleMode(actorId: number, draftId: number): keyof typeof PRESETS {
      const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      const targets = parseTargets(draft.targets_json);
      const current = presetName(targets);
      // A preset for a language this Studio connected nothing for resolves to an
      // empty target list, which is not a mode -- it is a draft that publishes
      // nowhere. Such a preset is skipped rather than offered and then emptied.
      const locales = postLocales(backendDb);
      const order = (["full", "ru", "en", "tg"] as const).filter((name) => name !== "en" || locales.includes("en"));
      const next = order[(order.indexOf(current as (typeof order)[number]) + 1) % order.length] ?? "full";
      const nextPreset = PRESETS[next];
      if (!nextPreset) throw new StudioError("err.post-mode");
      const preset = effectivePostTargets(backendDb, nextPreset);
      saveTargetsAndReschedule(backendDb, config, actorId, draftId, draft, preset);
      return next;
    },
    edit(actorId: number, draftId: number, input: EditInput): void {
      trackUsageSync(backendDb, "studio.post.edit", () => {
        // Same rule as create: a language this Studio does not publish has no
        // copy to write, whichever transport is asking.
        if (!postLocales(backendDb).includes(input.locale))
          throw new StudioError("err.post-locale-not-served", { locale: input.locale.toUpperCase() });
        const { draft, patch } = prepareDraftContentEdit(backendDb, config, actorId, draftId, input);
        withDraftRollback(
          backendDb,
          draftId,
          draft,
          patch,
          () => {
            backendDb.drafts.update(draftId, patch);
            backendDb.storyCards.queue(draftId);
            const updated = backendDb.drafts.get(draftId) ?? draft;
            if (!waitForStoryCardReplan(backendDb, updated)) rescheduleIfNeeded(backendDb, config, actorId, draftId, updated);
          },
          { queueStoryCards: true },
        );
        recordEditEvent(backendDb, draftId, input);
      });
    },
  };
  service satisfies PublicationPipeline;
  return service;
}

function toPostScheduleInput(input: PostScheduleInput | PublicationSchedule): PostScheduleInput {
  if (!("values" in input)) return input;
  return {
    ruAt: input.values.ru ?? null,
    enAt: input.values.en ?? null,
    ...(input.allowPast === undefined ? {} : { allowPast: input.allowPast }),
    ...(input.immediateKey === "ru" || input.immediateKey === "en" ? { immediateLocale: input.immediateKey } : {}),
  };
}

function isStoryPublishMode(draft: DraftRecord): boolean {
  return draft.story_publish_mode === "all" || draft.story_publish_mode === "site_only";
}

function hasStoryTarget(backendDb: BackendDb, draft: DraftRecord): boolean {
  return Object.entries(effectivePostTargets(backendDb, parseTargets(draft.targets_json))).some(
    ([target, enabled]) => enabled && isStoryTarget(target),
  );
}

function waitForStoryCardReplan(backendDb: BackendDb, draft: DraftRecord): boolean {
  if (draft.status !== "scheduled" || !isStoryPublishMode(draft)) return false;
  if (draftMedia(draft, "ru").length > 0 || draftMedia(draft, "en").length > 0) return false;
  return hasStoryTarget(backendDb, draft);
}

function prepareDraftContentEdit(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  input: EditInput,
): { draft: DraftRecord; patch: DraftPatch } {
  const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now(), input.locale);
  const clearMedia = Boolean(input.clearMedia);
  const update: DraftPatch = { updatedAt: backendDb.clock.now().toISOString() };
  const ru = input.locale === "ru";
  if (clearMedia) update[ru ? "mediaRuJson" : "mediaEnJson"] = null;
  else {
    if (input.media.length) update[ru ? "mediaRuJson" : "mediaEnJson"] = JSON.stringify(input.media);
    if (!input.replaceMediaOnly && input.text) {
      update[ru ? "textRu" : "textEnApproved"] = input.text;
      update[ru ? "textRuEntitiesJson" : "textEnEntitiesJson"] = JSON.stringify(emphasizeTitle(input.text, input.entities));
      // The waiver was given for a specific text the author had read. New text is
      // a new decision, so the 500-character rule applies again until waived anew.
      update.threadsChainApproved = 0;
    }
  }
  if (Object.keys(update).length === 1) throw new StudioError("err.post-no-edit");
  return { draft, patch: update };
}

function withDraftRollback<T>(
  backendDb: BackendDb,
  draftId: number,
  draft: DraftRecord,
  patch: DraftPatch,
  operation: () => T,
  options: { queueStoryCards?: boolean } = {},
): T {
  try {
    return operation();
  } catch (error) {
    const restored: DraftPatch = {
      ...Object.fromEntries(
        (Object.keys(patch) as Array<keyof DraftPatch>)
          .filter((field): field is DraftPatchField => field !== "updatedAt")
          .map((field) => [field, draftPatchReaders[field](draft)]),
      ),
      updatedAt: backendDb.clock.now().toISOString(),
    };
    backendDb.drafts.update(draftId, restored);
    if (options.queueStoryCards) backendDb.storyCards.queue(draftId);
    throw error;
  }
}

function recordEditEvent(backendDb: BackendDb, draftId: number, input: EditInput): void {
  recordDomainEvent(backendDb.events, {
    ref: publicationRef("draft", draftId),
    type: "content.draft.edited",
    severity: "info",
    message: `Draft #${draftId} content updated`,
    details: {
      locale: input.locale,
      media_changed: input.media.length > 0 || Boolean(input.clearMedia),
      text_changed: !input.replaceMediaOnly,
    },
  });
}

function saveTargetsAndReschedule(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  draft: DraftRecord,
  targets: Record<string, boolean>,
): void {
  const patch: DraftPatch = { targetsJson: JSON.stringify(targets), updatedAt: backendDb.clock.now().toISOString() };
  withDraftRollback(backendDb, draftId, draft, patch, () => {
    backendDb.drafts.update(draftId, patch);
    rescheduleIfNeeded(backendDb, config, actorId, draftId, draft);
  });
}

function rescheduleIfNeeded(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number, draft: DraftRecord): void {
  if (draft.status !== "scheduled") return;
  schedulePost(backendDb, config, actorId, draftId, scheduledPostInput(draft));
}

function schedulePost(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number, input: PostScheduleInput): number {
  const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
  if (draft.status === "cancelled") throw new StudioError("err.post-locked");
  const now = backendDb.clock.now();
  for (const [locale, value] of [
    ["ru", input.ruAt],
    ["en", input.enAt],
  ] as const) {
    if (!value) continue;
    const existing = locale === "ru" ? scheduledDate(draft.scheduled_at) : scheduledDate(draft.scheduled_en_at);
    const preservesExistingSchedule = existing?.getTime() === value.getTime();
    if (input.allowPast || input.immediateLocale === locale || preservesExistingSchedule) assertValidScheduleDate(value);
    else assertFutureSchedule(value, now);
  }
  const postId = publishDraftToQueue(backendDb, draftId, {
    mode: "scheduled",
    ruAt: input.ruAt,
    enAt: input.enAt,
    ...(input.immediateLocale ? { immediateLocale: input.immediateLocale } : {}),
  });
  const scheduled = requireOwnedDraft(backendDb, config, actorId, draftId);
  rescheduleReminders(backendDb, actorId, postId, draft, scheduled);
  return postId;
}

function rescheduleReminders(backendDb: BackendDb, actorId: number, postId: number, draft: DraftRecord, scheduled: DraftRecord): void {
  const notifications = settingsService(backendDb).notifications(actorId);
  const reminders = { enabled: notifications.postRemindersEnabled, minutes: notifications.reminderMinutes };
  const title = truncateUnicode(draft.text_ru.trim().split("\n")[0] ?? "", 100) || `Post #${postId}`;
  cancelScheduledNotifications(backendDb, publicationRef("post", postId));
  for (const [locale, scheduledAt] of [
    ["ru", scheduled.scheduled_at],
    ["en", scheduled.scheduled_en_at],
  ] as const) {
    if (!scheduledAt) continue;
    const targets = localeTargets(backendDb, draft.targets_json, locale);
    if (!targets.length) continue;
    scheduleReminder(backendDb, {
      actorId,
      ref: publicationRef("post", postId),
      kind: `post.${locale}`,
      publishAt: new Date(scheduledAt),
      title,
      targets,
      reminders,
    });
  }
}

function assertKnownTarget(backendDb: BackendDb, target: string): void {
  if (!TARGETS.some(({ id }) => id === target)) throw new StudioError("err.unknown-target");
  const registered = registeredPostTargetIds(backendDb);
  if (!registered.has(target)) throw new StudioError("err.unknown-target");
}

function exactTargets(backendDb: BackendDb, selected: string[]): Record<string, boolean> {
  const unique = new Set(selected);
  for (const target of unique) assertKnownTarget(backendDb, target);
  return Object.fromEntries(targetsFor("post").map(({ id }) => [id, unique.has(id)]));
}

function localeTargets(backendDb: BackendDb, json: string, locale: "ru" | "en"): string[] {
  return Object.entries(effectivePostTargets(backendDb, parseTargets(json)))
    .filter(([target, enabled]) => enabled && targetLocale(target) === locale)
    .map(([target]) => target);
}

function hasLocaleTarget(targets: Record<string, boolean>, locale: "ru" | "en"): boolean {
  return Object.entries(targets).some(([target, enabled]) => enabled && targetLocale(target) === locale);
}

function scheduleAt(draft: DraftRecord, scope: PostScheduleScope, value: Date): PostScheduleInput {
  return {
    ruAt: scope === "en" ? scheduledDate(draft.scheduled_at) : value,
    enAt: scope === "ru" ? scheduledDate(draft.scheduled_en_at) : value,
  };
}

/** Reads a persisted schedule column as a Date, treating an unset or unparsable
 * value as no schedule rather than an Invalid Date. */
function scheduledDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
