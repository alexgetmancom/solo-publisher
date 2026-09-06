import { and, eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoDrafts, videoTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { youtubeAccessToken } from "../foundation/external/youtube.js";
import { requestJson } from "../foundation/http.js";

/** What marks a video as the channel's own history rather than this Studio's
 * work. It is on the target because that is what was published, and it is read
 * by every report that compares videos at the same age: an imported video has
 * one reading taken years after it went out, and putting that in an age bucket
 * would answer "what does a video have at 24 hours" with a number from a
 * different question. */
export const IMPORTED_HISTORY = "youtube_history";

/** The channel's uploads, one page at a time. Fifty is the API's maximum and
 * one quota unit either way. */
const PAGE_SIZE = 50;

type ChannelAnswer = { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> };
type PlaylistAnswer = {
  nextPageToken?: string;
  items?: Array<{ snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } } }>;
};

/**
 * Takes in the videos this channel published before this Studio existed.
 *
 * They are real publications on an account we hold the credentials for, and
 * everything that answers the one question worth asking — what an opening does
 * to the first seconds — is still readable for them: the frame from a copy of
 * the file, the words from the caption track, the retention curve from the
 * Analytics API, which keeps years of history.
 *
 * What cannot be recovered is what they had at one hour old, or at a day: that
 * needed someone watching at the time. So an imported video carries no age
 * series and is marked, and the reports that compare videos at the same age
 * leave it out rather than answer with a number that means something else.
 */
export async function importYouTubeHistory(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  input: { apply: boolean; limit: number },
): Promise<Record<string, unknown>> {
  const token = await youtubeAccessToken(config, fetchImpl, "ru");
  const channel = await requestJson<ChannelAnswer>(
    fetchImpl,
    "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error("This channel does not say where its uploads are; the credential may not be the channel owner's.");

  const known = new Set(
    (
      unsafeDb(backendDb)
        .sqlite.prepare("SELECT external_id AS externalId FROM video_targets WHERE external_id IS NOT NULL")
        .all() as Array<{ externalId: string }>
    ).map((row) => row.externalId),
  );
  const actorId = onlyActor(backendDb);
  const found: Array<{ externalId: string; title: string; publishedAt: string }> = [];
  let page: string | undefined;
  do {
    const answer = await requestJson<PlaylistAnswer>(
      fetchImpl,
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploads}&maxResults=${PAGE_SIZE}${page ? `&pageToken=${page}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    for (const item of answer.items ?? []) {
      const externalId = item.snippet?.resourceId?.videoId;
      const publishedAt = item.snippet?.publishedAt;
      if (!externalId || !publishedAt || known.has(externalId)) continue;
      found.push({ externalId, title: item.snippet?.title ?? "", publishedAt });
    }
    page = answer.nextPageToken;
  } while (page && found.length < input.limit);

  const importing = found.slice(0, input.limit);
  if (!input.apply)
    return {
      applied: false,
      onTheChannel: known.size + found.length,
      missing: found.length,
      wouldImport: importing.length,
      sample: importing.slice(0, 5).map((video) => ({ title: video.title.slice(0, 70), publishedAt: video.publishedAt })),
    };

  const now = new Date().toISOString();
  const imported: string[] = [];
  for (const video of importing) {
    const draftId = unsafeDb(backendDb)
      .db.insert(videoDrafts)
      .values({
        actorId,
        locale: "ru",
        label: video.title,
        // No file: it was published before this Studio and its source was
        // never here. Marked pruned so nothing goes looking for one.
        studioMediaAssetId: null,
        status: "published",
        sourcePrunedAt: now,
        createdAt: video.publishedAt,
        updatedAt: now,
      })
      .returning({ id: videoDrafts.id })
      .get().id;
    unsafeDb(backendDb)
      .db.insert(videoTargets)
      .values({
        videoDraftId: draftId,
        target: "youtube_shorts",
        metadataJson: { title: video.title },
        status: "published",
        externalId: video.externalId,
        externalUrl: `https://www.youtube.com/watch?v=${video.externalId}`,
        publishedAt: video.publishedAt,
        confirmationSource: IMPORTED_HISTORY,
        createdAt: video.publishedAt,
        updatedAt: now,
      })
      .run();
    imported.push(`video:${draftId}`);
  }
  return {
    applied: true,
    imported: imported.length,
    refs: imported.slice(0, 10),
    note: "Imported videos carry no age series: what they had at one hour old needed someone watching at the time. Their retention, opening and text are as good as any other video's — `youtube-analytics-backfill` reads the first, `archive-import` the other two.",
  };
}

/** The Studio has one operator, and an imported video belongs to whoever the
 * published ones belong to. */
function onlyActor(backendDb: BackendDb): number {
  const row = unsafeDb(backendDb)
    .db.select({ actorId: videoDrafts.actorId })
    .from(videoDrafts)
    .where(and(eq(videoDrafts.status, "published")))
    .limit(1)
    .get();
  if (!row) throw new Error("This Studio has published no videos of its own, so there is nobody to attribute the channel's history to.");
  return row.actorId;
}
