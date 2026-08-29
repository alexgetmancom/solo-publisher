import { InlineKeyboard } from "grammy";
import { backFlow } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { type MessageKey, t } from "../foundation/i18n/index.js";
import { manualScheduleExample } from "../foundation/time.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import type { StudioServices } from "../studio/services/index.js";
import { VIDEO_FLOW } from "../studio/video-fsm.js";
import { promptEffect, resultNavigationKeyboard } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import { mainMenuText } from "./menu-render.js";
import type {
  action,
  PublicationActionDefinition,
  PublicationActionResult,
  PublicationDraftActionContext,
} from "./publication-action-contract.js";
import { publicationCallback } from "./publication-callback.js";
import { advancePublicationFlow } from "./publication-flow.js";
import { publicationCardEffect, publicationRenderers, videoPreviewCard } from "./publication-renderers.js";
import { startVideoDraft } from "./video-conversation.js";
import { applyVideoScheduleDate, finishVideoNow, finishVideoSchedule } from "./video-scheduling.js";
import {
  clearVideoState,
  getVideoState,
  parseVideoStep,
  saveVideoState,
  scheduleChoiceKeyboard,
  type VideoConversationInput,
  type VideoConversationState,
  videoStepEffects,
} from "./video-ui.js";

type VideoActionArgs = PublicationDraftActionContext;
type VideoActionResult = PublicationActionResult;

const SCHEDULE_SESSION_STEPS = ["schedule_common", "schedule_target"] as const;

const EDIT_FIELDS = {
  label: { label: "video.edit-card-name", prompt: "video.edit-label-prompt" },
  youtube_title: { label: "video.edit-yt-title", prompt: "video.edit-yt-title-prompt", target: "youtube_shorts" },
  youtube_description: { label: "video.edit-yt-desc", prompt: "video.edit-yt-desc-prompt", target: "youtube_shorts" },
  youtube_game_url: { label: "video.edit-game-url", prompt: "video.edit-game-url-prompt", target: "youtube_shorts" },
  youtube_tags: { label: "video.edit-yt-tags", prompt: "video.edit-yt-tags-prompt", target: "youtube_shorts" },
  instagram_caption: { label: "video.edit-ig-caption", prompt: "video.edit-ig-caption-prompt", target: "instagram_reels" },
} as const satisfies Record<string, { label: MessageKey; prompt: MessageKey; target?: VideoTarget }>;

type EditableVideoField = keyof typeof EDIT_FIELDS;

function requireFlowStep(current: string | undefined, allowed: readonly string[], errorCode: string): void {
  if (!current || !allowed.includes(current)) throw new StudioError(errorCode);
}

/** Declares the video-only portion of the publication action registry. */
export function defineVideoActionHandlers(define: typeof action): Record<string, PublicationActionDefinition> {
  return {
    cancel_dialog: define(handleCancelDialog, { entity: "session", sessionRevision: true, args: [] }),
    length_ok: define(handleLengthConfirm, { entity: "session", sessionRevision: true, args: [] }),
    game_skip: define(handleGameSkip, { entity: "session", sessionRevision: true, args: [] }),
    meta_back: define(handleMetaBack, { entity: "session", sessionRevision: true, args: [] }),
    schedule: define(handleScheduleStart, { entity: "draft", freshCard: true, args: [] }),
    common: define(handleScheduleMode, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    individual: define(handleScheduleMode, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    publish: define(handleNowAsk, { entity: "draft", freshCard: true, args: [] }),
    publish_confirm: define(handleNowConfirm, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    cancel: define(handleCancelAsk, { entity: "draft", freshCard: true, args: [] }),
    // Reachable from a standalone reminder message, not only from the card, so
    // card freshness would reject a legitimate cancellation. The service
    // validates target state instead.
    cancel_confirm: define(handleCancel, { entity: "draft", args: [] }),
    time: define(handleTime, { entity: "draft", freshCard: true, args: ["axis"] }),
    sched_pick: define(handleSchedulePick, { entity: "draft", freshCard: true, sessionRevision: true, args: ["axis", "clock"] }),
    sched_manual: define(handleScheduleManual, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    sched_confirm: define(handleScheduleConfirm, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    remove_ask: define(handleRemoveAsk, { entity: "draft", freshCard: true, args: ["target"] }),
    remove: define(handleRemove, { entity: "draft", freshCard: true, args: ["target"] }),
    edit_menu: define(handleEditMenu, { entity: "draft", freshCard: true, args: [] }),
    edit_field: define(handleEditField, { entity: "draft", freshCard: true, args: ["field"] }),
    edit_media: define(handleEditMedia, { entity: "draft", freshCard: true, args: [] }),
    settle: define(handleSettle, { entity: "draft", freshCard: true, args: ["target"] }),
  };
}

function requireVideoTarget(value: string): VideoTarget {
  const target = parseVideoTarget(value);
  if (!target) throw new StudioError("err.unknown-platform");
  return target;
}

function parseVideoTarget(value: string): VideoTarget | null {
  return VIDEO_TARGETS.find((candidate) => candidate === value) ?? null;
}

function getVideoTargets(services: StudioServices, actorId: number, id: number): VideoTarget[] {
  return services.videos.get(actorId, id).targets.map((row) => requireVideoTarget(row.target));
}

function requireVideoSession(
  backendDb: BackendDb,
  actorId: number,
  id: number,
  steps: readonly string[],
  errorCode: string,
): VideoConversationState {
  const session = getVideoState(backendDb, actorId);
  if (!session || session.draftId !== id) throw new StudioError(errorCode);
  requireFlowStep(session.step, steps, errorCode);
  return session;
}

/** Renders an owned video draft's card in place. Used by every action that ends
 * by returning to (or refreshing) the same card. */
function showVideoCard(backendDb: BackendDb, config: BackendConfig, actorId: number, id: number): PublicationEffect[] {
  return publicationCardEffect(videoPreviewCard(backendDb, config, actorId, id));
}

/** Asks a yes/no question on top of the draft's own card. "Back" always returns
 * to that same card, so a declined confirmation costs the operator nothing. */
function videoConfirmationEffect(
  args: Pick<VideoActionArgs, "backendDb" | "config" | "actorId" | "locale">,
  id: number,
  view: "confirm_now" | "confirm_cancel" | "confirm_remove",
  revision?: number,
  target?: VideoTarget,
): PublicationEffect[] {
  const card = publicationRenderers(args.backendDb, args.config).video.card({
    actorId: args.actorId,
    publicationId: id,
    locale: args.locale,
    view,
    revision,
    target,
  });
  return publicationCardEffect(card);
}

async function handleCancelDialog({ backendDb, config, actorId, mainMenu }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  clearVideoState(backendDb, actorId);
  // The draft already exists once a video file was uploaded (even mid-wizard):
  // cancel returns to that draft's own card so nothing is lost or orphaned,
  // rather than dropping into a menu with no way back to it.
  if (session?.draftId != null) {
    return showVideoCard(backendDb, config, actorId, session.draftId);
  }
  if (!mainMenu) throw new StudioError("err.video-restart");
  // Cancelling is pure navigation, not a content change: turn this same
  // message into the control panel instead of deleting and sending a new one.
  return [{ type: "screen", text: mainMenuText(backendDb, config, actorId), options: { reply_markup: mainMenu } }];
}

/** "Upload it anyway" on the length question: the file the question was asked
 * about is the one that becomes the draft, so a second upload sent meanwhile
 * cannot be adopted by a stale button. */
async function handleLengthConfirm({ backendDb, config, actorId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  requireFlowStep(session?.step, ["asset"], "err.video-restart");
  const assetId = session?.data.assetId;
  if (!session || typeof assetId !== "number") throw new StudioError("err.video-restart");
  return startVideoDraft(backendDb, config, actorId, session, assetId, services);
}

async function handleGameSkip({ backendDb, config, actorId, locale }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  requireFlowStep(session?.step, ["youtube_game_url"], "err.video-reopen-create");
  if (!session?.draftId) throw new StudioError("err.video-reopen-create");
  const next = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    session,
    "-",
    { ...session.data, selectedTargets: session.selected },
    "err.video-reopen-create",
  );
  return [{ type: "screen", text: t(locale, "video.game-skipped") }, ...videoStepEffects(backendDb, config, actorId, next)];
}

async function handleMetaBack({ backendDb, config, actorId }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  const previous = session && backFlow(VIDEO_FLOW, session.step, { selectedTargets: session.selected });
  if (!session?.draftId || !previous) throw new StudioError("err.video-reopen-create");
  const saved = saveVideoState(backendDb, actorId, { ...session, step: previous });
  return videoStepEffects(backendDb, config, actorId, saved);
}

async function handleScheduleConfirm({ backendDb, config, actorId, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const session = requireVideoSession(backendDb, actorId, draftId, ["schedule_confirm"], "action.schedule-expired");
  const values = scheduleValues(session.data.schedule);
  if (!values) throw new StudioError("action.schedule-expired");
  return finishVideoSchedule(backendDb, config, actorId, session, videoSchedule(values), services);
}

async function handleScheduleStart({ backendDb, config, actorId, locale, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const targets = getVideoTargets(services, actorId, draftId);
  if (!targets.length) throw new StudioError("err.video-no-platforms");
  const session = saveVideoState(backendDb, actorId, { draftId, step: "schedule_choice", selected: targets, data: {} });
  const keyboard = scheduleChoiceKeyboard(session, locale);
  const timeConfig = services.settings.timeConfig(actorId, config);
  const text = t(locale, "video.schedule-time-msk", { timezone: timeConfig.TIMEZONE_LABEL });
  return [{ type: "screen", text, options: { parse_mode: "Markdown", reply_markup: keyboard } }];
}

async function handleScheduleMode({ backendDb, config, actorId, action, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const session = requireVideoSession(backendDb, actorId, draftId, ["schedule_choice"], "err.video-reopen-publish");
  const targets = getVideoTargets(services, actorId, draftId);
  if (!targets.length) throw new StudioError("err.video-reopen-publish");
  const mode = action === "common" || action === "individual" ? action : null;
  if (!mode) throw new StudioError("err.video-reopen-publish");
  const flowData = { ...session.data, selectedTargets: targets };
  const next = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    { ...session, data: flowData, selected: targets },
    mode,
    flowData,
    "err.video-reopen-publish",
    (data, nextStep) => {
      const first = targets[0];
      if (nextStep === "schedule_target" && !first) throw new StudioError("err.video-no-platforms");
      return nextStep === "schedule_target" ? { ...data, schedule: {}, target: first } : data;
    },
  );
  return videoStepEffects(backendDb, config, actorId, next);
}

async function handleNowAsk(actionArgs: VideoActionArgs): Promise<VideoActionResult> {
  const { backendDb, actorId, draftId } = actionArgs;
  const session = saveVideoState(backendDb, actorId, {
    draftId,
    step: "schedule_confirm",
    selected: [],
    data: {},
  });
  return videoConfirmationEffect(actionArgs, draftId, "confirm_now", session.revision);
}

async function handleNowConfirm({ backendDb, config, actorId, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const session = requireVideoSession(backendDb, actorId, draftId, ["schedule_confirm"], "action.schedule-expired");
  return finishVideoNow(backendDb, config, actorId, session, services);
}

async function handleCancelAsk(actionArgs: VideoActionArgs): Promise<VideoActionResult> {
  return videoConfirmationEffect(actionArgs, actionArgs.draftId, "confirm_cancel");
}

async function handleRemoveAsk(actionArgs: VideoActionArgs): Promise<VideoActionResult> {
  const { draftId } = actionArgs;
  const targetText = actionArgs.args.target;
  const target = requireVideoTarget(targetText ?? "");
  return videoConfirmationEffect(actionArgs, draftId, "confirm_remove", undefined, target);
}

async function handleCancel({ backendDb, config, actorId, locale, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const result = await services.videos.cancel(actorId, draftId);
  clearVideoState(backendDb, actorId);
  const manualRemoval = result.manualRemoval
    .map(({ target, url }) => t(locale, "video.remove-manually", { label: videoTargetLabel(target), url: url ? `: ${url}` : "" }))
    .join("\n");
  const heldPrivate = result.heldPrivateYouTubeIds.length ? `\n${t(locale, "video.held-private")}` : "";
  const attention = result.holdFailures.length ? `\n${t(locale, "video.hold-failed")}` : "";
  return [
    {
      type: "screen",
      text: `${t(locale, "video.cancelled-local", { hours: config.VIDEO_MEDIA_RETENTION_HOURS })}${heldPrivate}${attention}${manualRemoval ? `\n\n${t(locale, "video.already-published")}\n${manualRemoval}` : ""}`,
      options: { reply_markup: resultNavigationKeyboard(locale) },
    },
  ];
}

async function handleTime({ backendDb, config, actorId, args, draftId }: VideoActionArgs): Promise<VideoActionResult> {
  const targetText = args.axis;
  const target = requireVideoTarget(targetText ?? "");
  const currentSession = getVideoState(backendDb, actorId);
  const session: VideoConversationInput = {
    draftId,
    step: "schedule_target",
    selected: [target],
    data: { target },
    ...(currentSession ? { revision: currentSession.revision } : {}),
  };
  const saved = saveVideoState(backendDb, actorId, session);
  return videoStepEffects(backendDb, config, actorId, saved);
}

async function handleSchedulePick({
  backendDb,
  config,
  actorId,
  args,
  draftId,
  pipeline,
  services,
}: VideoActionArgs): Promise<VideoActionResult> {
  const hhmm = args.clock;
  if (pipeline.capabilities.scheduleAxis !== "target") throw new StudioError("action.schedule-expired");
  const session = requireVideoSession(backendDb, actorId, draftId, SCHEDULE_SESSION_STEPS, "action.schedule-expired");
  const value = pipeline.slotTime(actorId, `${(hhmm ?? "").slice(0, 2)}:${(hhmm ?? "").slice(2, 4)}`);
  return applyVideoScheduleDate(backendDb, config, actorId, session, value, services);
}

async function handleScheduleManual({
  backendDb,
  config,
  actorId,
  locale,
  draftId,
  services,
}: VideoActionArgs): Promise<VideoActionResult> {
  requireVideoSession(backendDb, actorId, draftId, SCHEDULE_SESSION_STEPS, "action.schedule-expired");
  const timeConfig = services.settings.timeConfig(actorId, config);
  return [
    promptEffect(
      backendDb,
      actorId,
      "video",
      t(locale, "video.enter-datetime", {
        timezone: timeConfig.TIMEZONE_LABEL,
        example: manualScheduleExample(timeConfig.TIMEZONE, backendDb.clock.now()),
      }),
    ),
  ];
}

async function handleRemove({ backendDb, config, actorId, locale, args, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const targetText = args.target;
  const target = requireVideoTarget(targetText ?? "");
  const { cancelled } = services.videos.removeTarget(actorId, draftId, target);
  if (cancelled) {
    clearVideoState(backendDb, actorId);
    return [
      {
        type: "screen",
        text: t(locale, "video.all-removed"),
        options: { reply_markup: resultNavigationKeyboard(locale) },
      },
    ];
  }
  return [
    ...showVideoCard(backendDb, config, actorId, draftId),
    { type: "toast", text: t(locale, "video.removed", { label: videoTargetLabel(target) }) },
  ];
}

async function handleSettle({ backendDb, config, actorId, locale, args, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const target = requireVideoTarget(args.target ?? "");
  const settled = await services.videos.settleTarget(actorId, draftId, target);
  return [
    ...showVideoCard(backendDb, config, actorId, draftId),
    { type: "toast", text: t(locale, settled.url ? "video.settled" : "video.settled-unconfirmed") },
  ];
}

async function handleEditMenu({ actorId, locale, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const videos = services.videos;
  const details = videos.get(actorId, draftId);
  const canEditLabel = ["draft", "editing"].includes(details.draft.status);
  const targets = videos.metadataEditableTargets(actorId, draftId);
  const keyboard = new InlineKeyboard();
  for (const [field, definition] of Object.entries(EDIT_FIELDS) as [EditableVideoField, (typeof EDIT_FIELDS)[EditableVideoField]][]) {
    const editable = "target" in definition ? targets.includes(definition.target) : canEditLabel;
    if (editable) keyboard.text(t(locale, definition.label), publicationCallback("video", "edit_field", [draftId, field])).row();
  }
  if (videos.sourceReplaceable(actorId, draftId))
    keyboard.text(t(locale, "video.edit-media"), publicationCallback("video", "edit_media", [draftId])).row();
  keyboard.text(t(locale, "common.back"), publicationCallback("video", "view", [draftId, "overview"]));
  return [
    {
      type: "screen",
      text: t(locale, "video.what-to-edit"),
      options: { parse_mode: "Markdown", reply_markup: keyboard },
      card: { kind: "video", draftId },
    },
  ];
}

async function handleEditField({ backendDb, actorId, locale, args, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const field = args.field ?? "";
  const definition = EDIT_FIELDS[field as EditableVideoField];
  if (!definition) throw new StudioError("err.video-reopen-edit");
  const targets = services.videos.get(actorId, draftId).targets;
  const step = parseVideoStep(field);
  if (!step) throw new StudioError("err.video-reopen-edit");
  const session: VideoConversationInput = {
    draftId,
    step,
    selected: targets.map((target) => requireVideoTarget(target.target)),
    data: { is_single_edit: true },
  };
  saveVideoState(backendDb, actorId, session);
  return [promptEffect(backendDb, actorId, "video", t(locale, definition.prompt))];
}

/** Asks for a replacement upload. The answer is a file rather than text, so the
 * session waits on the same `asset` step the wizard uses. */
async function handleEditMedia({ backendDb, actorId, locale, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  if (!services.videos.sourceReplaceable(actorId, draftId)) throw new StudioError("err.video-source-locked");
  const targets = services.videos.get(actorId, draftId).targets;
  const session: VideoConversationInput = {
    draftId,
    step: "asset",
    selected: targets.map((target) => requireVideoTarget(target.target)),
    data: { is_single_edit: true },
  };
  saveVideoState(backendDb, actorId, session);
  return [promptEffect(backendDb, actorId, "video", t(locale, "video.edit-media-prompt"))];
}

function scheduleValues(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, date]) => typeof date === "string") ? Object.fromEntries(entries) : undefined;
}

function videoSchedule(values: Record<string, string>): Partial<Record<VideoTarget, Date>> {
  const schedule: Partial<Record<VideoTarget, Date>> = {};
  for (const [targetText, value] of Object.entries(values)) {
    const target = requireVideoTarget(targetText);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new StudioError("action.schedule-expired");
    schedule[target] = date;
  }
  return schedule;
}
