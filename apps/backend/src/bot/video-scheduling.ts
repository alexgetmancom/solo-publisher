import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import type { VideoTarget, VideoTechnicalCheck } from "../publishing/video-types.js";
import type { StudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { VIDEO_FLOW, videoScheduleDates } from "../studio/video-fsm.js";
import type { PublicationEffect } from "./effects.js";
import { advancePublicationFlow } from "./publication-flow.js";
import { videoPreviewCard } from "./publication-renderers.js";
import {
  clearVideoState,
  type VideoConversationState,
  videoDurationLabel,
  videoScheduleConfirmationEffects,
  videoStepEffects,
} from "./video-ui.js";

/** Applies one chosen time to whichever scheduling step the session is on. The
 * schedule can be completed from either transport — slot buttons or a typed
 * date — and both must advance identically, so the flow decides what comes
 * next and neither caller recomputes the remaining platforms. */
export async function applyVideoScheduleDate(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  date: Date,
  services: StudioServices,
): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  const next = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    session,
    date.toISOString(),
    { ...session.data, selectedTargets: session.selected },
    "err.video-reopen-publish",
  );
  if (next.step === "schedule_target") {
    return videoStepEffects(backendDb, config, actorId, next);
  }
  return videoScheduleConfirmationEffects(
    backendDb,
    config,
    actorId,
    next,
    videoScheduleDates((next.data.schedule as Record<string, string> | undefined) ?? {}),
    services,
  );
}

export async function finishVideoSchedule(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  schedule: Partial<Record<VideoTarget, Date>>,
  services: StudioServices,
): Promise<PublicationEffect[]> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const locale = settingsService(backendDb).locale(actorId);
  const technical = await services.videos.schedule(actorId, session.draftId, schedule);
  return showScheduledVideo(backendDb, config, actorId, session, technical, locale, services);
}

/** Telegram only renders the result; the immediate scheduling policy lives in Video Studio. */
export async function finishVideoNow(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  services: StudioServices,
): Promise<PublicationEffect[]> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const locale = settingsService(backendDb).locale(actorId);
  const technical = await services.videos.publish(actorId, session.draftId);
  return showScheduledVideo(backendDb, config, actorId, session, technical, locale, services);
}

/** Formats the transport-neutral technical check into a Telegram summary line. */
function videoCheckSummary(technical: VideoTechnicalCheck, locale: StudioLocale): string {
  const audioCodec = technical.audioCodec ?? t(locale, "video.no-audio");
  return t(locale, "video.check-summary", {
    dims: `${technical.width}×${technical.height}`,
    dur: videoDurationLabel(technical.seconds),
    codecs: `${technical.videoCodec.toUpperCase()}/${audioCodec.toUpperCase()}`,
    sound: technical.audioCodec ? t(locale, "video.has-audio") : t(locale, "video.no-audio"),
    fps: technical.fps ? `${technical.fps.toFixed(0)} FPS` : t(locale, "video.fps-unknown"),
    mb: Math.ceil(technical.sizeBytes / 1024 / 1024),
  });
}

async function showScheduledVideo(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  technical: VideoTechnicalCheck,
  locale: StudioLocale,
  services: StudioServices,
): Promise<PublicationEffect[]> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const preview = videoPreviewCard(backendDb, config, actorId, session.draftId, services);
  const reminderMinutes = services.settings.notifications(actorId).reminderMinutes;
  const warning = technical.aspectOk ? "" : `\n${t(locale, "video.aspect-warning")}`;
  const text = `${videoCheckSummary(technical, locale)}${warning}\n\n✅ ${t(locale, "common.scheduled")}. ${t(locale, "video.reminder", { minutes: reminderMinutes })}\n\n${preview.text}`;
  clearVideoState(backendDb, actorId);
  return [
    { type: "screen", text: `✅ ${t(locale, "video.confirmed-card")}` },
    {
      type: "screen",
      text,
      options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
      card: { kind: "video", draftId: session.draftId },
    },
  ];
}
