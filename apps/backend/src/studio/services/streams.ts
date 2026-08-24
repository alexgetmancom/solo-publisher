import { videoLocales } from "../../channels/locales.js";
import type { BackendDb } from "../../db/client.js";
import {
  type BroadcastEdit,
  editYouTubeBroadcast,
  LIVE_CHAT_LIMIT,
  LIVE_DESCRIPTION_LIMIT,
  LIVE_TITLE_LIMIT,
  type LiveBroadcast,
  sayInYouTubeChat,
  youtubeBroadcastInventory,
} from "../../delivery/live-broadcast.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { VideoLocale } from "../../foundation/external/youtube.js";

export type { LiveBroadcast };
/** One of the Studio's YouTube channels, as the stream screen sees it. A
 * channel that could not answer carries why: "not enabled for live streaming"
 * is a permanent property of the account and reads as "no stream here", while
 * an expired credential must not read the same way silently. */
/** What the platform will accept, republished here so a screen can say it in a
 * prompt without reaching past this service for the number. */
export { LIVE_CHAT_LIMIT, LIVE_DESCRIPTION_LIMIT, LIVE_TITLE_LIMIT };

export type StreamChannel = { locale: VideoLocale; broadcasts: LiveBroadcast[]; error: string | null };

export type StudioStream = {
  chosen: { locale: VideoLocale; broadcast: LiveBroadcast } | null;
  channels: StreamChannel[];
};

/**
 * The live stream a Studio is running, and the edits an operator can make to
 * it.
 *
 * Which YouTube channel is a question the platform answers: a person streams on
 * one channel at a time, and the one on the air is the one they mean. A Studio
 * with two connected channels asked about it on every edit, which is a question
 * the operator had already answered by going live.
 */
export function streamService(backendDb: BackendDb, config: BackendConfig) {
  return {
    async current(fetchImpl: typeof fetch = fetch): Promise<StudioStream> {
      const channels = await Promise.all(
        videoLocales(backendDb).map(async (locale): Promise<StreamChannel> => {
          try {
            const { broadcasts } = await youtubeBroadcastInventory(config, locale, fetchImpl);
            return { locale, broadcasts, error: null };
          } catch (error) {
            return { locale, broadcasts: [], error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      const candidates = channels.flatMap(({ locale, broadcasts }) => {
        const [broadcast] = broadcasts;
        return broadcast ? [{ locale, broadcast }] : [];
      });
      const onAir = candidates.find(({ broadcast }) => broadcast.lifeCycleStatus === "live" || broadcast.lifeCycleStatus === "testing");
      return { chosen: onAir ?? candidates[0] ?? null, channels };
    },
    /** Applies one edit to the named channel's chosen broadcast. The channel is
     * named by the caller rather than resolved again, so a stream starting on
     * the other one between the prompt and the answer is never the one edited. */
    edit(locale: VideoLocale, edit: BroadcastEdit, fetchImpl: typeof fetch = fetch): Promise<LiveBroadcast | null> {
      return editYouTubeBroadcast(config, edit, locale, fetchImpl);
    },
    /** Says one thing in the chat of the stream the prompt was opened against.
     * The chat id comes from that same screen: a stream that ended meanwhile
     * has no chat, and YouTube refuses the id rather than posting into the
     * next stream's chat. */
    say(locale: VideoLocale, liveChatId: string, message: string, fetchImpl: typeof fetch = fetch): Promise<void> {
      return sayInYouTubeChat(config, liveChatId, message, locale, fetchImpl);
    },
  };
}
