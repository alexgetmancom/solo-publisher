import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { isStoryTarget } from "../botTargets.js";
import { effectivePostTargets, registeredPostTargetIds } from "../channels/registry.js";
import { requireDraft } from "../content/drafts.js";
import { enrichPublishedPostEntities } from "../content/entity-enrichment.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { createEntityEnrichmentStore } from "../db/repositories/entity-enrichment.js";
import { draftEntityCandidates, draftEntityLinks, drafts, knowledgeEntities } from "../db/schema.js";
import { trackUsageSync } from "../observability/usage.js";
import { readyStoryCardMedia } from "../story-cards/store.js";
import { assertPublicationPreflight } from "./preflight.js";
import { createPublicationPlan, type PublishMode } from "./publication-plan.js";
import { refreshPublicationStatus } from "./publication-status.js";
import { persistPublicationPlanTx } from "./publication-writer.js";
import { parseTargets } from "./targets.js";

type PublishDraftOptions = { mode?: PublishMode; ruAt?: Date | null; enAt?: Date | null; immediateLocale?: "ru" | "en" };

/** Coordinates validated content, durable plan persistence and initial queue reconciliation. */
export function publishDraftToQueue(backendDb: BackendDb, draftId: number, options: PublishDraftOptions = {}): number {
  return trackUsageSync(backendDb, "publishing.plan.create", () => publishDraftToQueueInternal(backendDb, draftId, options));
}

function publishDraftToQueueInternal(backendDb: BackendDb, draftId: number, options: PublishDraftOptions = {}): number {
  const draft = requireDraft(backendDb, draftId);
  const effectiveDraft = {
    ...draft,
    targets_json: JSON.stringify(effectivePostTargets(backendDb, parseTargets(draft.targets_json))),
  };
  assertPublicationPreflight(effectiveDraft);
  const now = new Date().toISOString();
  const mode = options.mode ?? "immediate";
  const ruAt = mode === "immediate" || options.immediateLocale === "ru" ? now : (options.ruAt?.toISOString() ?? null);
  const enAt = mode === "immediate" || options.immediateLocale === "en" ? now : (options.enAt?.toISOString() ?? null);
  // One immediate transaction for the whole hand-off: id allocation and the
  // jobs it owns become visible together, and concurrent interfaces cannot
  // choose the same next public id from a stale maximum.
  const { postId, plan } = unsafeDb(backendDb).db.transaction(
    (tx) => {
      const publicationId = ensurePublication(tx, draftId, now);
      copyAcceptedEntities(tx, draftId, now);
      const registeredTargets = registeredPostTargetIds(backendDb);
      const storyCards = readyStoryCardMedia(unsafeDb(backendDb).db, draftId);
      const hasStoryTarget = Object.entries(parseTargets(effectiveDraft.targets_json)).some(
        ([target, enabled]) => enabled && isStoryTarget(target),
      );
      if (storyCards && hasStoryTarget && draft.story_publish_mode !== "all" && draft.story_publish_mode !== "site_only")
        throw new Error("Story delivery decision is required for a text-only post");
      const publicationPlan = createPublicationPlan(
        effectiveDraft,
        draftId,
        publicationId,
        { mode, ruAt, enAt },
        now,
        registeredTargets.size ? registeredTargets : undefined,
        storyCards ?? undefined,
      );
      persistPublicationPlanTx(tx, publicationPlan);
      enrichPublishedPostEntities(createEntityEnrichmentStore(tx), draftId, now);
      return { postId: publicationId, plan: publicationPlan };
    },
    { behavior: "immediate" },
  );
  refreshPublicationStatus(backendDb, postId);
  backendDb.events.record({
    ref: publicationRef("post", postId),
    type: "publishing.plan.created",
    severity: "info",
    message: `Publication plan created for draft #${draftId}`,
    details: {
      draft_id: draftId,
      mode,
      ru_at: ruAt,
      en_at: enAt,
      targets: Object.keys(plan.targets).filter((target) => plan.targets[target]),
    },
  });
  return postId;
}

function copyAcceptedEntities(db: UnsafeBackendDb["db"], draftId: number, now: string): void {
  const candidates = db
    .select()
    .from(draftEntityCandidates)
    .where(and(eq(draftEntityCandidates.draftId, draftId), eq(draftEntityCandidates.status, "accepted")))
    .all();
  if (!candidates.length) return;
  db.insert(knowledgeEntities)
    .values(
      candidates.map((candidate) => ({
        kind: candidate.kind,
        slug: candidate.slug,
        titleRu: candidate.titleRu,
        titleEn: candidate.titleEn,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing()
    .run();
  const kinds = [...new Set(candidates.map((candidate) => candidate.kind))];
  const candidateKeys = new Set(candidates.map((candidate) => `${candidate.kind}\u0000${candidate.slug}`));
  const entities = db
    .select({ id: knowledgeEntities.id, kind: knowledgeEntities.kind, slug: knowledgeEntities.slug })
    .from(knowledgeEntities)
    .where(inArray(knowledgeEntities.kind, kinds))
    .all()
    .filter((entity) => candidateKeys.has(`${entity.kind}\u0000${entity.slug}`));
  if (entities.length)
    db.insert(draftEntityLinks)
      .values(entities.map((entity) => ({ draftId, entityId: entity.id, createdAt: now })))
      .onConflictDoNothing()
      .run();
}

function ensurePublication(db: UnsafeBackendDb["db"], draftId: number, now: string): number {
  const existing = db.select({ postId: drafts.postId }).from(drafts).where(eq(drafts.id, draftId)).get();
  if (existing?.postId != null) return existing.postId;
  if (!existing) throw new Error(`draft ${draftId} not found`);
  const idAvailable = !db.select({ id: drafts.id }).from(drafts).where(eq(drafts.postId, draftId)).get();
  const next = idAvailable
    ? draftId
    : Number(
        db
          .select({ value: sql<number>`coalesce(max(${drafts.postId}), 0) + 1` })
          .from(drafts)
          .get()?.value ?? draftId,
      );
  const inserted = db
    .update(drafts)
    .set({ postId: next, status: "scheduled", updatedAt: now })
    .where(and(eq(drafts.id, draftId), isNull(drafts.postId)))
    .returning({ postId: drafts.postId })
    .get();
  if (inserted?.postId == null) throw new Error("draft publication id allocation did not return an id");
  return inserted.postId;
}
