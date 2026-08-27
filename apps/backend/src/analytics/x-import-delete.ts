import { type BackendDb, unsafeDb } from "../db/client.js";

export type XImportDeletion = {
  importId: number;
  sourceFile: string | null;
  sampledAt: string | null;
  snapshots: number;
  applied: boolean;
};

/**
 * Removes one CSV import and every reading it wrote.
 *
 * An import can be wrong in a way no re-import repairs: a mangled `sampled_at`
 * stamps its readings with a moment that never happened, and nothing later
 * overwrites them, because a reading is keyed by the moment it was taken. The
 * rows it created in `x_activity_items` stay -- those are real posts, and the
 * next import readmits them.
 */
export function deleteXImport(backendDb: BackendDb, importId: number, apply: boolean): XImportDeletion {
  const sqlite = unsafeDb(backendDb).sqlite;
  const row = sqlite
    .prepare("SELECT source_file AS sourceFile, sampled_at AS sampledAt FROM x_activity_imports WHERE id=?")
    .get(importId) as { sourceFile: string; sampledAt: string } | undefined;
  if (!row) throw new Error(`No X import ${importId}`);
  const counted = sqlite.prepare("SELECT COUNT(*) AS count FROM x_activity_metric_snapshots WHERE import_id=?").get(importId) as {
    count: number;
  };
  if (!apply) return { importId, sourceFile: row.sourceFile, sampledAt: row.sampledAt, snapshots: counted.count, applied: false };
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM x_activity_metric_snapshots WHERE import_id=?").run(importId);
    sqlite.prepare("DELETE FROM x_activity_imports WHERE id=?").run(importId);
  })();
  return { importId, sourceFile: row.sourceFile, sampledAt: row.sampledAt, snapshots: counted.count, applied: true };
}
