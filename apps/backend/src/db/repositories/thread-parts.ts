import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Clock, NewThreadPart, ThreadPart, ThreadPartStore } from "../../application/ports.js";
import type { MediaPayload } from "../schema/_shared.js";
import { draftThreadParts } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** The first post of a thread is the draft; stored parts start after it. */
const FIRST_STORED_POSITION = 2;

export function createThreadPartStore(db: BackendDatabase, clock: Clock): ThreadPartStore {
  const stamp = () => clock.now().toISOString();
  const row = (draftId: number, position: number, part: NewThreadPart, now: string) => ({
    draftId,
    position,
    textRu: part.textRu,
    entitiesRuJson: part.entitiesRu.length ? part.entitiesRu : null,
    textEn: null,
    mediaJson: part.media.length ? (part.media as MediaPayload[]) : null,
    createdAt: now,
    updatedAt: now,
  });
  return {
    list(draftId: number): ThreadPart[] {
      return db
        .select()
        .from(draftThreadParts)
        .where(eq(draftThreadParts.draftId, draftId))
        .orderBy(asc(draftThreadParts.position))
        .all()
        .map((part) => ({
          position: part.position,
          textRu: part.textRu,
          entitiesRu: part.entitiesRuJson ?? [],
          textEn: part.textEn,
          media: (part.mediaJson ?? []) as Record<string, unknown>[],
        }));
    },

    append(draftId: number, part: NewThreadPart): number {
      return db.transaction((tx) => {
        const last = tx
          .select({ position: sql<number | null>`max(${draftThreadParts.position})` })
          .from(draftThreadParts)
          .where(eq(draftThreadParts.draftId, draftId))
          .get();
        const position = (last?.position ?? FIRST_STORED_POSITION - 1) + 1;
        tx.insert(draftThreadParts)
          .values(row(draftId, position, part, stamp()))
          .run();
        return position;
      });
    },

    replace(draftId: number, parts: NewThreadPart[]): void {
      const now = stamp();
      db.transaction((tx) => {
        tx.delete(draftThreadParts).where(eq(draftThreadParts.draftId, draftId)).run();
        parts.forEach((part, index) => {
          tx.insert(draftThreadParts)
            .values(row(draftId, FIRST_STORED_POSITION + index, part, now))
            .run();
        });
      });
    },

    update(draftId: number, position: number, part: NewThreadPart): boolean {
      const { draftId: _, position: __, createdAt: ___, ...values } = row(draftId, position, part, stamp());
      return Boolean(
        db
          .update(draftThreadParts)
          .set(values)
          .where(and(eq(draftThreadParts.draftId, draftId), eq(draftThreadParts.position, position)))
          .returning({ position: draftThreadParts.position })
          .get(),
      );
    },

    remove(draftId: number, position: number): boolean {
      const now = stamp();
      return db.transaction((tx) => {
        const removed = tx
          .delete(draftThreadParts)
          .where(and(eq(draftThreadParts.draftId, draftId), eq(draftThreadParts.position, position)))
          .returning({ position: draftThreadParts.position })
          .get();
        if (!removed) return false;
        // Ascending, one at a time: shifting every row at once would collide on
        // the primary key while the statement runs.
        const later = tx
          .select({ position: draftThreadParts.position })
          .from(draftThreadParts)
          .where(and(eq(draftThreadParts.draftId, draftId), gt(draftThreadParts.position, position)))
          .orderBy(asc(draftThreadParts.position))
          .all();
        for (const part of later)
          tx.update(draftThreadParts)
            .set({ position: part.position - 1, updatedAt: now })
            .where(and(eq(draftThreadParts.draftId, draftId), eq(draftThreadParts.position, part.position)))
            .run();
        return true;
      });
    },

    setEnglish(draftId: number, texts: Array<{ position: number; textEn: string }>): void {
      const now = stamp();
      db.transaction((tx) => {
        for (const { position, textEn } of texts)
          tx.update(draftThreadParts)
            .set({ textEn, updatedAt: now })
            .where(and(eq(draftThreadParts.draftId, draftId), eq(draftThreadParts.position, position)))
            .run();
      });
    },
  };
}
