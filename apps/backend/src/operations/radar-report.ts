import type { BackendDb } from "../db/client.js";
import { candidateCounts, listCandidates, outcomeReport, recentRuns } from "../editorial/store.js";

/** What the radar has been doing, for an operator with no bot in front of them.
 *
 * The first question asked of a quiet radar is always the same -- did it find
 * nothing, or did it fail -- and the runs answer it before any candidate is
 * read. */
export function radarReport(backendDb: BackendDb) {
  const counts = candidateCounts(backendDb);
  return {
    waiting: counts.waiting,
    deferred: counts.later,
    runs: recentRuns(backendDb, 6).map((run) => ({
      producer: run.producer,
      status: run.status,
      startedAt: run.startedAt,
      candidates: run.candidateCount,
      duplicates: run.duplicateCount,
      ...(run.error ? { error: run.error.slice(0, 300) } : {}),
    })),
    // What the accepted findings did. Here rather than in the ranking on
    // purpose: changing the editorial line is a decision to be read and made,
    // not one the radar makes on a few publications a day.
    published: { "24h": outcomeReport(backendDb, "24h"), "7d": outcomeReport(backendDb, "7d") },
    top: listCandidates(backendDb, "new", 5).map((candidate) => ({
      id: candidate.id,
      producer: candidate.producer,
      score: candidate.score,
      title: candidate.title,
      ...(candidate.url ? { url: candidate.url } : {}),
    })),
  };
}
