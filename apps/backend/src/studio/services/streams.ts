import { youtubeLocales } from "../../channels/locales.js";
import { listChannels } from "../../channels/registry.js";
import { type TwitchAuth, twitchAuth } from "../../channels/twitch-oauth.js";
import type { BackendDb } from "../../db/client.js";
import {
  editYouTubeBroadcast,
  LIVE_CHAT_LIMIT,
  LIVE_DESCRIPTION_LIMIT,
  LIVE_TITLE_LIMIT,
  type LiveBroadcast,
  sayInYouTubeChat,
  youtubeBroadcastInventory,
} from "../../delivery/live-broadcast.js";
import { sayInTwitchChat, TWITCH_CHAT_LIMIT, TWITCH_TITLE_LIMIT, twitchChannel, updateTwitchChannel } from "../../delivery/twitch.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { VideoLocale } from "../../foundation/external/youtube.js";

/** What an operator can change about a stream from the bot. */
export type StreamField = "title" | "description" | "chat";

/**
 * The smallest limit any connected surface will accept for a field.
 *
 * One typed line goes to every surface at once, so the prompt has to state the
 * strictest of them: Twitch takes 140 characters of title and YouTube 100, and
 * a line written to the larger is refused by the smaller after the operator
 * already pressed send.
 */
export const FIELD_LIMIT: Record<StreamField, number> = {
  title: Math.min(LIVE_TITLE_LIMIT, TWITCH_TITLE_LIMIT),
  description: LIVE_DESCRIPTION_LIMIT,
  chat: Math.min(LIVE_CHAT_LIMIT, TWITCH_CHAT_LIMIT),
};

/**
 * One place an edit can land: a YouTube broadcast or a Twitch channel.
 *
 * The two are not the same object wearing different names. A YouTube title
 * belongs to a broadcast that exists only around a stream and carries a
 * description; a Twitch title belongs to the channel itself, survives the
 * stream ending, and has no description at all. `description: null` says the
 * surface has no such field, which is different from having an empty one.
 */
export type StreamPlace = {
  surface: "youtube" | "twitch";
  label: string;
  title: string;
  description: string | null;
  live: boolean;
  url: string;
  /** Whether this place can take an edit at all right now. YouTube between
   * streams has no broadcast to edit; a Twitch channel always does. */
  editable: boolean;
  chatId: string | null;
  /** What this surface last called a stream, for a field the current one opened
   * empty. Nothing carries over between YouTube broadcasts, so this is the text
   * the operator would otherwise retype; a Twitch title never went anywhere and
   * has none. */
  previous: { title: string | null; description: string | null };
  error: string | null;
};

export type StudioStream = { places: StreamPlace[] };

/** What one surface did with one typed line. Two surfaces answer differently to
 * the same edit -- Twitch renames a channel that is not streaming, YouTube has
 * nothing to rename -- so the screen reports them apart rather than averaging
 * them into one sentence. */
export type StreamOutcome = { label: string; status: "done" | "skipped" | "failed"; detail: string };

export function streamService(backendDb: BackendDb, config: BackendConfig) {
  const youtube = () => youtubeLocales(backendDb);
  const hasTwitch = () => listChannels(backendDb).some((channel) => channel.platform === "twitch");

  async function auth(fetchImpl: typeof fetch): Promise<TwitchAuth | null> {
    return hasTwitch() ? twitchAuth(config, backendDb, fetchImpl) : null;
  }

  return {
    /** Whether this Studio has anywhere to stream at all. No surfaces, no
     * screen: the menu asks this before it offers the button. */
    connected(): boolean {
      return youtube().length > 0 || hasTwitch();
    },

    async current(fetchImpl: typeof fetch = fetch): Promise<StudioStream> {
      const [broadcasts, twitch] = await Promise.all([
        youtubePlaces(config, youtube(), fetchImpl),
        twitchPlace(auth(fetchImpl), fetchImpl),
      ]);
      return { places: [...twitch, ...broadcasts] };
    },

    /**
     * Applies one typed line everywhere it belongs, and says what each place
     * did with it.
     *
     * The places are resolved again here rather than carried from the screen: a
     * YouTube edit names the broadcast id from its own read, so re-reading is
     * what keeps a stream that ended from handing its successor the title, and
     * a Twitch channel has no id to race.
     */
    async apply(field: StreamField, value: string, fetchImpl: typeof fetch = fetch): Promise<StreamOutcome[]> {
      const { places } = await this.current(fetchImpl);
      const twitch = await auth(fetchImpl);
      return Promise.all(places.map((place) => applyTo(config, place, field, value, twitch, fetchImpl)));
    },
  };
}

async function applyTo(
  config: BackendConfig,
  place: StreamPlace,
  field: StreamField,
  value: string,
  twitch: TwitchAuth | null,
  fetchImpl: typeof fetch,
): Promise<StreamOutcome> {
  const skip = (detail: string): StreamOutcome => ({ label: place.label, status: "skipped", detail });
  if (place.error) return skip(place.error);
  if (field === "description" && place.description === null) return skip("no description field");
  if (field === "chat" && !place.live) return skip("not on the air");
  if (field !== "chat" && !place.editable) return skip("nothing to edit until a stream starts");
  try {
    if (place.surface === "twitch") {
      if (!twitch) return skip("not connected");
      if (field === "chat") await sayInTwitchChat(twitch, value, fetchImpl);
      else await updateTwitchChannel(twitch, { title: value }, fetchImpl);
      return { label: place.label, status: "done", detail: "" };
    }
    const locale: VideoLocale = place.label.endsWith("EN") ? "en" : "ru";
    if (field === "chat") {
      if (!place.chatId) return skip("no chat");
      await sayInYouTubeChat(config, place.chatId, value, locale, fetchImpl);
    } else {
      const updated = await editYouTubeBroadcast(config, field === "title" ? { title: value } : { description: value }, locale, fetchImpl);
      if (!updated) return skip("the stream ended");
    }
    return { label: place.label, status: "done", detail: "" };
  } catch (error) {
    return { label: place.label, status: "failed", detail: shortReason(error) };
  }
}

async function youtubePlaces(config: BackendConfig, locales: readonly VideoLocale[], fetchImpl: typeof fetch): Promise<StreamPlace[]> {
  return Promise.all(
    locales.map(async (locale): Promise<StreamPlace> => {
      const label = `YouTube ${locale.toUpperCase()}`;
      try {
        const { chosen, broadcasts } = await youtubeBroadcastInventory(config, locale, fetchImpl);
        const live = chosen?.lifeCycleStatus === "live" || chosen?.lifeCycleStatus === "testing";
        return {
          surface: "youtube",
          label,
          title: chosen?.title ?? "",
          description: chosen?.description ?? "",
          live,
          url: chosen?.url ?? "",
          editable: chosen !== null,
          chatId: chosen?.liveChatId ?? null,
          previous: {
            title: previousValue(broadcasts, chosen, "title"),
            description: previousValue(broadcasts, chosen, "description"),
          },
          error: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // An account that never had live streaming switched on answers 403
        // forever. That is a property of the account, not a fault of this
        // request, and it has no stream -- which is what an unusable place
        // already says. Reporting it would be noise on every screen.
        if (isLiveStreamingOff(message)) return absent(label, "youtube");
        return { ...absent(label, "youtube"), error: shortReason(error) };
      }
    }),
  );
}

async function twitchPlace(pending: Promise<TwitchAuth | null>, fetchImpl: typeof fetch): Promise<StreamPlace[]> {
  const auth = await pending.catch(() => null);
  if (!auth) return [];
  try {
    const channel = await twitchChannel(auth, fetchImpl);
    return [
      {
        surface: "twitch",
        label: "Twitch",
        title: channel.title,
        // Twitch has no description on a channel, and an empty box the operator
        // can type into would silently discard what they wrote.
        description: null,
        live: channel.live,
        url: channel.url,
        // The title belongs to the channel, so it can be set with nothing on
        // the air -- and the next stream opens under it.
        editable: true,
        chatId: auth.broadcasterId,
        previous: { title: null, description: null },
        error: null,
      },
    ];
  } catch (error) {
    return [{ ...absent("Twitch", "twitch"), error: shortReason(error) }];
  }
}

function absent(label: string, surface: "youtube" | "twitch"): StreamPlace {
  return {
    surface,
    label,
    title: "",
    description: null,
    live: false,
    url: "",
    editable: false,
    chatId: null,
    previous: { title: null, description: null },
    error: null,
  };
}

/**
 * What this channel last called a stream, offered for a field the current one
 * opened empty.
 *
 * Offered, never applied: copying a description forward on its own would
 * republish the previous stream's links onto one already on the air.
 */
function previousValue(broadcasts: readonly LiveBroadcast[], chosen: LiveBroadcast | null, field: "title" | "description"): string | null {
  const finished = broadcasts
    .filter((broadcast) => broadcast.id !== chosen?.id && broadcast.endedAt !== null && broadcast[field].trim())
    .sort((left, right) => String(right.endedAt).localeCompare(String(left.endedAt)));
  return finished[0]?.[field].trim() ?? null;
}

/** The account was never switched on for live streaming. YouTube says so in a
 * machine-readable reason, which is the part worth matching; the sentence
 * beside it is prose and changes. */
function isLiveStreamingOff(message: string): boolean {
  return message.includes("liveStreamingNotEnabled");
}

/** One line an operator can act on, out of a JSON error document. Two Google
 * services and Twitch answer here: the first describes a fault under "message",
 * OAuth under "error_description", and Twitch under "message" as well. */
function shortReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const described = /"(?:message|error_description)":\s*"([^"]+)"/.exec(message)?.[1];
  const status = /failed: (\d{3})/.exec(message)?.[1];
  return described ?? (status ? `HTTP ${status}` : message.slice(0, 200));
}
