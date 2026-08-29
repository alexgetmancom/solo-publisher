import { type Context, InlineKeyboard } from "grammy";
import { flowStepInput } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { storeTelegramVideo } from "../interfaces/telegram/video-ingress.js";
import { VIDEO_LENGTH_WARNING_SECONDS, type VideoTarget } from "../publishing/video-types.js";
import type { StudioServices } from "../studio/services/index.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { advanceVideoMetadata, isVideoWizardStep, VIDEO_FLOW, type VideoWizardStep } from "../studio/video-fsm.js";
import { appendCancelButton, promptEffect } from "./dialog-ui.js";
import type { PublicationEffect, PublicationMessageResult } from "./effects.js";
import { describePublicationError } from "./error-text.js";
import { publicationCallback } from "./publication-callback.js";
import { advancePublicationFlow } from "./publication-flow.js";
import { publicationCardEffect, videoPreviewCard } from "./publication-renderers.js";
import { applyVideoScheduleDate } from "./video-scheduling.js";
import {
  clearVideoState,
  connectedVideoTargets,
  getVideoState,
  saveVideoState,
  type VideoConversationState,
  videoDurationLabel,
  videoErrorEffects,
  videoStepEffects,
} from "./video-ui.js";

type VideoMessageArgs = {
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  session: VideoConversationState;
  text: string;
  services: StudioServices;
};

/** Advances the MP4 → metadata → schedule conversation. It is entered from the
 * intake, which has already captured the file and asked for its language. */
export async function handleVideoConversationMessage(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
): Promise<PublicationMessageResult> {
  const actorId = Number(ctx.from?.id);
  const session = getVideoState(backendDb, actorId);
  if (!session) return { handled: false, effects: [] };
  // A step that expects nothing from the operator is driven by its own
  // controls. The message is still ours -- the wizard is open -- so say what
  // the step is waiting for rather than dropping it.
  const input = flowStepInput(VIDEO_FLOW, session.step);
  if (!input) {
    const locale = settingsService(backendDb).locale(actorId);
    return { handled: true, effects: [promptEffect(backendDb, actorId, "video", t(locale, "video.awaiting-button"))] };
  }
  try {
    const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
    if (input === "text" && !text) {
      const locale = settingsService(backendDb).locale(actorId);
      return { handled: true, effects: [promptEffect(backendDb, actorId, "video", t(locale, "video.await-text"))] };
    }
    const args = { ctx, backendDb, config, actorId, session, text };
    const services = createStudioServices(backendDb, config);
    const singleEdit = session.data.is_single_edit && isVideoWizardStep(session.step);
    return {
      handled: true,
      effects: singleEdit ? await finishSingleVideoEdit({ ...args, services }) : await acceptVideoMessage({ ...args, services }),
    };
  } catch (error) {
    const locale = settingsService(backendDb).locale(actorId);
    // The original error is operationally important (disk, Telegram download,
    // media import, Studio validation), and the admin reply can still be lost to
    // a Telegram send failure — log it first so the cause survives regardless.
    // `step` is what says which part of the conversation this was.
    log("error", "Video conversation step failed", {
      actorId,
      step: session.step,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      handled: true,
      effects: videoErrorEffects(
        backendDb,
        config,
        actorId,
        session,
        `🔴 ${t(locale, "video.value-error")}: ${describeError(locale, error)}`,
      ),
    };
  }
}

/** Routes the message to the operation the current step performs. The wizard's
 * metadata steps are deliberately one case: they differ only in which field
 * they collect, and the flow already knows that. */
async function acceptVideoMessage(args: VideoMessageArgs): Promise<PublicationEffect[]> {
  const { step } = args.session;
  if (step === "asset") return args.session.data.is_single_edit ? replaceVideoAsset(args) : acceptVideoAsset(args);
  if (step === "label") return acceptVideoLabel(args);
  if (step === "schedule_common" || step === "schedule_target") return acceptVideoScheduleDate(args);
  if (!isVideoWizardStep(step)) throw new StudioError("err.video-restart");
  return acceptVideoMetadata(args);
}

async function acceptVideoAsset({ ctx, backendDb, config, actorId, session, services }: VideoMessageArgs): Promise<PublicationEffect[]> {
  // Nothing about this depends on the upload, so fail before spending a
  // Telegram download and before a draft row exists to be orphaned.
  if (!connectedVideoTargets(backendDb).length) throw new StudioError("err.no-video-platforms-connected");
  const stored = await storeTelegramVideo(ctx, backendDb, config, actorId);
  return attachVideoAsset(backendDb, config, actorId, session, stored.assetId, services);
}

/** Puts a stored video behind a fresh draft and advances the wizard past the
 * upload step. The intake reaches this with a file it already stored from a
 * button press; the conversation reaches it with the message it just read.
 *
 * A clip over the length threshold stops here instead: the file is probed
 * before a draft exists, so answering "no" to the question leaves nothing
 * behind and the next upload starts clean. */
export async function attachVideoAsset(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  assetId: number,
  services: StudioServices = createStudioServices(backendDb, config),
): Promise<PublicationEffect[]> {
  const technical = await services.videos.assetTechnicalCheck(actorId, assetId);
  if (technical.seconds > VIDEO_LENGTH_WARNING_SECONDS)
    return videoLengthWarningEffects(backendDb, actorId, session, assetId, technical.seconds);
  return startVideoDraft(backendDb, config, actorId, session, assetId, services);
}

/** Asks about a clip longer than the operator's own cuts ever are, keeping the
 * session on the upload step: nothing is created until the question is answered
 * and a shorter file sent instead is simply attached in its place. */
function videoLengthWarningEffects(
  backendDb: BackendDb,
  actorId: number,
  session: VideoConversationState,
  assetId: number,
  seconds: number,
): PublicationEffect[] {
  const locale = settingsService(backendDb).locale(actorId);
  const saved = saveVideoState(backendDb, actorId, {
    ...session,
    draftId: null,
    step: "asset",
    selected: session.selected,
    data: { ...session.data, assetId },
  });
  const keyboard = new InlineKeyboard().text(
    t(locale, "video.length-warning-yes"),
    publicationCallback("video", "length_ok", [], saved.revision),
  );
  keyboard.row();
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), saved.revision);
  const text = t(locale, "video.length-warning", { dur: videoDurationLabel(seconds), limit: VIDEO_LENGTH_WARNING_SECONDS });
  return [{ type: "prompt", text, options: { parse_mode: "Markdown", reply_markup: keyboard } }];
}

/** The upload the operator has settled on, behind a fresh draft. */
export async function startVideoDraft(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  assetId: number,
  services: StudioServices = createStudioServices(backendDb, config),
): Promise<PublicationEffect[]> {
  // The platforms the operator chose on the destination screen, which the
  // session has carried since. Recomputing them from what is connected here is
  // what made that choice unpublishable.
  const selected = session.selected;
  if (!selected.length) throw new StudioError("err.no-video-platforms-connected");
  const videos = services.videos;
  const draftId = videos.create(actorId, assetId, session.data.videoLocale === "en" ? "en" : "ru");
  videos.replaceTargets(actorId, draftId, selected);
  const saved = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    { ...session, draftId, selected },
    assetId,
    { ...session.data, selectedTargets: selected },
    "err.video-restart",
  );
  return videoStepEffects(backendDb, config, actorId, saved);
}

/** Swaps the file behind an existing draft ("🎬 Replace video" on the edit
 * menu). The upload is stored the same way as the first one; only the draft it
 * lands on already exists. */
async function replaceVideoAsset({ ctx, backendDb, config, actorId, session, services }: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-reopen-edit");
  const stored = await storeTelegramVideo(ctx, backendDb, config, actorId);
  await services.videos.replaceSource(actorId, session.draftId, stored.assetId);
  return videoCardEffects(backendDb, config, actorId, session.draftId, services);
}

/** Renames a finished draft. The name is asked for from the draft's own edit
 * menu, so answering it ends on that draft's card. */
async function acceptVideoLabel({ backendDb, config, actorId, session, text, services }: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  services.videos.rename(actorId, session.draftId, text);
  return videoCardEffects(backendDb, config, actorId, session.draftId, services);
}

/** One case for every metadata field. A platform's collected fields are handed
 * to Video Studio the moment the flow leaves that platform's chain — the dialog
 * never decides what the metadata looks like or what the draft ends up called. */
async function acceptVideoMetadata({
  backendDb,
  config,
  actorId,
  session,
  text,
  services,
}: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  if (!isVideoWizardStep(session.step)) throw new StudioError("err.video-restart");
  const step = session.step;
  const saved = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    session,
    text,
    { ...session.data, selectedTargets: session.selected },
    "err.video-restart",
  );
  const completed = COMPLETED_WIZARD_TARGET[step];
  if (completed) services.videos.completeWizardTarget(actorId, session.draftId, completed, saved.data, session.selected);
  return videoStepEffects(backendDb, config, actorId, saved);
}

/** Isolates the one step that legitimately fails on bad user input. Any other
 * error in this flow (preview, delivery, storage) must reach the generic
 * describeError path instead of being misreported as an unparsable date. */
async function acceptVideoScheduleDate({
  backendDb,
  config,
  actorId,
  session,
  text,
  services,
}: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  let date: Date;
  try {
    date = services.videos.manualSchedule(actorId, session.draftId, text);
  } catch (error) {
    const locale = settingsService(backendDb).locale(actorId);
    const message = describePublicationError(locale, error, services.settings.timeConfig(actorId, config));
    return videoErrorEffects(backendDb, config, actorId, session, message);
  }
  return applyVideoScheduleDate(backendDb, config, actorId, session, date, services);
}

/** The last step of each platform's metadata chain, which is where that
 * platform's collected fields become its stored metadata. */
const COMPLETED_WIZARD_TARGET: Partial<Record<VideoWizardStep, VideoTarget>> = {
  youtube_tags: "youtube_shorts",
  instagram_caption: "instagram_reels",
};

/** Applies one already-set field edited outside the wizard order (reached via
 * "✏️ Edit" on a finished draft). The value is parsed by the same transition the
 * wizard uses, so "-" and URL fixing cannot drift between the two entry points. */
async function finishSingleVideoEdit({
  backendDb,
  config,
  actorId,
  session,
  text,
  services,
}: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-reopen-edit");
  if (!isVideoWizardStep(session.step)) throw new StudioError("err.video-reopen-edit");
  const step = session.step;
  const videos = services.videos;
  const parsed = advanceVideoMetadata(step, text, {})[step];
  videos.editMetadataField(actorId, session.draftId, step, parsed);
  return videoCardEffects(backendDb, config, actorId, session.draftId, services);
}

/** Ends the dialog on the draft's own card. Both single-field edits and the
 * label edit finish this way: there is no next question to ask. */
function videoCardEffects(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  services: StudioServices,
): PublicationEffect[] {
  clearVideoState(backendDb, actorId);
  return publicationCardEffect(videoPreviewCard(backendDb, config, actorId, draftId, services), { mode: "reply" });
}
