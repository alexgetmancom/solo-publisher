import { InlineKeyboard } from "grammy";
import { backFlow } from "../application/conversation-flow.js";
import { videoDestinations } from "../channels/destinations.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { type MessageKey, t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { manualScheduleExample } from "../foundation/time.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { createStudioServices, type StudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { isVideoWizardStep, VIDEO_FLOW, type VideoConversationStep, type VideoWizardStep } from "../studio/video-fsm.js";
import { type ConversationState, clearConversationState, getConversationState, saveConversationState } from "./conversation-state.js";
import { appendCancelButton, appendConfirmationRow, promptEffect } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import { publicationCallback } from "./publication-callback.js";
import { createPublicationScheduleEngine, SCHEDULE_SLOT_PRESETS, scheduleConfirmationEffects, scheduleTimeKeyboard } from "./scheduling.js";
import { screenCallback } from "./screen-callback.js";

export type { VideoConversationStep } from "../studio/video-fsm.js";
export type VideoConversationState = ConversationState & {
  step: VideoConversationStep;
  selected: VideoTarget[];
};
export type VideoConversationInput = Omit<VideoConversationState, "kind" | "revision" | "controlMessageId"> &
  Partial<Pick<VideoConversationState, "controlMessageId" | "revision">>;

export function connectedVideoTargets(backendDb: BackendDb): VideoTarget[] {
  const connected = new Set(videoDestinations(backendDb).map((destination) => destination.target));
  return VIDEO_TARGETS.filter((target) => connected.has(target));
}

export function getVideoState(backendDb: BackendDb, actorId: number): VideoConversationState | null {
  const state = getConversationState(backendDb, actorId, "video");
  if (!state) return null;
  const step = parseVideoStep(state.step);
  if (!step) {
    clearVideoState(backendDb, actorId);
    return null;
  }
  const selected = state.data.selectedTargets === undefined ? [] : parseSelectedTargets(state.data.selectedTargets);
  if (!selected) {
    clearVideoState(backendDb, actorId);
    return null;
  }
  return { ...state, step, selected };
}

export function saveVideoState(backendDb: BackendDb, actorId: number, session: VideoConversationInput): VideoConversationState {
  const saved = saveConversationState(backendDb, actorId, {
    kind: "video",
    draftId: session.draftId,
    step: session.step,
    data: { ...session.data, selectedTargets: session.selected },
    controlMessageId: session.controlMessageId ?? null,
    ...(session.revision == null ? {} : { revision: session.revision }),
  });
  return { ...saved, step: session.step, selected: session.selected };
}

export function clearVideoState(backendDb: BackendDb, actorId: number): void {
  clearConversationState(backendDb, actorId, "video");
}

/** `mm:ss`, the one way a clip's length is written to the operator. */
export function videoDurationLabel(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Renders whatever the flow's current step asks the operator for. Every path
 * that advances the wizard — a typed message or a tapped control — ends here
 * with the step the transition produced, so no caller decides for itself which
 * question comes next or how it looks. */
export function videoStepEffects(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
): PublicationEffect[] {
  const step = session.step;
  const locale = settingsService(backendDb).locale(actorId);
  const timeConfig = createStudioServices(backendDb, config).settings.timeConfig(actorId, config);
  if (isVideoWizardStep(step)) return metadataPromptEffects(locale, step, session);
  if (step === "schedule_choice")
    return scheduleChoiceEffects(session, locale, t(locale, "video.saved-choose-schedule", { timezone: timeConfig.TIMEZONE_LABEL }));
  if (step === "schedule_common")
    return videoTimeEffects(
      session,
      locale,
      t(locale, "video.enter-datetime", {
        timezone: timeConfig.TIMEZONE_LABEL,
        example: manualScheduleExample(timeConfig.TIMEZONE, backendDb.clock.now()),
      }),
    );
  if (step === "schedule_target") {
    const target = session.data.target;
    // The step schedules one of the targets the operator picked, so a target
    // outside the current selection means the session drifted from its buttons.
    if (typeof target !== "string" || !session.selected.includes(target as VideoTarget)) throw new StudioError("err.video-restart");
    return videoTimeEffects(
      session,
      locale,
      t(locale, "video.schedule-target-prompt", {
        target: videoTargetLabel(target as VideoTarget),
        timezone: timeConfig.TIMEZONE_LABEL,
        example: manualScheduleExample(timeConfig.TIMEZONE, backendDb.clock.now()),
      }),
    );
  }
  throw new StudioError("err.video-restart");
}

/** What an unusable value is answered with: the same question, carrying the
 * same controls -- the flow's Back among them.
 *
 * A rejected value used to arrive as a bare error under a lone Cancel, so a
 * title two characters too long left the wizard with no way back to the
 * question it had just asked. Steps that are not a question of the flow's own
 * (the upload, the rename from the card, a field edited on its own) keep the
 * plain prompt: their way back is the cancel that returns to the card. */
export function videoErrorEffects(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  message: string,
): PublicationEffect[] {
  const rerenders = !session.data.is_single_edit && (isVideoWizardStep(session.step) || SCHEDULE_INPUT_STEPS.includes(session.step));
  if (!rerenders) return [promptEffect(backendDb, actorId, "video", message, { plainText: true })];
  const [first, ...rest] = videoStepEffects(backendDb, config, actorId, session);
  if (first?.type !== "screen") throw new StudioError("err.video-restart");
  return [{ ...first, text: `${message}\n\n${first.text}` }, ...rest];
}

const SCHEDULE_INPUT_STEPS: readonly VideoConversationStep[] = ["schedule_common", "schedule_target"];

function metadataPromptEffects(locale: StudioLocale, step: VideoWizardStep, session: VideoConversationState): PublicationEffect[] {
  const { revision } = session;
  const keyboard = new InlineKeyboard();
  if (step === "youtube_game_url") keyboard.text(t(locale, "video.skip"), publicationCallback("video", "game_skip", [], revision));
  if (backFlow(VIDEO_FLOW, step, { selectedTargets: session.selected }))
    keyboard.text(t(locale, "common.back"), publicationCallback("video", "meta_back", [], revision));
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), revision);
  return [{ type: "screen", text: videoPrompt(locale, step), options: { reply_markup: keyboard } }];
}

const VIDEO_METADATA_PROMPTS: Record<VideoWizardStep, MessageKey> = {
  youtube_title: "video.prompt-yt-title",
  youtube_description: "video.prompt-yt-description",
  youtube_game_url: "video.prompt-yt-game-url",
  youtube_tags: "video.prompt-yt-tags",
  instagram_caption: "video.prompt-ig-caption",
};

function videoPrompt(locale: StudioLocale, prompt: VideoWizardStep): string {
  return t(locale, VIDEO_METADATA_PROMPTS[prompt]);
}

export function videoControlEffects(session: VideoConversationState, text: string, keyboard: InlineKeyboard): PublicationEffect[] {
  const card = session.draftId == null ? undefined : { kind: "video" as const, draftId: session.draftId };
  return [{ type: "screen", text, options: { parse_mode: "Markdown", reply_markup: keyboard }, ...(card ? { card } : {}) }];
}

function videoTimeEffects(session: VideoConversationState, locale: StudioLocale, text: string): PublicationEffect[] {
  const { revision, draftId } = session;
  if (draftId == null) throw new StudioError("err.video-missing");
  const engine = createPublicationScheduleEngine({
    kind: "video",
    publicationId: draftId,
    scheduleAxis: "target",
    axisKeys: session.selected,
    axisLabel: videoTargetLabel,
    slotValues: SCHEDULE_SLOT_PRESETS,
  });
  const keyboard = scheduleTimeKeyboard({
    axis: engine.axis,
    revision,
    manual: { label: t(locale, "video.enter-time-btn"), callback: engine.manualCallback() },
    cancel: { label: t(locale, "common.cancel"), callback: publicationCallback("video", "cancel_dialog") },
  });
  return videoControlEffects(session, text, keyboard);
}

/** Expects the session to already sit on `schedule_choice`: the caller applied
 * the transition that got here, and saving again only burns a revision the
 * keyboard below would then be built against. */
function scheduleChoiceEffects(session: VideoConversationState, locale: StudioLocale, text: string): PublicationEffect[] {
  return videoControlEffects(session, text, scheduleChoiceKeyboard(session, locale));
}

/** One time for every platform, or one each. Built here for both ways in: from
 * the wizard's own step and from "📅 Schedule" on a finished draft's card. */
export function scheduleChoiceKeyboard(
  session: Pick<VideoConversationState, "draftId" | "revision" | "selected">,
  locale: StudioLocale,
): InlineKeyboard {
  const { revision, draftId } = session;
  if (draftId == null) throw new StudioError("err.video-missing");
  const keyboard = new InlineKeyboard().text(t(locale, "video.same-time"), publicationCallback("video", "common", [draftId], revision));
  if (session.selected.length > 1)
    keyboard.row().text(t(locale, "video.different-time"), publicationCallback("video", "individual", [draftId], revision));
  keyboard.row();
  return appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), revision);
}

/** Moves the session to `schedule_confirm` and renders the per-target summary
 * with its confirm/back keyboard. Shared because the schedule can be completed
 * from either transport path — slot buttons (callbacks) or a typed date
 * (messages) — and both must land on the identical confirmation. */
export function videoScheduleConfirmationEffects(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  schedule: Partial<Record<VideoTarget, Date>>,
  services: StudioServices,
): PublicationEffect[] {
  const { draftId } = session;
  if (!draftId) throw new StudioError("err.video-missing");
  const locale = settingsService(backendDb).locale(actorId);
  const videos = services.videos;
  const timeConfig = services.settings.timeConfig(actorId, config);
  // The transition runner already saved the `schedule_confirm` session. This
  // renderer must only derive Telegram effects, otherwise one user action
  // would consume two revisions and invalidate its own buttons.
  const entries = session.selected.flatMap((target) => {
    const value = schedule[target];
    return value ? [{ key: target, value }] : [];
  });
  const engine = createPublicationScheduleEngine({
    kind: "video",
    publicationId: draftId,
    scheduleAxis: videos.capabilities.scheduleAxis,
    axisKeys: session.selected,
    axisLabel: videoTargetLabel,
    slotValues: [],
  });
  // The clip itself is not in the previews above -- it is the same file for
  // every platform -- so the one button that shows it sits here, next to the
  // confirmation the operator is about to give.
  const keyboard = new InlineKeyboard().text(t(locale, "video.show-source"), screenCallback("delivery_preview_video", [draftId])).row();
  return scheduleConfirmationEffects({
    kind: "video",
    publicationId: draftId,
    title: t(locale, "common.confirm-schedule"),
    titlePrefix: "🎬",
    entries,
    label: videoTargetLabel,
    formatValue: (value) =>
      `${value.toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { timeZone: timeConfig.TIMEZONE })} ${timeConfig.TIMEZONE_LABEL}`,
    keyboard: appendConfirmationRow(
      keyboard,
      { label: t(locale, "common.confirm"), callback: engine.confirmCallback() },
      { label: t(locale, "common.back"), callback: publicationCallback("video", "schedule", [draftId]) },
      session.revision,
    ),
    effects: [{ type: "delivery-previews", projections: videos.preview(actorId, draftId).delivery.projections, locale }],
  });
}

export function parseVideoStep(value: string): VideoConversationStep | null {
  return value in VIDEO_FLOW.steps ? (value as VideoConversationStep) : null;
}

function parseSelectedTargets(value: unknown): VideoTarget[] | null {
  if (!Array.isArray(value)) return null;
  if (new Set(value).size !== value.length) return null;
  return value.every((target): target is VideoTarget => typeof target === "string" && VIDEO_TARGETS.includes(target as VideoTarget))
    ? value
    : null;
}
