import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordOpeningFromFrame } from "../analytics/collection/video-frames.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { updateVideoScript } from "../publishing/video-service.js";

/** YouTube's own id, as it appears in a downloaded file's name. Eleven
 * characters of its alphabet, between the date and the title the downloader
 * wrote. It is what this matches on: a title is edited and re-encoded, an id
 * is the video. */
const YOUTUBE_ID = /(?:^|[_.\- ])([A-Za-z0-9_-]{11})(?:[_.\- ]|$)/u;

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
  const skipped: string[] = [];
  try {
    const untar = Bun.spawn(["tar", "-xf", input.file, "-C", unpacked], { stdout: "ignore", stderr: "pipe" });
    const [code, complaint] = await Promise.all([untar.exited, new Response(untar.stderr).text()]);
    if (code !== 0) throw new Error(`the archive could not be unpacked: ${complaint.trim().slice(0, 200)}`);
    for (const name of await readdir(unpacked, { recursive: true })) {
      const kind = name.endsWith(".jpg") ? "frame" : name.endsWith(".vtt") ? "transcript" : null;
      if (!kind) continue;
      const id = path.basename(name).match(YOUTUBE_ID)?.[1];
      const video = id ? known.get(id) : undefined;
      if (!video) {
        unmatched.push(path.basename(name));
        continue;
      }
      const ref = `video:${video.videoDraftId}`;
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
    frames: frames.length,
    transcripts: transcripts.length,
    skipped: skipped.slice(0, 10),
    skippedCount: skipped.length,
    unmatched: unmatched.slice(0, 10),
    unmatchedCount: unmatched.length,
    note: "Matched on the id YouTube gave each video, read out of the file name. A frame is stored only for a video whose opening is not measured yet, and a transcript only for one whose author never wrote a script.",
  };
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
export function spokenText(vtt: string): string {
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
