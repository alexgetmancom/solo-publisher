import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoDrafts } from "../db/schema.js";

/** The line the publishing copy already carries. Every Studio caption and
 * YouTube description names the game on its own line, so the tag can be read
 * back out of what was published rather than invented. */
const GAME_LINE = /Название игры:\s*(.+)/u;

/** A title's own tail after the last pipe, which is where the game goes when
 * the copy is shorter than a caption. */
const TITLE_TAIL = /\|\s*([^|]+)$/u;

type Candidate = { videoDraftId: number; label: string | null; game: string | null; texts: string[] };

/**
 * Fills in `game` from the copy that was published with each video.
 *
 * Only from evidence: the "Название игры" line the captions and descriptions
 * carry, or the title's tail after the last pipe. A video whose copy names no
 * game is reported and left alone -- a guessed tag is worse than a missing
 * one, because the report cannot tell them apart afterwards.
 */
export function backfillVideoGames(backendDb: BackendDb, input: { apply: boolean; overwrite: boolean }): Record<string, unknown> {
  const candidates = loadCandidates(backendDb);
  const plan: Array<{ ref: string; game: string; source: "caption" | "title"; label: string | null }> = [];
  const unresolved: Array<{ ref: string; label: string | null }> = [];
  for (const candidate of candidates) {
    if (candidate.game && !input.overwrite) continue;
    const found = extractGame(candidate);
    if (!found) {
      unresolved.push({ ref: `video:${candidate.videoDraftId}`, label: candidate.label });
      continue;
    }
    plan.push({ ref: `video:${candidate.videoDraftId}`, label: candidate.label, ...found });
  }
  if (input.apply) {
    const now = new Date().toISOString();
    unsafeDb(backendDb).db.transaction((tx) => {
      for (const entry of plan)
        tx.update(videoDrafts)
          .set({ game: entry.game, updatedAt: now })
          .where(eq(videoDrafts.id, Number(entry.ref.slice("video:".length))))
          .run();
    });
  }
  const games = new Map<string, number>();
  for (const entry of plan) games.set(entry.game, (games.get(entry.game) ?? 0) + 1);
  return {
    applied: input.apply,
    videos: candidates.length,
    alreadyTagged: candidates.filter((candidate) => candidate.game).length,
    tagged: plan.length,
    unresolved: unresolved.length,
    distinctGames: games.size,
    bySource: {
      caption: plan.filter((entry) => entry.source === "caption").length,
      title: plan.filter((entry) => entry.source === "title").length,
    },
    games: [...games.entries()].sort(([, left], [, right]) => right - left).map(([game, videos]) => ({ game, videos })),
    plan: input.apply ? undefined : plan.slice(0, 20),
    leftAlone: unresolved.slice(0, 40),
  };
}

function loadCandidates(backendDb: BackendDb): Candidate[] {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT d.id AS videoDraftId, d.label AS label, d.game AS game,
              (SELECT group_concat(t.metadata_json, char(30)) FROM video_targets t WHERE t.video_draft_id = d.id) AS metadata
         FROM video_drafts d
        WHERE EXISTS (SELECT 1 FROM video_targets t WHERE t.video_draft_id = d.id AND t.status = 'published')
        ORDER BY d.id`,
    )
    .all() as Array<{ videoDraftId: number; label: string | null; game: string | null; metadata: string | null }>;
  return rows.map((row) => ({
    videoDraftId: row.videoDraftId,
    label: row.label,
    game: row.game,
    texts: (row.metadata ?? "").split(String.fromCharCode(30)).filter(Boolean),
  }));
}

function extractGame(candidate: Candidate): { game: string; source: "caption" | "title" } | null {
  for (const text of candidate.texts) {
    const line = GAME_LINE.exec(unescapeJson(text))?.[1];
    const cleaned = line ? clean(line) : null;
    if (cleaned) return { game: cleaned, source: "caption" };
  }
  const tail = candidate.label ? TITLE_TAIL.exec(candidate.label)?.[1] : null;
  const cleanedTail = tail ? clean(tail) : null;
  return cleanedTail ? { game: cleanedTail, source: "title" } : null;
}

/** The metadata arrives as stored JSON, where the copy's newlines are still
 * escaped; the game line ends at the first of them. */
function unescapeJson(text: string): string {
  return text.replace(/\\n/gu, "\n").replace(/\\"/gu, '"');
}

function clean(value: string): string | null {
  const trimmed = value
    .split("\n")[0]
    ?.replace(/["}\\].*$/u, "")
    .replace(/#\S+/gu, "")
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return trimmed && trimmed.length > 1 && trimmed.length <= 80 ? trimmed : null;
}
