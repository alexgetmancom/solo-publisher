import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { videoDrafts } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { deepSeekChat } from "../../foundation/external/deepseek.js";
import { openingLine } from "../../publishing/video-service.js";

/** The kinds of opening this channel actually uses, read off all of its own
 * videos rather than imagined.
 *
 * Six, and closed: an open list would grow a new name for every video and end
 * up where the tags were, nine hundred words across ninety videos with nothing
 * to compare. Each has to be recognisable from ten words and has to be a
 * choice its author could make differently next time.
 *
 * Every one of these is a form -- what the opening does. The list used to
 * carry `shock` beside them, which is not a form but a volume, and a list that
 * mixes the two cannot be applied twice the same way: every premise has some
 * volume, so the choice between `shock` and anything else was settled by tone,
 * and tone is not what is being asked. It cost half the archive -- 154 of 303
 * openings sat under `announcement` with only 41 of them announcing anything.
 * If how loud a line is turns out to be worth knowing, it is a second question
 * about the same line, not a seventh name for it. */
export const HOOK_TYPES = ["premise", "release", "reaction", "callback", "address", "question"] as const;

/** How many openings go into one request. Enough that the model sees them as a
 * set and answers consistently, small enough that one bad answer costs little
 * to redo. */
const BATCH = 20;

/** An opening this short is an interjection with nothing in it to judge. The
 * posts have held this guard since they were first labelled; the videos went
 * without one and spent judgements on two words. */
const ENOUGH_WORDS = 4;

const SYSTEM_PROMPT = `You label the opening line of a short vertical gaming video, in Russian, with one of six kinds.

Every kind is a form -- what the opening does. None of them is a volume: a premise can be alarming, absurd or funny and is still a premise.

premise — it describes the situation the game puts the viewer in: what you are, what you do, what is done to you.
release — it reports the game itself: that it exists, released, updated, went free, or reached an anniversary. News about the game rather than about playing it.
reaction — it is the author's own reaction and carries no content of its own: that something was unexpected, that something was found, that this one is interesting.
callback — it refers to an earlier video, or to a game or thing the audience already knows, and hangs this one on it.
address — it asks the viewer for something they can actually do: join in, gather friends, tag someone, stop scrolling.
question — it asks the viewer something, or poses a puzzle they want resolved.

Rules:
- Answer with a JSON object mapping each id to one label. Nothing else.
- Use exactly these labels, lowercase.
- Judge only the words given. Do not infer from the game or from what you imagine follows.
- How extreme, loud or funny a line is decides nothing. Judge what the line does.
- A line that invites the viewer to picture a situation is premise: the invitation frames the situation and asks for nothing. Keep address for a line that asks for something the viewer can actually do.
- When two fit, pick the one a viewer would notice first.`;

/** One opening to judge, and every video that opens with those exact words.
 *
 * The archive says the same thing twice: twelve of its openings are written
 * word for word on two videos. Judged apart they were judged differently --
 * four of the twelve disagreed with themselves at temperature zero, because a
 * batch of twenty is the context of every answer in it and no two batches hold
 * the same twenty. One text is one judgement, and it lands on every video that
 * text belongs to. */
type Candidate = { videoDraftIds: number[]; openingLine: string };

/**
 * Fills in what kind of opening each video used.
 *
 * The field existed and stayed empty on every video for a year, because it
 * asked a person to read a hundred and seventy videos and make the same
 * judgement a hundred and seventy times. A model reading ten words makes that
 * judgement for the price of a paragraph, and the answer is a label from a
 * closed list rather than an opinion, so it can be checked by reading four of
 * them.
 */
export async function classifyHooks(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  input: { apply: boolean; limit: number; overwrite: boolean },
): Promise<Record<string, unknown>> {
  storeOpeningLines(backendDb);
  forgetRetiredKinds(backendDb);
  const candidates = loadCandidates(backendDb, input.overwrite).slice(0, input.limit);
  const videos = candidates.reduce((total, candidate) => total + candidate.videoDraftIds.length, 0);
  if (!candidates.length) return { applied: input.apply, candidates: 0, note: "Every video with an opening already carries its kind." };
  if (!input.apply)
    return {
      applied: false,
      candidates: candidates.length,
      videos,
      sample: candidates.slice(0, 5).map((c) => ({ refs: refs(c), opening: c.openingLine.slice(0, 120) })),
    };
  const labelled: Array<{ refs: string; hook: string; opening: string; videos: number }> = [];
  const refused: string[] = [];
  for (let start = 0; start < candidates.length; start += BATCH) {
    const batch = candidates.slice(start, start + BATCH);
    const asked = batch.map((c) => `${c.videoDraftIds[0]}: ${c.openingLine.slice(0, 300)}`).join("\n");
    let answer: Record<string, unknown>;
    try {
      const raw = await deepSeekChat(
        config,
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: asked },
        ],
        { temperature: 0, timeoutMs: 120_000, json: true },
        fetchImpl,
      );
      answer = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      refused.push(`${batch.length} openings: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
      continue;
    }
    for (const candidate of batch) {
      const label = String(answer[String(candidate.videoDraftIds[0])] ?? "").toLowerCase();
      if (!HOOK_TYPES.includes(label as (typeof HOOK_TYPES)[number])) {
        refused.push(`${refs(candidate)}: answered ${label || "nothing"}`);
        continue;
      }
      const now = new Date().toISOString();
      for (const videoDraftId of candidate.videoDraftIds)
        unsafeDb(backendDb).db.update(videoDrafts).set({ hook: label, updatedAt: now }).where(eq(videoDrafts.id, videoDraftId)).run();
      labelled.push({
        refs: refs(candidate),
        hook: label,
        opening: candidate.openingLine.slice(0, 90),
        videos: candidate.videoDraftIds.length,
      });
    }
  }
  const counts: Record<string, number> = {};
  for (const row of labelled) counts[row.hook] = (counts[row.hook] ?? 0) + row.videos;
  return {
    applied: true,
    labelled: labelled.reduce((total, row) => total + row.videos, 0),
    openings: labelled.length,
    byKind: counts,
    refused: refused.slice(0, 10),
    sample: labelled.slice(0, 8),
    note: "The kind is a judgement about ten words, not a measurement. Read a handful against their openings before trusting a grouping built on them.",
  };
}

/** The words each video opens with, derived from the script it has now.
 *
 * The column was added to a table whose scripts were already written, and it
 * is filled in one place -- the moment a script is saved. Every script older
 * than the column kept a null no write would ever come back for, so a video
 * with a script sat uncountable beside one with none, and nothing said which.
 * Deriving it here is what the posts already do before they are judged: the
 * opening is a function of the text and where the text came from, so it can be
 * recomputed at any time and a script that has not changed yields what it
 * yielded before. */
function storeOpeningLines(backendDb: BackendDb): void {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare("SELECT id, script, script_source AS source FROM video_drafts WHERE TRIM(COALESCE(script, '')) <> ''")
    .all() as Array<{ id: number; script: string; source: string | null }>;
  const write = unsafeDb(backendDb).sqlite.prepare("UPDATE video_drafts SET opening_line = ? WHERE id = ?");
  for (const row of rows) write.run(openingLine(row.script, row.source ?? ""), row.id);
}

/** Every opening this Studio has, beside the kind it was given.
 *
 * The kind is a model's judgement, and every note that reports one says to
 * check it by reading a few against their own words. Nothing let anyone do
 * that: the report shows six examples and the classifier prints what it just
 * wrote, so the only way to read the grouping whole was to open the database.
 * This is that read, and it is the one an argument about the five kinds has to
 * start from. */
export function listOpenings(backendDb: BackendDb): Record<string, unknown> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT id, hook, script_source AS source, opening_line AS opening
         FROM video_drafts
        WHERE TRIM(COALESCE(opening_line, '')) <> ''
        ORDER BY id DESC`,
    )
    .all() as Array<{ id: number; hook: string | null; source: string | null; opening: string }>;
  const byKind: Record<string, number> = {};
  for (const row of rows) byKind[row.hook ?? "unnamed"] = (byKind[row.hook ?? "unnamed"] ?? 0) + 1;
  return {
    videos: rows.length,
    byKind,
    openings: rows.map((row) => ({
      ref: `video:${row.id}`,
      hook: row.hook,
      // A script its author wrote gives the opening its own paragraph; a
      // transcript gives a first sentence and nothing to say where it ended.
      // Which one this is belongs beside the words when they are being judged.
      source: row.source,
      opening: row.opening,
    })),
    note: "The kind is a model's judgement about ten words. Read the words, not the label, when the grouping is what is in question.",
  };
}

function refs(candidate: Candidate): string {
  return candidate.videoDraftIds.map((id) => `video:${id}`).join(" ");
}

/** A name struck off the list stops being a kind the moment it is struck off.
 *
 * Left in place it is a grouping of its own that nothing can ever join, and
 * the two the last change retired sat on exactly the videos too short to be
 * judged again -- so the report would have shown them as buckets of one for
 * good. There is no kind here rather than a kind nobody uses. */
function forgetRetiredKinds(backendDb: BackendDb): void {
  unsafeDb(backendDb)
    .sqlite.prepare(
      `UPDATE video_drafts SET hook = NULL
        WHERE hook IS NOT NULL AND hook NOT IN (${HOOK_TYPES.map((kind) => `'${kind}'`).join(", ")})`,
    )
    .run();
}

/** A video carries a kind when it carries one of the kinds there are.
 *
 * The list is closed but not frozen -- it was five names and is six, and the
 * two it dropped are still written on videos judged under them. Read as a kind
 * they are a grouping nothing can join; read as absent they are offered again
 * without asking anyone to remember which run wrote them. `overwrite` stays
 * for re-judging a video whose label is current and wrong. */
function loadCandidates(backendDb: BackendDb, overwrite: boolean): Candidate[] {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT id AS videoDraftId, opening_line AS openingLine
         FROM video_drafts
        WHERE opening_line IS NOT NULL AND TRIM(opening_line) <> ''
          ${overwrite ? "" : `AND (hook IS NULL OR hook NOT IN (${HOOK_TYPES.map((kind) => `'${kind}'`).join(", ")}))`}
        ORDER BY id DESC`,
    )
    .all() as Array<{ videoDraftId: number; openingLine: string }>;
  const byText = new Map<string, Candidate>();
  for (const row of rows) {
    if (row.openingLine.split(/\s+/u).filter(Boolean).length < ENOUGH_WORDS) continue;
    const key = row.openingLine.trim().toLowerCase().replace(/\s+/gu, " ");
    const seen = byText.get(key);
    if (seen) seen.videoDraftIds.push(row.videoDraftId);
    else byText.set(key, { videoDraftIds: [row.videoDraftId], openingLine: row.openingLine });
  }
  return [...byText.values()];
}
