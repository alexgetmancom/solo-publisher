import { titleSimilarity } from "./cluster.js";
import type { PublishedPost } from "./profile.js";
import type { CandidateInput, DecisionCounters } from "./store.js";

/** How a finding is ordered against the others.
 *
 * Readable arithmetic over counted decisions, not a model. On one editor making
 * a few decisions a day this is not a first step towards learning weights, it
 * is the finished shape: every number below can be explained on the card, and
 * corrected by making different decisions.
 *
 * Published results are deliberately absent. They are collected and reported,
 * but at one or two publications a day the platform, the hour and the audience
 * move a post's numbers far more than its subject does, so feeding them here
 * would rank on noise -- and on the noise that rewards the widest topic, which
 * is the one thing this radar must not learn to do. */

/** Weights, summing to 100 before repetition is subtracted.
 *
 * Freshness is not among them, and its absence is deliberate. A score is
 * computed once, when the finding is stored, so a freshness term would be
 * frozen at the age the candidate had on arrival -- full marks forever, on a
 * story that is now three days old. What age actually decides here is whether
 * the finding is offered at all, and that is the expiry. */
const SUBJECT_WEIGHT = 60;
const SOURCE_WEIGHT = 20;
const REASON_WEIGHT = 20;
/** What a story already covered by a recent post loses. */
const REPETITION_PENALTY = 35;

/** A subject with no history scores as this, so an unknown subject is neither
 * promoted nor buried: the first few findings about it are ordered by
 * everything else, and its own history starts once decisions exist. */
const PRIOR = 0.5;
/** How much a single decision moves a rate. Two prior observations means three
 * skips in a row take a subject to 0.2 rather than to 0. */
const PRIOR_WEIGHT = 2;

function rate(entry: { accepted: number; skipped: number } | undefined): number {
  if (!entry) return PRIOR;
  return (entry.accepted + PRIOR * PRIOR_WEIGHT) / (entry.accepted + entry.skipped + PRIOR_WEIGHT);
}

export type ScoredCandidate = CandidateInput & { score: number; scores: Record<string, number> };

export function scoreCandidate(
  candidate: CandidateInput,
  context: { counters: DecisionCounters; posts: PublishedPost[]; host: string | null },
): ScoredCandidate {
  const subjectRates = candidate.entitySlugs.map((slug) => rate(context.counters.bySlug.get(slug)));
  const subject = subjectRates.length ? subjectRates.reduce((sum, value) => sum + value, 0) / subjectRates.length : PRIOR;
  const source = rate(context.host ? context.counters.byHost.get(context.host) : undefined);
  // A finding that explains itself against this Studio's own material is worth
  // more than one that asserts importance. Length is a poor proxy for that and
  // the only one available before the operator has answered anything.
  const reason = Math.min(1, candidate.reason.trim().length / 160);
  const repetition = Math.max(0, ...context.posts.map((post) => titleSimilarity(candidate.title, post.textRu.slice(0, 200))));
  const scores = {
    subject: Math.round(subject * SUBJECT_WEIGHT),
    source: Math.round(source * SOURCE_WEIGHT),
    reason: Math.round(reason * REASON_WEIGHT),
    repetition: -Math.round(repetition * REPETITION_PENALTY),
  };
  const score = Math.max(
    0,
    Object.values(scores).reduce((sum, value) => sum + value, 0),
  );
  return { ...candidate, score, scores };
}

/** Which findings are put in front of the operator now.
 *
 * The last of the three is drawn from below the top on purpose. A radar that
 * only ever shows its own best guesses only ever gets decisions about them, and
 * the ranking then confirms itself forever -- so one slot is spent on something
 * it is less sure of, and the answer to that is worth more than the answer to a
 * fourth confident guess. */
export function selectForDelivery<T extends { id: number; score: number }>(candidates: readonly T[], count: number, seed: number): T[] {
  const ranked = [...candidates].sort((left, right) => right.score - left.score || left.id - right.id);
  if (ranked.length <= count) return ranked;
  const confident = ranked.slice(0, count - 1);
  const rest = ranked.slice(count - 1);
  const explored = rest[seed % rest.length];
  return explored ? [...confident, explored] : confident;
}
