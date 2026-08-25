import type { TwitchAuth } from "../channels/twitch-oauth.js";
import { requestJson } from "../foundation/http.js";

const HELIX = "https://api.twitch.tv/helix";
/** Twitch counts a stream title in characters and stops at 140. YouTube stops
 * at 100, and a bot that sends one line to both must respect the smaller. */
export const TWITCH_TITLE_LIMIT = 140;
/** A chat line. Twitch truncates past this rather than refusing, which is worse
 * than being told. */
export const TWITCH_CHAT_LIMIT = 500;

/** What the channel currently says it is, live or not. Unlike YouTube, this
 * exists between streams: the title is a property of the channel, so it can be
 * read and set with nothing on the air. */
export type TwitchChannel = {
  title: string;
  gameId: string;
  gameName: string;
  /** Whether an audience is watching this right now, which decides whether a
   * title change is cosmetic or is read by people mid-sentence. */
  live: boolean;
  url: string;
};

type ChannelResponse = { data?: Array<{ title?: string; game_id?: string; game_name?: string; broadcaster_login?: string }> };
type StreamResponse = { data?: Array<{ id?: string }> };

function headers(auth: TwitchAuth): Record<string, string> {
  return { Authorization: `Bearer ${auth.token}`, "Client-Id": auth.clientId };
}

export async function twitchChannel(auth: TwitchAuth, fetchImpl: typeof fetch = fetch): Promise<TwitchChannel> {
  const query = `broadcaster_id=${encodeURIComponent(auth.broadcasterId)}`;
  const [channel, stream] = await Promise.all([
    requestJson<ChannelResponse>(fetchImpl, `${HELIX}/channels?${query}`, { headers: headers(auth) }),
    requestJson<StreamResponse>(fetchImpl, `${HELIX}/streams?user_id=${encodeURIComponent(auth.broadcasterId)}`, {
      headers: headers(auth),
    }),
  ]);
  const current = channel.data?.[0];
  if (!current) throw new Error("Twitch returned no channel for this account");
  return {
    title: current.title ?? "",
    gameId: current.game_id ?? "",
    gameName: current.game_name ?? "",
    live: Boolean(stream.data?.length),
    url: `https://twitch.tv/${current.broadcaster_login ?? ""}`,
  };
}

/**
 * Changes what the channel says it is.
 *
 * `PATCH /helix/channels` only touches the fields the request names, so unlike
 * YouTube's broadcast update there is nothing to read back and resend. The
 * title reaches viewers immediately and survives the stream ending, which is
 * the difference an operator feels: set it once and the next stream opens
 * under it.
 */
export async function updateTwitchChannel(
  auth: TwitchAuth,
  change: { title?: string; gameId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const title = change.title?.trim();
  if (title !== undefined && !title) throw new Error("A stream title cannot be empty.");
  if (title !== undefined && title.length > TWITCH_TITLE_LIMIT)
    throw new Error(`Twitch allows ${TWITCH_TITLE_LIMIT} characters in a title; this one has ${title.length}.`);
  const body = { ...(title === undefined ? {} : { title }), ...(change.gameId === undefined ? {} : { game_id: change.gameId }) };
  if (!Object.keys(body).length) throw new Error("Nothing to change: name a title or a game.");
  await requestJson(fetchImpl, `${HELIX}/channels?broadcaster_id=${encodeURIComponent(auth.broadcasterId)}`, {
    method: "PATCH",
    headers: { ...headers(auth), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Says one thing in the channel's chat, as the broadcaster.
 *
 * Never retried on its own: Twitch gives a chat message no deduplication key,
 * and a line that arrived twice is two lines an audience reads. A failure is
 * reported to the operator, who can see the chat and decide.
 */
export async function sayInTwitchChat(auth: TwitchAuth, message: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const text = message.trim();
  if (!text) throw new Error("A chat message cannot be empty.");
  if (text.length > TWITCH_CHAT_LIMIT)
    throw new Error(`Twitch allows ${TWITCH_CHAT_LIMIT} characters in a chat message; this one has ${text.length}.`);
  await requestJson(fetchImpl, `${HELIX}/chat/messages`, {
    method: "POST",
    headers: { ...headers(auth), "Content-Type": "application/json" },
    // Broadcaster and sender are the same account: the bot speaks as the
    // channel, which is also why no `channel:bot` grant is involved.
    body: JSON.stringify({ broadcaster_id: auth.broadcasterId, sender_id: auth.broadcasterId, message: text }),
  });
}
