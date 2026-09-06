import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordOpeningFromFrame } from "../analytics/collection/video-frames.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoDrafts, videoTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { updateVideoScript } from "../publishing/video-service.js";

/** YouTube's own id, as it appears in a downloaded file's name. Eleven
 * characters of its alphabet, between the date and the title the downloader
 * wrote. It is what this matches on: a title is edited and re-encoded, an id
 * is the video. */
const YOUTUBE_ID = /(?:^|[_.\- ])([A-Za-z0-9_-]{11})(?:[_.\- ]|$)/u;

/** The whole name a downloader wrote: the day it went out, the id, the title.
 * It is enough to record a video this Studio never published, which is most of
 * this channel's back catalogue. */
const DOWNLOADED_AS = /^(\d{4})(\d{2})(\d{2})_([A-Za-z0-9_-]{11})_(.+?)\.(?:frame2s\.jpg|ru\.vtt|ru-orig\.vtt|mp4)$/u;

/** What marks a video as the channel's own history rather than this Studio's
 * work. Read by every report that compares videos at the same age: an imported
 * video has one reading taken years after it went out, and putting that in an
 * age bucket would answer "what does a video have at 24 hours" with a number
 * from a different question. */
export const IMPORTED_HISTORY = "youtube_history";

type Known = { videoDraftId: number; externalId: string; hasOperatorScript: boolean };

/**
 * Takes in what was captured off the published videos somewhere else.
 *
 * The archive's source files are gone from everywhere this Studio can reach:
 * retention deleted them here and Instagram stops serving a published Reel
 * about a week after it goes out. They still exist on the machine they were
 * downloaded to, and a frame cut there is the same pixels as a frame cut here.
 * This is how they get back in — one archive, matched by the id YouTube gave
 * each video, so nothing is attributed by guessing at a title.
 *
 * A script its author wrote is never replaced by a transcript, whichever
 * direction the files arrive from.
 */
export async function importVideoArchive(
  backendDb: BackendDb,
  config: BackendConfig,
  input: { apply: boolean; file: string },
): Promise<Record<string, unknown>> {
  const known = new Map<string, Known>();
  for (const row of publishedVideos(backendDb)) known.set(row.externalId, row);
  const unpacked = await mkdtemp(path.join(tmpdir(), "archive-import-"));
  const frames: string[] = [];
  const transcripts: string[] = [];
  const unmatched: string[] = [];
  const adopted: string[] = [];
  const skipped: string[] = [];
  const lengths = new Map<string, number>();
  try {
    const untar = Bun.spawn(["tar", "-xf", input.file, "-C", unpacked], { stdout: "ignore", stderr: "pipe" });
    const [code, complaint] = await Promise.all([untar.exited, new Response(untar.stderr).text()]);
    if (code !== 0) throw new Error(`the archive could not be unpacked: ${complaint.trim().slice(0, 200)}`);
    // How long each video runs, measured where the files are. It is the key
    // that tells two videos of the same day apart when the Instagram copy has
    // to be found again.
    for (const name of await readdir(unpacked, { recursive: true }))
      if (path.basename(name) === "durations.tsv")
        for (const line of (await Bun.file(path.join(unpacked, name)).text()).split("\n")) {
          const [id, seconds] = line.split("\t");
          if (id && seconds && Number.isFinite(Number(seconds))) lengths.set(id, Number(seconds));
        }
    for (const name of await readdir(unpacked, { recursive: true })) {
      // A tar made on a Mac carries a ._name sidecar for every file, holding
      // the extended attributes rather than the picture.
      if (path.basename(name).startsWith("._")) continue;
      const kind = name.endsWith(".jpg") ? "frame" : name.endsWith(".vtt") ? "transcript" : null;
      if (!kind) continue;
      const base = path.basename(name);
      const id = base.match(YOUTUBE_ID)?.[1];
      let video = id ? known.get(id) : undefined;
      if (!video) {
        // A video of this channel that this Studio never published. It is real
        // history on an account we hold the credentials for, and everything
        // that is a ratio rather than a total is as readable for it as for any
        // other video.
        const recorded = input.apply ? adopt(backendDb, base) : null;
        if (recorded) {
          known.set(recorded.externalId, recorded);
          adopted.push(`video:${recorded.videoDraftId}`);
          video = recorded;
        } else {
          unmatched.push(base);
          continue;
        }
      }
      const ref = `video:${video.videoDraftId}`;
      const seconds = id ? lengths.get(id) : undefined;
      if (input.apply && seconds)
        unsafeDb(backendDb)
          .sqlite.prepare(
            `UPDATE video_targets
                SET metadata_json = json_set(metadata_json, '$.videoDurationMs', ?)
              WHERE video_draft_id = ? AND json_extract(metadata_json, '$.videoDurationMs') IS NULL`,
          )
          .run(Math.round(seconds * 1000), video.videoDraftId);
      if (kind === "frame") {
        if (input.apply && !(await recordOpeningFromFrame(backendDb, config, video.videoDraftId, path.join(unpacked, name))))
          skipped.push(`${ref}: its opening was already measured`);
        else frames.push(ref);
        continue;
      }
      // What a machine heard is worth less than what the author wrote, and the
      // author's copy is already here for the videos that have one.
      if (video.hasOperatorScript) {
        skipped.push(`${ref}: its author's own script is already stored`);
        continue;
      }
      const heard = spokenText(await Bun.file(path.join(unpacked, name)).text());
      if (!heard) {
        skipped.push(`${ref}: the transcript had no words in it`);
        continue;
      }
      if (input.apply) updateVideoScript(backendDb, video.videoDraftId, heard, "youtube_captions");
      transcripts.push(ref);
    }
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
  return {
    applied: input.apply,
    adopted: adopted.length,
    frames: frames.length,
    transcripts: transcripts.length,
    skipped: skipped.slice(0, 10),
    skippedCount: skipped.length,
    unmatched: unmatched.slice(0, 10),
    unmatchedCount: unmatched.length,
    note: "Matched on the id YouTube gave each video, read out of the file name. A video this Studio never published is recorded as the channel's own history, carrying no age series: what it had at an hour old needed someone reading it then. A frame is stored only for a video whose opening is not measured yet, and a transcript only for one whose author never wrote a script.",
  };
}

/** Records a video of this channel that this Studio did not publish.
 *
 * Everything comes from the file's own name, because there is nowhere else
 * left to ask: the day it went out, the id YouTube gave it, and the title. The
 * day is a day and not an instant, which is why nothing reads it as one --
 * these videos are marked as history and left out of every comparison made at
 * an hour of the day or an age. */
function adopt(backendDb: BackendDb, fileName: string): Known | null {
  const parts = fileName.match(DOWNLOADED_AS);
  if (!parts) return null;
  const [, year, month, day, externalId, title] = parts as unknown as [string, string, string, string, string, string];
  const actorId = (
    unsafeDb(backendDb).sqlite.prepare("SELECT actor_id AS actorId FROM video_drafts ORDER BY id LIMIT 1").get() as
      | { actorId: number }
      | undefined
  )?.actorId;
  if (actorId === undefined) return null;
  const publishedAt = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).toISOString();
  const now = new Date().toISOString();
  const draftId = unsafeDb(backendDb)
    .db.insert(videoDrafts)
    .values({
      actorId,
      locale: "ru",
      label: title.replace(/\uFF5C/gu, "|").trim(),
      // It was published before this Studio and its source was never here.
      studioMediaAssetId: null,
      status: "published",
      sourcePrunedAt: now,
      createdAt: publishedAt,
      updatedAt: now,
    })
    .returning({ id: videoDrafts.id })
    .get().id;
  unsafeDb(backendDb)
    .db.insert(videoTargets)
    .values({
      videoDraftId: draftId,
      target: "youtube_shorts",
      metadataJson: { title },
      status: "published",
      externalId,
      externalUrl: `https://www.youtube.com/watch?v=${externalId}`,
      publishedAt,
      confirmationSource: IMPORTED_HISTORY,
      createdAt: publishedAt,
      updatedAt: now,
    })
    .run();
  return { videoDraftId: draftId, externalId, hasOperatorScript: false };
}

/** Published videos this Studio can be handed files for. */
function publishedVideos(backendDb: BackendDb): Known[] {
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT d.id AS videoDraftId, t.external_id AS externalId,
              (d.script IS NOT NULL AND d.script_source = 'operator') AS hasOperatorScript
         FROM video_drafts d
         JOIN video_targets t ON t.video_draft_id = d.id AND t.target = 'youtube_shorts' AND t.external_id IS NOT NULL`,
    )
    .all() as Known[];
}

/** What was said, out of a caption file that also carries when it was said.
 *
 * WebVTT repeats each line as it builds up word by word, and marks up every
 * word with the moment it lands. Both are dropped: the words are what is
 * being stored, and a line that is a prefix of the previous one is the same
 * words arriving again. */
function spokenText(vtt: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of vtt.split("\n")) {
    if (raw.includes("-->") || /^(WEBVTT|Kind:|Language:|NOTE)/u.test(raw) || !raw.trim()) continue;
    const line = raw.replace(/<[^>]*>/gu, "").trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join(" ").replace(/\s+/gu, " ").trim();
}
