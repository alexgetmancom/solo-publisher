import { and, eq, inArray } from "drizzle-orm";
import { claimSync, markSynced } from "../analytics/snapshots/creator-store.js";
import { createDraftFromMessage } from "../content/drafts.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { editorialCandidates } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import type { StudioLocale } from "../foundation/locale.js";
import { log } from "../foundation/logger.js";
import { zonedDateTimeParts } from "../foundation/time.js";
import { settingsService } from "../studio/services/settings.js";
import { canonicalUrl, sourceHost } from "./cluster.js";
import { GROK_RUN_BUDGET_SECONDS, type GrokSpawn, searchWithGrok } from "./producers/grok.js";
import { findArchiveIdeas } from "./producers/ideas.js";
import { structureFindings } from "./producers/structure.js";
import { editorialProfile, matchEntitySlugs } from "./profile.js";
import { scoreCandidate } from "./ranking.js";
import {
  type CandidateInput,
  decisionCounters,
  type EditorialProducer,
  expireCandidates,
  finishRun,
  startRun,
  storeCandidates,
} from "./store.js";

/** One pass of the radar: produce, rank, store.
 *
 * Both producers end in the same list because the decision they ask for is the
 * same decision. What differs is only where the material came from, which the
 * candidate carries and the card shows. */

export type RadarRunResult =
  | { status: "stored"; producer: EditorialProducer; inserted: number; duplicates: number }
  | { status: "disabled" | "not_due" | "missing_prompt" | "already_ran" }
  | { status: "failed"; error: string };

export type RadarRunOptions = {
  force?: boolean;
  spawn?: GrokSpawn;
  fetchImpl?: typeof fetch;
  now?: Date;
};

export async function runRadar(
  config: BackendConfig,
  backendDb: BackendDb,
  producer: EditorialProducer,
  options: RadarRunOptions = {},
): Promise<RadarRunResult> {
  if (config.CONTROLLER_ADMIN_IDS.length === 0) return { status: "disabled" };
  const settings = settingsService(backendDb).radar();
  if (!options.force && !settings.enabled) return { status: "disabled" };
  if (producer === "news" && !settings.prompt) return { status: "missing_prompt" };
  if (producer === "ideas" && !config.DEEPSEEK_API_KEY) return { status: "disabled" };

  const now = options.now ?? backendDb.clock.now();
  // The Studio's own zone, not the primary administrator's personal override:
  // this schedule belongs to the installation and is shared by everyone on it.
  const date = zonedDateTimeParts(now, config.TIMEZONE);
  if (!options.force && date.hour * 60 + date.minute < settings.hour * 60 + settings.minute) return { status: "not_due" };

  const key = `radar:${producer}:${date.day}`;
  const owner = `radar:${producer}`;
  if (
    !options.force &&
    !claimSync(backendDb, key, {
      intervalSeconds: 24 * 60 * 60,
      leaseSeconds: producer === "news" ? GROK_RUN_BUDGET_SECONDS : 300,
      owner,
    })
  )
    return { status: "already_ran" };

  const runId = startRun(backendDb, producer);
  const locale = settingsService(backendDb).locale(config.CONTROLLER_ADMIN_IDS[0] ?? 0);
  try {
    const { items, rawText } = await produce(config, backendDb, producer, locale, settings, options);
    const stored = storeCandidates(backendDb, runId, producer, rank(backendDb, items));
    finishRun(backendDb, runId, { status: "done", rawText, candidates: stored.inserted, duplicates: stored.duplicates });
    if (!options.force) markSynced(backendDb, key, null, owner);
    expireCandidates(backendDb);
    return { status: "stored", producer, ...stored };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishRun(backendDb, runId, { status: "failed", error: message.slice(0, 2_000) });
    if (!options.force) markSynced(backendDb, key, message.slice(0, 500), owner);
    log("warn", "radar run failed", { producer, error: message });
    return { status: "failed", error: message };
  }
}

async function produce(
  config: BackendConfig,
  backendDb: BackendDb,
  producer: EditorialProducer,
  locale: StudioLocale,
  settings: { prompt: string; effort: Parameters<typeof searchWithGrok>[2] },
  options: RadarRunOptions,
): Promise<{ items: CandidateInput[]; rawText: string | null }> {
  const profile = editorialProfile(backendDb);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (producer === "ideas") return { items: await findArchiveIdeas(config, profile, locale, fetchImpl), rawText: null };
  const markdown = await searchWithGrok(config, settings.prompt, settings.effort, options.spawn ?? (Bun.spawn as unknown as GrokSpawn));
  return { items: await structureFindings(config, markdown, profile, locale, fetchImpl), rawText: markdown };
}

function rank(backendDb: BackendDb, items: CandidateInput[]) {
  const profile = editorialProfile(backendDb);
  const counters = decisionCounters(backendDb);
  return items.map((item) => {
    const entitySlugs = matchEntitySlugs(item.title, item.summary, profile.clusters);
    return scoreCandidate({ ...item, entitySlugs }, { counters, posts: profile.posts, host: sourceHost(canonicalUrl(item.url)) });
  });
}

/** Turns a finding into a draft, once.
 *
 * The claim and the draft are one transaction, and the claim carries the status
 * it was read under: a second tap on the card -- the one still sitting in the
 * chat from this morning, or a double tap on this one -- finds the candidate no
 * longer `new` and creates nothing. Two drafts of one story is the failure this
 * guards, and it is invisible until the second one is published.
 *
 * The draft is seeded from the finding itself and nothing else. Writing the post
 * is the operator's job in the flow this hands over to; a model writing a first
 * version here would be a second authoring path, and the archive producer is
 * already forbidden to write publication copy for the same reason.
 */
export function acceptCandidate(backendDb: BackendDb, actorId: number, candidateId: number): { draftId: number } | null {
  const now = backendDb.clock.now().toISOString();
  return unsafeDb(backendDb).db.transaction((tx) => {
    const claimed = tx
      .update(editorialCandidates)
      .set({ status: "accepted", decidedAt: now, updatedAt: now })
      .where(and(eq(editorialCandidates.id, candidateId), inArray(editorialCandidates.status, ["new", "later"])))
      .returning()
      .all();
    const candidate = claimed[0];
    if (!candidate) return null;
    const draftId = createDraftFromMessage(backendDb, actorId, { text: draftSeed(candidate), media: [], entities: [] });
    tx.update(editorialCandidates).set({ draftId, updatedAt: now }).where(eq(editorialCandidates.id, candidate.id)).run();
    return { draftId };
  });
}

/** What the operator opens the flow on: the finding, in the order they would
 * write it, with the link kept so the source survives the rewrite. */
function draftSeed(candidate: typeof editorialCandidates.$inferSelect): string {
  return [candidate.title, candidate.summary, candidate.url].filter(Boolean).join("\n\n");
}
