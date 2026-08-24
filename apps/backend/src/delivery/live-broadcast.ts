import type { BackendConfig } from "../foundation/config.js";
import { type VideoLocale, youtubeAccessToken } from "../foundation/external/youtube.js";
import { requestJson } from "../foundation/http.js";

/** What YouTube calls a broadcast's lifecycle once it is worth showing an
 * operator: a stream that is on the air, or the next one that is not yet. */
type BroadcastStatus = "active" | "upcoming";

export type LiveBroadcast = {
  id: string;
  status: BroadcastStatus;
  title: string;
  description: string;
  /** YouTube rejects a snippet update that does not carry this back, so it is
   * read even though nothing here displays it. */
  scheduledStartTime: string | null;
  url: string;
};

/** A live title is the video's title: the same 100 characters, counted the same
 * way. Rejecting here beats a 400 the operator has to translate. */
export const LIVE_TITLE_LIMIT = 100;

type BroadcastList = {
  items?: Array<{
    id?: string;
    snippet?: { title?: string; description?: string; scheduledStartTime?: string };
  }>;
};

async function listBroadcasts(token: string, status: BroadcastStatus, fetchImpl: typeof fetch): Promise<LiveBroadcast | null> {
  // `broadcastStatus` already scopes the list to the authorized channel, and
  // passing `mine` alongside it is an incompatible-filter error rather than a
  // narrower query.
  const response = await requestJson<BroadcastList>(
    fetchImpl,
    `https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id,snippet&broadcastType=all&broadcastStatus=${status}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const item = response.items?.[0];
  if (!item?.id) return null;
  return {
    id: item.id,
    status,
    title: item.snippet?.title ?? "",
    description: item.snippet?.description ?? "",
    scheduledStartTime: item.snippet?.scheduledStartTime ?? null,
    url: `https://www.youtube.com/watch?v=${item.id}`,
  };
}

/**
 * The broadcast a title change would land on: the one on the air, or else the
 * next scheduled one. A channel that is neither streaming nor scheduled has
 * nothing to retitle and says so with `null`.
 */
export async function currentYouTubeBroadcast(
  config: BackendConfig,
  locale: VideoLocale = "ru",
  fetchImpl: typeof fetch = fetch,
): Promise<LiveBroadcast | null> {
  return resolveBroadcast(await youtubeAccessToken(config, fetchImpl, locale), fetchImpl);
}

async function resolveBroadcast(token: string, fetchImpl: typeof fetch): Promise<LiveBroadcast | null> {
  return (await listBroadcasts(token, "active", fetchImpl)) ?? (await listBroadcasts(token, "upcoming", fetchImpl));
}

/**
 * Renames the live broadcast, in place, while it is on the air.
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
  const current = await resolveBroadcast(token, fetchImpl);
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
