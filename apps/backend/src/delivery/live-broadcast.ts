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

type BroadcastList = {
  items?: Array<{
    id?: string;
    snippet?: { title?: string; description?: string; scheduledStartTime?: string; isDefaultBroadcast?: boolean };
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
            url: `https://www.youtube.com/watch?v=${item.id}`,
          },
        ]
      : [],
  );
}

/**
 * The broadcast a title change belongs on.
 *
 * A stream on the air wins: that title is what an audience is reading right
 * now. Otherwise the persistent broadcast, whose title is what the next stream
 * will open under. A one-off scheduled event is the last resort, and only the
 * soonest one — renaming an event further out would retitle a stream nobody
 * asked about.
 */
function chooseBroadcast(broadcasts: LiveBroadcast[]): LiveBroadcast | null {
  const live = broadcasts.filter((broadcast) => broadcast.lifeCycleStatus === "live" || broadcast.lifeCycleStatus === "testing");
  if (live.length > 0) return live[0] as LiveBroadcast;
  const persistent = broadcasts.find((broadcast) => broadcast.isDefault && broadcast.lifeCycleStatus !== "complete");
  if (persistent) return persistent;
  const upcoming = broadcasts
    .filter(
      (broadcast) =>
        broadcast.scheduledStartTime !== null && broadcast.lifeCycleStatus !== "complete" && broadcast.lifeCycleStatus !== "revoked",
    )
    .sort((left, right) => (left.scheduledStartTime as string).localeCompare(right.scheduledStartTime as string));
  return upcoming[0] ?? null;
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

/**
 * Renames the broadcast a title change belongs on, in place.
 *
 * `liveBroadcasts.update` clears every snippet field the request omits, so the
 * description and the scheduled start are read back and resent verbatim — and
 * the write names the broadcast id that read returned, never a second lookup,
 * so a stream that ends mid-command fails instead of retitling its successor.
 */
export async function retitleYouTubeBroadcast(
  config: BackendConfig,
  title: string,
  locale: VideoLocale = "ru",
  fetchImpl: typeof fetch = fetch,
): Promise<LiveBroadcast | null> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("A live title cannot be empty.");
  if (trimmed.length > LIVE_TITLE_LIMIT)
    throw new Error(`YouTube allows ${LIVE_TITLE_LIMIT} characters in a live title; this one has ${trimmed.length}.`);
  const token = await youtubeAccessToken(config, fetchImpl, locale);
  const current = (await inventory(token, fetchImpl)).chosen;
  if (!current) return null;
  await requestJson(fetchImpl, "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      id: current.id,
      snippet: {
        title: trimmed,
        description: current.description,
        ...(current.scheduledStartTime ? { scheduledStartTime: current.scheduledStartTime } : {}),
      },
    }),
  });
  return { ...current, title: trimmed };
}
