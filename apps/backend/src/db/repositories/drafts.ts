import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Clock, DraftPatch, DraftRecord, DraftStore, NewDraft } from "../../application/ports.js";
import { drafts, postLocales } from "../schema.js";
import type { BackendDatabase } from "../types.js";

const ru = alias(postLocales, "draft_locale_ru");
const en = alias(postLocales, "draft_locale_en");
const draftProjection = {
  id: drafts.id,
  actor_id: drafts.actorId,
  status: drafts.status,
  textRu: ru.sourceText,
  textEnMachine: en.sourceText,
  textEnApproved: en.approvedText,
  targets_json: drafts.targetsJson,
  mediaRu: ru.mediaJson,
  mediaEn: en.mediaJson,
  scheduled_at: drafts.scheduledAt,
  scheduled_en_at: drafts.scheduledEnAt,
  post_id: drafts.postId,
  textRuEntities: ru.entitiesJson,
  textEnEntities: en.entitiesJson,
  threads_chain_approved: drafts.threadsChainApproved,
  story_publish_mode: drafts.storyPublishMode,
  updated_at: drafts.updatedAt,
};

type DraftProjection = {
  id: number;
  actor_id: number;
  status: string;
  textRu: string | null;
  textEnMachine: string | null;
  textEnApproved: string | null;
  targets_json: string;
  mediaRu: unknown;
  mediaEn: unknown;
  scheduled_at: string | null;
  scheduled_en_at: string | null;
  post_id: number | null;
  textRuEntities: string | null;
  textEnEntities: string | null;
  threads_chain_approved: number;
  story_publish_mode: string | null;
  updated_at: string;
};

function record(row: DraftProjection): DraftRecord {
  return {
    id: row.id,
    actor_id: row.actor_id,
    status: row.status,
    text_ru: row.textRu ?? "",
    text_en_machine: row.textEnMachine || null,
    text_en_approved: row.textEnApproved,
    targets_json: row.targets_json,
    media_ru_json: jsonText(row.mediaRu),
    media_en_json: jsonText(row.mediaEn),
    scheduled_at: row.scheduled_at,
    scheduled_en_at: row.scheduled_en_at,
    post_id: row.post_id,
    text_ru_entities_json: row.textRuEntities,
    text_en_entities_json: row.textEnEntities,
    threads_chain_approved: row.threads_chain_approved,
    story_publish_mode: row.story_publish_mode,
    updated_at: row.updated_at,
  };
}

function jsonText(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function jsonValue(value: string | null | undefined): Record<string, unknown>[] | null {
  if (value == null) return null;
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
}

function selectDrafts(db: BackendDatabase) {
  return db
    .select(draftProjection)
    .from(drafts)
    .leftJoin(ru, and(eq(ru.draftId, drafts.id), eq(ru.locale, "ru")))
    .leftJoin(en, and(eq(en.draftId, drafts.id), eq(en.locale, "en")));
}

/** SQLite adapter for the application-level draft port. */
export function createDraftStore(db: BackendDatabase, clock: Clock): DraftStore {
  return {
    create(input: NewDraft): number {
      const now = clock.now().toISOString();
      return db.transaction((tx) => {
        const created = tx
          .insert(drafts)
          .values({
            actorId: input.actorId,
            status: "needs_review",
            targetsJson: input.targetsJson,
            storyPublishMode: input.storyPublishMode,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: drafts.id })
          .get();
        if (!created) throw new Error("draft insert did not return an id");
        tx.insert(postLocales)
          .values([
            {
              draftId: created.id,
              locale: "ru",
              sourceText: input.textRu,
              entitiesJson: input.textRuEntitiesJson,
              mediaJson: jsonValue(input.mediaRuJson),
              updatedAt: now,
            },
            {
              draftId: created.id,
              locale: "en",
              sourceText: input.textEnMachine ?? "",
              approvedText: input.textEnApproved,
              mediaJson: null,
              updatedAt: now,
            },
          ])
          .run();
        return created.id;
      });
    },

    get(id: number): DraftRecord | null {
      const row = selectDrafts(db).where(eq(drafts.id, id)).get() as DraftProjection | undefined;
      return row ? record(row) : null;
    },

    list(actorIds: number[], limit: number): DraftRecord[] {
      return (
        selectDrafts(db).where(inArray(drafts.actorId, actorIds)).orderBy(desc(drafts.updatedAt)).limit(limit).all() as DraftProjection[]
      ).map(record);
    },

    update(id: number, patch: DraftPatch): void {
      updateDraft(db, clock, id, patch);
    },

    updateIfCurrent(id: number, expectedStatus: string, expectedUpdatedAt: string, patch: DraftPatch): boolean {
      return updateDraft(db, clock, id, patch, { status: expectedStatus, updatedAt: expectedUpdatedAt });
    },
  };
}

function updateDraft(
  db: BackendDatabase,
  clock: Clock,
  id: number,
  patch: DraftPatch,
  expected?: { status: string; updatedAt: string },
): boolean {
  const now = patch.updatedAt ?? clock.now().toISOString();
  return db.transaction((tx) => {
    const root = {
      ...(patch.targetsJson === undefined ? {} : { targetsJson: patch.targetsJson }),
      ...(patch.threadsChainApproved === undefined ? {} : { threadsChainApproved: patch.threadsChainApproved }),
      updatedAt: now,
    };
    const changed = tx
      .update(drafts)
      .set(root)
      .where(
        expected ? and(eq(drafts.id, id), eq(drafts.status, expected.status), eq(drafts.updatedAt, expected.updatedAt)) : eq(drafts.id, id),
      )
      .returning({ id: drafts.id })
      .get();
    if (!changed) return false;
    const ruPatch = {
      ...(patch.textRu === undefined ? {} : { sourceText: patch.textRu }),
      ...(patch.textRuEntitiesJson === undefined ? {} : { entitiesJson: patch.textRuEntitiesJson }),
      ...(patch.mediaRuJson === undefined ? {} : { mediaJson: jsonValue(patch.mediaRuJson) }),
      updatedAt: now,
    };
    const enPatch = {
      ...(patch.textEnMachine === undefined ? {} : { sourceText: patch.textEnMachine }),
      ...(patch.textEnApproved === undefined ? {} : { approvedText: patch.textEnApproved }),
      ...(patch.textEnEntitiesJson === undefined ? {} : { entitiesJson: patch.textEnEntitiesJson }),
      ...(patch.mediaEnJson === undefined ? {} : { mediaJson: jsonValue(patch.mediaEnJson) }),
      updatedAt: now,
    };
    if (Object.keys(ruPatch).length > 1)
      tx.update(postLocales)
        .set(ruPatch)
        .where(and(eq(postLocales.draftId, id), eq(postLocales.locale, "ru")))
        .run();
    if (Object.keys(enPatch).length > 1)
      tx.update(postLocales)
        .set(enPatch)
        .where(and(eq(postLocales.draftId, id), eq(postLocales.locale, "en")))
        .run();
    return true;
  });
}
