import { updateVideoScript } from "../publishing/video-service.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { youtubeAccessToken } from "../foundation/external/youtube.js";
import { requestJson, shortenRequestFailure } from "../foundation/http.js";

type CaptionList = {
  items?: Array<{ id?: string; snippet?: { language?: string; trackKind?: string; name?: string; isAutoSynced?: boolean } }>;
};

type Candidate = { videoDraftId: number; externalId: string; locale: "ru" | "en"; label: string | null; script: string | null };

/**
 * Reads what was actually said in videos already published, from YouTube's own
 * caption tracks.
 *
 * The scripts for old videos are gone from the machine they were written on,
 * and the videos cannot be downloaded through the Data API. Captions can --
 * when YouTube agrees to hand them over: a track it generated itself belongs
 * to it rather than to the channel, and it answers a download for one with 403
 * as often as not. That is what this command finds out, per video, and it
 * stores what it gets marked as a transcript rather than as a script: one is
 * what was planned, the other is what a machine heard.
 */
/** How long after publishing YouTube has finished listening to a video. It
 * generates the track itself, some hours in, and asking earlier gets an empty
 * list that costs the same quota as a real answer. */
const HEARD_AFTER_HOURS = 24;

/** How far back the automatic pass looks. Beyond this is the archive, which is
 * a different job with a different budget: a hundred and forty videos at two
 * hundred and fifty quota units each cannot ride along behind every metrics
 * cycle without starving the collection it shares that budget with. */
const KEEPING_UP_DAYS = 14;

/**
 * Reads the captions of videos published recently enough that YouTube has
 * finished generating them and not so long ago that this is history.
 *
 * Runs behind the metrics cycle, because a text nobody remembers to fetch is
 * how the archive came to be a hundred and forty videos with nothing to say.
 */
export async function collectNewCaptions(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  return read(backendDb, config, fetchImpl, { apply: true, limit: 5, refresh: false, sinceDays: KEEPING_UP_DAYS });
}

export async function backfillYouTubeCaptions(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  input: { apply: boolean; limit: number; refresh: boolean },
): Promise<Record<string, unknown>> {
  return read(backendDb, config, fetchImpl, { ...input, sinceDays: null });
}

async function read(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  input: { apply: boolean; limit: number; refresh: boolean; sinceDays: number | null },
): Promise<Record<string, unknown>> {
  const candidates = loadCandidates(backendDb, input.refresh, input.sinceDays).slice(0, input.limit);
  const tokens = new Map<string, string>();
  const results: Array<Record<string, unknown>> = [];
  let stored = 0;
  let exhausted = false;
  for (const candidate of candidates) {
    try {
      let token = tokens.get(candidate.locale);
      if (!token) {
        token = await youtubeAccessToken(config, fetchImpl, candidate.locale);
        tokens.set(candidate.locale, token);
      }
      const list = await requestJson<CaptionList>(
        fetchImpl,
        `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${encodeURIComponent(candidate.externalId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const tracks = (list.items ?? []).map((item) => ({
        id: item.id ?? "",
        language: item.snippet?.language ?? "",
        trackKind: item.snippet?.trackKind ?? "standard",
      }));
      // A track someone uploaded is both better text and more likely to be
      // handed over than the one YouTube generated.
      const chosen = tracks.find((track) => track.trackKind !== "ASR") ?? tracks[0];
      if (!chosen?.id) {
        results.push({ ref: `video:${candidate.videoDraftId}`, tracks: tracks.length, outcome: "no caption track" });
        continue;
      }
      if (!input.apply) {
        results.push({ ref: `video:${candidate.videoDraftId}`, tracks, wouldDownload: chosen.trackKind });
        continue;
      }
      const response = await fetchImpl(`https://www.googleapis.com/youtube/v3/captions/${chosen.id}?tfmt=srt`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        results.push({
          ref: `video:${candidate.videoDraftId}`,
          trackKind: chosen.trackKind,
          outcome: `download refused: ${response.status}`,
          hint:
            response.status === 403 && chosen.trackKind === "ASR"
              ? "YouTube owns the tracks it generated and does not hand them to the API; only uploaded captions can be read this way"
              : undefined,
        });
        continue;
      }
      const text = plainText(await response.text());
      if (!text) {
        results.push({ ref: `video:${candidate.videoDraftId}`, outcome: "the track was empty" });
        continue;
      }
      updateVideoScript(backendDb, candidate.videoDraftId, text, "youtube_captions");
      stored += 1;
      results.push({ ref: `video:${candidate.videoDraftId}`, trackKind: chosen.trackKind, characters: text.length, outcome: "stored" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ ref: `video:${candidate.videoDraftId}`, outcome: shortenRequestFailure(message, 240) });
      // The daily quota is the channel's, not this run's: every further video
      // would fail the same way and the answer would be a page of one error.
      if (message.includes("quotaExceeded")) {
        exhausted = true;
        break;
      }
    }
  }
  return {
    applied: input.apply,
    candidates: candidates.length,
    stored,
    ...(exhausted ? { stoppedAt: "YouTube's daily quota for this channel is spent; the rest waits for it to reset" } : {}),
    results,
    note: "Stored text is marked `youtube_captions`: it is what was heard, not what was written. A video whose script came from its author is never overwritten.",
  };
}

/** Published YouTube videos whose script is missing, and with `refresh` the
 * ones carrying machine text this command did not put there.
 *
 * A script its author wrote is never a candidate: it is the words that were
 * chosen, and a transcript of what was said is a worse copy of it. Text this
 * command already stored is not one either — re-reading it costs the same API
 * quota as a video that has nothing. */
function loadCandidates(backendDb: BackendDb, refresh: boolean, sinceDays: number | null): Candidate[] {
  return (
    unsafeDb(backendDb)
      .sqlite.prepare(
        `SELECT d.id AS videoDraftId, d.label AS label, d.locale AS locale, d.script AS script, t.external_id AS externalId
         FROM video_drafts d
         JOIN video_targets t ON t.video_draft_id = d.id AND t.target = 'youtube_shorts' AND t.status = 'published'
        WHERE t.external_id IS NOT NULL
          AND t.published_at <= datetime('now', '-${HEARD_AFTER_HOURS} hours')
          ${sinceDays ? `AND t.published_at >= datetime('now', '-${sinceDays} days')` : ""}
          AND (d.script IS NULL ${refresh ? "OR d.script_source NOT IN ('operator', 'youtube_captions')" : ""})
        ORDER BY d.id DESC`,
      )
      .all() as Candidate[]
  ).map((candidate) => {
    return { ...candidate, locale: candidate.locale === "en" ? ("en" as const) : ("ru" as const) };
  });
}

/** SubRip is a caption format: indices, timestamps and text. Only the text is
 * a transcript, and a line repeated across two cues is one sentence. */
function plainText(srt: string): string {
  const lines = srt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !/^\d+$/u.test(line) && !/-->/u.test(line));
  return lines
    .filter((line, index) => line !== lines[index - 1])
    .join(" ")
    .trim();
}
