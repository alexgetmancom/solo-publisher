import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { videoDrafts } from "../../db/schema.js";
import { deepSeekChat } from "../../foundation/external/deepseek.js";
import type { BackendConfig } from "../../foundation/config.js";

/** The kinds of opening this channel actually uses.
 *
 * Five, and closed: an open list would grow a new name for every video and
 * end up where the tags were, nine hundred words across ninety videos with
 * nothing to compare. Each of these has to be recognisable from ten words and
 * has to be a choice its author could make differently next time. */
export const HOOK_TYPES = ["question", "shock", "address", "announcement", "callback"] as const;

/** How many openings go into one request. Enough that the model sees them as a
 * set and answers consistently, small enough that one bad answer costs little
 * to redo. */
const BATCH = 20;

const SYSTEM_PROMPT = `You label the opening line of a short vertical gaming video, in Russian, with one of five kinds.

question — it asks the viewer something, or poses a puzzle they want resolved.
shock — it states something extreme, alarming or absurd as fact: a threat, a loss, a claim that sounds impossible.
address — it speaks to the viewer directly and asks them to do something or join in.
announcement — it reports that a game exists, released, or updated. Neutral news.
callback — it refers to a previous video, a game the audience already knows, or a shared memory.

Rules:
- Answer with a JSON object mapping each id to one label. Nothing else.
- Use exactly these labels, lowercase.
- Judge only the words given. Do not infer from the game or from what you imagine follows.
- When two fit, pick the one a viewer would notice first.`;

type Candidate = { videoDraftId: number; openingLine: string };

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
  const candidates = loadCandidates(backendDb, input.overwrite).slice(0, input.limit);
  if (!candidates.length) return { applied: input.apply, candidates: 0, note: "Every video with an opening already carries its kind." };
  if (!input.apply)
    return {
      applied: false,
      candidates: candidates.length,
      sample: candidates.slice(0, 5).map((c) => ({ ref: `video:${c.videoDraftId}`, opening: c.openingLine.slice(0, 120) })),
    };
  const labelled: Array<{ ref: string; hook: string; opening: string }> = [];
  const refused: string[] = [];
  for (let start = 0; start < candidates.length; start += BATCH) {
    const batch = candidates.slice(start, start + BATCH);
    const asked = batch.map((c) => `${c.videoDraftId}: ${c.openingLine.slice(0, 300)}`).join("\n");
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
      const label = String(answer[String(candidate.videoDraftId)] ?? "").toLowerCase();
      if (!HOOK_TYPES.includes(label as (typeof HOOK_TYPES)[number])) {
        refused.push(`video:${candidate.videoDraftId}: answered ${label || "nothing"}`);
        continue;
      }
      unsafeDb(backendDb)
        .db.update(videoDrafts)
        .set({ hook: label, updatedAt: new Date().toISOString() })
        .where(eq(videoDrafts.id, candidate.videoDraftId))
        .run();
      labelled.push({ ref: `video:${candidate.videoDraftId}`, hook: label, opening: candidate.openingLine.slice(0, 90) });
    }
  }
  const counts: Record<string, number> = {};
  for (const row of labelled) counts[row.hook] = (counts[row.hook] ?? 0) + 1;
  return {
    applied: true,
    labelled: labelled.length,
    byKind: counts,
    refused: refused.slice(0, 10),
    sample: labelled.slice(0, 8),
    note: "The kind is a judgement about ten words, not a measurement. Read a handful against their openings before trusting a grouping built on them.",
  };
}

function loadCandidates(backendDb: BackendDb, overwrite: boolean): Candidate[] {
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT id AS videoDraftId, opening_line AS openingLine
         FROM video_drafts
        WHERE opening_line IS NOT NULL AND TRIM(opening_line) <> ''
          ${overwrite ? "" : "AND hook IS NULL"}
        ORDER BY id DESC`,
    )
    .all() as Candidate[];
}
