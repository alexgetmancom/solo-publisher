import { youtubeLocales } from "../../channels/locales.js";
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
/** What the platform will accept, republished here so a screen can say it in a
 * prompt without reaching past this service for the number. */
export { LIVE_CHAT_LIMIT, LIVE_DESCRIPTION_LIMIT, LIVE_TITLE_LIMIT };

/** One of the Studio's YouTube channels, as the stream screen sees it. A
 * channel that answered carries its streams; one that could not carries why,
 * unless the reason is that the account never had live streaming switched on. */
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
    /** The channels this screen can speak for at all. No channels, no screen:
     * the menu asks this before it offers the button. */
    channels(): VideoLocale[] {
      return youtubeLocales(backendDb);
    },
    async current(fetchImpl: typeof fetch = fetch): Promise<StudioStream> {
      const channels = await Promise.all(
        youtubeLocales(backendDb).map(async (locale): Promise<StreamChannel> => {
          try {
            const { broadcasts } = await youtubeBroadcastInventory(config, locale, fetchImpl);
            return { locale, broadcasts, error: null };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { locale, broadcasts: [], error: isLiveStreamingOff(message) ? null : shortReason(error) };
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

/** The account was never switched on for live streaming. YouTube says so in a
 * machine-readable reason, which is the part worth matching; the sentence
 * beside it is prose and changes.
 *
 * This is not a failure to report: it answers 403 forever, it is a property of
 * the account rather than of this request, and "YouTube EN did not answer"
 * followed by a stack of JSON is noise on a screen the operator opens while
 * streaming. Such a channel has no streams, which `broadcasts: []` already
 * says. An expired credential or an outage is a real fault and keeps its line.
 */
function isLiveStreamingOff(message: string): boolean {
  return message.includes("liveStreamingNotEnabled");
}

/** One line an operator can act on, out of a JSON error document. */
function shortReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Two shapes, because two Google services answer here: the API describes a
  // fault under "message", and OAuth under "error_description".
  const described = /"(?:message|error_description)":\s*"([^"]+)"/.exec(message)?.[1];
  const status = /failed: (\d{3})/.exec(message)?.[1];
  return described ?? (status ? `HTTP ${status}` : message.slice(0, 200));
}

/**
 * What this channel last called a stream, for a field the current one left
 * empty.
 *
 * Nothing carries over between streams on YouTube: every one is a new
 * broadcast, opening with an empty description and an automatic title. The
 * previous value is the thing the operator would otherwise retype, so the
 * prompt offers it -- as text to reuse, never applied on its own. Copying a
 * description forward silently would republish the last stream's links onto
 * one that is already on the air.
 */
export function previousValue(stream: StudioStream, field: "title" | "description"): string | null {
  if (!stream.chosen) return null;
  const channel = stream.channels.find(({ locale }) => locale === stream.chosen?.locale);
  const finished = (channel?.broadcasts ?? [])
    .filter((broadcast) => broadcast.id !== stream.chosen?.broadcast.id && broadcast.endedAt !== null && broadcast[field].trim())
    .sort((left, right) => String(right.endedAt).localeCompare(String(left.endedAt)));
  return finished[0]?.[field].trim() ?? null;
}
