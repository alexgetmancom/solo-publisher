import { type BackendDb, unsafeDb } from "../db/client.js";
import { type DateViolation, dateIntegrity } from "./date-integrity.js";

export type DateRepair = DateViolation & {
  action: "normalised" | "deleted" | "dated from last_seen_at" | "unrepairable";
  applied: boolean;
};

/** Readings: a row here is one measurement, and a measurement whose moment is
 * unknown is not a measurement. Nothing else may be deleted to fix a date. */
const READING_TABLES = new Set(["metric_samples", "post_metrics", "x_activity_metric_snapshots"]);

/** "2026-07-21 21:14:53" — what SQLite's CURRENT_TIMESTAMP writes, in UTC, with
 * a space where the T belongs. The same instant, spelled so that it sorts before
 * every ISO row in its own column. */
const SQLITE_STAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/u;

/**
 * Makes every stored date a date, by the only three moves that are honest.
 *
 * A timestamp SQLite wrote its own way is the same instant and is rewritten in
 * place. A reading stamped with a moment that never happened is deleted, because
 * the row's whole content was that moment. An X item's `first_seen_at` is dated
 * from the last time it was seen -- first seen no later than that is true, and
 * losing the item to a broken timestamp is not.
 */
export function repairStoredDates(backendDb: BackendDb, apply: boolean): DateRepair[] {
  const sqlite = unsafeDb(backendDb).sqlite;
  const repairs: DateRepair[] = [];
  for (const violation of dateIntegrity(backendDb)) {
    const { table, column } = violation;
    const values = (
      sqlite.prepare(`SELECT DISTINCT "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL`).all() as Array<{ value: string }>
    ).map((row) => row.value);
    const stamped = values.filter((value) => SQLITE_STAMP.test(value));
    const broken = values.filter((value) => !SQLITE_STAMP.test(value) && !isInstant(value));
    if (stamped.length) {
      if (apply)
        for (const value of stamped)
          sqlite.prepare(`UPDATE "${table}" SET "${column}"=? WHERE "${column}"=?`).run(value.replace(SQLITE_STAMP, "$1T$2.000Z"), value);
      repairs.push({ ...violation, action: "normalised", applied: apply });
    }
    if (!broken.length) continue;
    if (READING_TABLES.has(table)) {
      if (apply) for (const value of broken) sqlite.prepare(`DELETE FROM "${table}" WHERE "${column}"=?`).run(value);
      repairs.push({ ...violation, action: "deleted", applied: apply });
    } else if (table === "x_activity_items" && column === "first_seen_at") {
      if (apply) sqlite.prepare(`UPDATE x_activity_items SET first_seen_at=last_seen_at WHERE first_seen_at NOT GLOB ?`).run(INSTANT_GLOB);
      repairs.push({ ...violation, action: "dated from last_seen_at", applied: apply });
    } else repairs.push({ ...violation, action: "unrepairable", applied: false });
  }
  return repairs;
}

const INSTANT_GLOB = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*";

function isInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u.test(value);
}
