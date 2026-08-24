import type { BackendConfig } from "../foundation/config.js";
import { type VideoLocale, youtubeAccessToken } from "../foundation/external/youtube.js";
import { requestJson } from "../foundation/http.js";

/** YouTube's own lifecycle vocabulary, kept verbatim: an operator comparing this
 * against YouTube Studio should not have to translate a renaming of it. */
type LifeCycleStatus = "created" | "ready" | "testing" | "live" | "complete" | "revoked";

export type LiveBroadcast = {
  id: string;
  lifeCycleStatus: LifeCycleStatus;
  /** The persistent broadcast behind the reusable stream key — the one whose
   * title carries from one stream to the next, the way a Twitch title does.
   * A channel has at most one. */
  isDefault: boolean;
  title: string;
  description: string;
  /** YouTube rejects a snippet update that does not carry this back, so it is
   * read even though nothing here displays it. */
  scheduledStartTime: string | null;
  /** The chat attached to this broadcast, which exists only while it is on the
   * air and only when the channel left chat enabled. No id, no chat. */
  liveChatId: string | null;
  url: string;
};

/** What a title change would land on, and everything it was chosen from: which
 * broadcast a channel is renaming is exactly the thing that is invisible from
 * outside, and it decides whether the change shows up on air or on the next
 * stream. */
export type LiveBroadcastInventory = {
  chosen: LiveBroadcast | null;
  broadcasts: LiveBroadcast[];
};

/** A live title is the video's title: the same 100 characters, counted the same
 * way. Rejecting here beats a 400 the operator has to translate. */
export const LIVE_TITLE_LIMIT = 100;
/** And a live description is the video's description. */
export const LIVE_DESCRIPTION_LIMIT = 5000;

type BroadcastList = {
  items?: Array<{
    id?: string;
    snippet?: { title?: string; description?: string; scheduledStartTime?: string; isDefaultBroadcast?: boolean; liveChatId?: string };
    status?: { lifeCycleStatus?: LifeCycleStatus };
  }>;
};

/**
 * Every broadcast the channel still holds, live or not.
 *
 * `broadcastStatus=active` answers only for a stream already on the air, which
 * left a channel that streams through a reusable key looking empty whenever it
 * was between streams — its persistent broadcast is `ready`, not `active`.
 * `mine` is not passed alongside: exactly one filter is allowed.
 */
async function listBroadcasts(token: string, fetchImpl: typeof fetch): Promise<LiveBroadcast[]> {
  const response = await requestJson<BroadcastList>(
    fetchImpl,
    "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id,snippet,status&broadcastType=all&broadcastStatus=all&maxResults=50",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return (response.items ?? []).flatMap((item) =>
    item.id
      ? [
          {
            id: item.id,
            lifeCycleStatus: item.status?.lifeCycleStatus ?? "created",
            isDefault: item.snippet?.isDefaultBroadcast === true,
            title: item.snippet?.title ?? "",
            description: item.snippet?.description ?? "",
            scheduledStartTime: item.snippet?.scheduledStartTime ?? null,
            liveChatId: item.snippet?.liveChatId ?? null,
            url: `https://www.youtube.com/watch?v=${item.id}`,
          },
        ]
      : [],
  );
}

/** A stream that has ended is beyond an edit anyone would see, and a revoked
 * one is beyond editing at all. */
const EDITABLE = new Set<LifeCycleStatus>(["created", "ready", "testing", "live"]);

/**
 * The broadcast an edit belongs on.
 *
 * A stream on the air wins: its title is what an audience is reading right
 * now. Everything else has not started, and the soonest of those is the one
 * being set up — the broadcast this channel opened moments ago and is about to
 * go live with, ahead of an event scheduled for next week.
 *
 * A broadcast waiting on its first byte is `ready` and carries no scheduled
 * start at all, which is exactly what an operator naming a stream just before
 * going live is looking at. Ordering by start time alone left it unreachable,
 * so the stream could not be named until it was already on the air.
 */
function chooseBroadcast(broadcasts: LiveBroadcast[]): LiveBroadcast | null {
  const candidates = broadcasts.filter((broadcast) => EDITABLE.has(broadcast.lifeCycleStatus));
  const onAir = candidates.find((broadcast) => broadcast.lifeCycleStatus === "live" || broadcast.lifeCycleStatus === "testing");
  return onAir ?? candidates.sort((left, right) => startOrder(left).localeCompare(startOrder(right)))[0] ?? null;
}

/** Sorts an unscheduled broadcast ahead of every scheduled one: it carries no
 * start time because it is waiting on the encoder, not because it is far off. */
function startOrder(broadcast: LiveBroadcast): string {
  return broadcast.scheduledStartTime ?? "";
}

export async function youtubeBroadcastInventory(
  config: BackendConfig,
  locale: VideoLocale = "ru",
  fetchImpl: typeof fetch = fetch,
): Promise<LiveBroadcastInventory> {
  return inventory(await youtubeAccessToken(config, fetchImpl, locale), fetchImpl);
}

async function inventory(token: string, fetchImpl: typeof fetch): Promise<LiveBroadcastInventory> {
  const broadcasts = await listBroadcasts(token, fetchImpl);
  return { chosen: chooseBroadcast(broadcasts), broadcasts };
}

/** What an operator can change about a stream from the bot. Both fields travel
 * in one snippet, so both are one request; naming them separately here is only
 * so that changing one never has to restate the other. */
export type BroadcastEdit = { title?: string; description?: string };

/**
 * Edits the broadcast a change belongs on, in place.
 *
 * `liveBroadcasts.update` clears every snippet field the request omits, so the
 * field that is not being changed is read back and resent verbatim — and the
 * write names the broadcast id that read returned, never a second lookup, so a
 * stream that ends mid-command fails instead of editing its successor.
 */
export async function editYouTubeBroadcast(
  config: BackendConfig,
  edit: BroadcastEdit,
  locale: VideoLocale = "ru",
  fetchImpl: typeof fetch = fetch,
): Promise<LiveBroadcast | null> {
  const title = edit.title?.trim();
  const description = edit.description?.trim();
  if (title === undefined && description === undefined) throw new Error("Nothing to change: name a title or a description.");
  if (title !== undefined && !title) throw new Error("A live title cannot be empty.");
  if (title !== undefined && title.length > LIVE_TITLE_LIMIT)
    throw new Error(`YouTube allows ${LIVE_TITLE_LIMIT} characters in a live title; this one has ${title.length}.`);
  if (description !== undefined && description.length > LIVE_DESCRIPTION_LIMIT)
    throw new Error(`YouTube allows ${LIVE_DESCRIPTION_LIMIT} characters in a live description; this one has ${description.length}.`);
  const token = await youtubeAccessToken(config, fetchImpl, locale);
  const current = (await inventory(token, fetchImpl)).chosen;
  if (!current) return null;
  const next = { ...current, ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }) };
  await requestJson(fetchImpl, "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      id: current.id,
      snippet: {
        title: next.title,
        description: next.description,
        ...(current.scheduledStartTime ? { scheduledStartTime: current.scheduledStartTime } : {}),
      },
    }),
  });
  return next;
}

/** A chat message is one line, and YouTube counts it in characters. */
export const LIVE_CHAT_LIMIT = 200;

/**
 * Says one thing in the stream's chat, as the channel.
 *
 * There is no idempotency to have here: YouTube gives a chat insert no
 * deduplication key, and a message that arrived twice is two messages an
 * audience reads. So this is never retried automatically -- a failure is
 * reported to the operator, who can see the chat and decide, which a retry loop
 * cannot.
 */
export async function sayInYouTubeChat(
  config: BackendConfig,
  liveChatId: string,
  message: string,
  locale: VideoLocale = "ru",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const text = message.trim();
  if (!text) throw new Error("A chat message cannot be empty.");
  if (text.length > LIVE_CHAT_LIMIT)
    throw new Error(`YouTube allows ${LIVE_CHAT_LIMIT} characters in a chat message; this one has ${text.length}.`);
  const token = await youtubeAccessToken(config, fetchImpl, locale);
  await requestJson(fetchImpl, "https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      snippet: { liveChatId, type: "textMessageEvent", textMessageDetails: { messageText: text } },
    }),
  });
}
