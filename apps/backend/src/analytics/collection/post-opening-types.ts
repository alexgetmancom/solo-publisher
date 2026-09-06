import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { xActivityItems } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { deepSeekChat } from "../../foundation/external/deepseek.js";

/** The kinds of opening this account actually writes, read off its own posts
 * rather than imagined: an announcement of fact, something someone said that
 * may not be true, a figure, an opinion, a question, and the author's own
 * story. Six, and closed — an open list grows a name per post and ends up
 * where the hashtags were, nine hundred words across ninety posts. */
const OPENING_KINDS = ["news", "rumour", "numbers", "take", "question", "personal"] as const;

/** How many openings go into one request. */
const BATCH = 25;

/** A post whose opening is this short is a link, an emoji or an @-mention, and
 * there is no line there to judge. */
const ENOUGH_WORDS = 4;

const SYSTEM_PROMPT = `You label the opening line of a short social post about AI with one of six kinds.

news — it states as fact that something shipped, released, changed or exists.
rumour — it reports what someone said, leaked or estimated, without asserting it is true.
numbers — it leads with figures: limits, prices, benchmarks, percentages.
take — it states the author's own opinion, judgement or joke about something.
question — it asks the reader something, or poses something as an open question.
personal — it is about the author: their account, their setup, their thanks, their situation.

Rules:
- Answer with a JSON object mapping each id to one label. Nothing else.
- Use exactly these labels, lowercase.
- Judge only the words given, not what you imagine follows.
- A line that reports someone else's claim is rumour even when it sounds certain.
- When two fit, pick the one a reader would notice first.`;

type Candidate = { xPostId: string; openingLine: string };

/**
 * Fills in what kind of opening each post used.
 *
 * The same question the videos are asked — what does the beginning do — put to
 * the thing a reader actually decides on. A post is chosen or scrolled past on
 * its first line, and that line is the one part of it the author writes twice.
 */
export async function classifyPostOpenings(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  input: { apply: boolean; limit: number; overwrite: boolean },
): Promise<Record<string, unknown>> {
  storeOpeningLines(backendDb);
  const candidates = loadCandidates(backendDb, input.overwrite).slice(0, input.limit);
  if (!candidates.length) return { applied: input.apply, candidates: 0, note: "Every post with an opening already carries its kind." };
  if (!input.apply)
    return {
      applied: false,
      candidates: candidates.length,
      sample: candidates.slice(0, 5).map((row) => ({ post: row.xPostId, opening: row.openingLine.slice(0, 110) })),
    };
  const labelled: Array<{ post: string; kind: string; opening: string }> = [];
  const refused: string[] = [];
  for (let start = 0; start < candidates.length; start += BATCH) {
    const batch = candidates.slice(start, start + BATCH);
    let answer: Record<string, unknown>;
    try {
      const raw = await deepSeekChat(
        config,
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: batch.map((row) => `${row.xPostId}: ${row.openingLine.slice(0, 300)}`).join("\n") },
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
      const kind = String(answer[candidate.xPostId] ?? "").toLowerCase();
      if (!OPENING_KINDS.includes(kind as (typeof OPENING_KINDS)[number])) {
        refused.push(`${candidate.xPostId}: answered ${kind || "nothing"}`);
        continue;
      }
      unsafeDb(backendDb)
        .db.update(xActivityItems)
        .set({ openingKind: kind })
        .where(eq(xActivityItems.xPostId, candidate.xPostId))
        .run();
      labelled.push({ post: candidate.xPostId, kind, opening: candidate.openingLine.slice(0, 80) });
    }
  }
  const counts: Record<string, number> = {};
  for (const row of labelled) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  return {
    applied: true,
    labelled: labelled.length,
    byKind: counts,
    refused: refused.slice(0, 10),
    sample: labelled.slice(0, 8),
    note: "The kind is a judgement about one line, not a measurement. Read a handful against their openings before trusting a grouping built on them.",
  };
}

/** The first line of every standalone post that has words in it.
 *
 * Replies are left alone: the line that opens an answer to someone else was
 * not chosen to stop a scroll, and grouping it beside one that was would put
 * two different acts under one name. */
function storeOpeningLines(backendDb: BackendDb): void {
  unsafeDb(backendDb).sqlite.exec(
    `UPDATE x_activity_items
        SET opening_line = TRIM(
              CASE WHEN INSTR(text, char(10)) > 0 THEN SUBSTR(text, 1, INSTR(text, char(10)) - 1) ELSE text END)
      WHERE kind = 'standalone' AND opening_line IS NULL AND TRIM(text) <> ''`,
  );
}

function loadCandidates(backendDb: BackendDb, overwrite: boolean): Candidate[] {
  return (
    unsafeDb(backendDb)
      .sqlite.prepare(
        `SELECT x_post_id AS xPostId, opening_line AS openingLine
           FROM x_activity_items
          WHERE kind = 'standalone' AND opening_line IS NOT NULL
            ${overwrite ? "" : "AND opening_kind IS NULL"}
          ORDER BY published_at DESC`,
      )
      .all() as Candidate[]
  ).filter((row) => row.openingLine.split(/\s+/u).filter(Boolean).length >= ENOUGH_WORDS);
}
