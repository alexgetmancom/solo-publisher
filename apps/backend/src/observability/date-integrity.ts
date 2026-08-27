import { type BackendDb, unsafeDb } from "../db/client.js";

export type DateViolation = { table: string; column: string; expects: "instant" | "day"; rows: number; sample: string | null };

/**
 * Every stored date, checked for being one.
 *
 * Dates live in this database as text and every query compares them as text, so
 * a value that is not a date does not fail — it sorts. An import once wrote
 * "34Z" into `sampled_at` (a timestamp cut short by a shell, which `Date` was
 * happy to read as the year 2034); those rows sorted above every window the
 * dashboard asks for and vanished from the charts, while every report went on
 * listing them, because reports print dates through `Date` and it parsed.
 *
 * Nothing noticed for a day. The columns are read from the database itself
 * rather than from a list, so a table added tomorrow is covered without anyone
 * remembering to add it.
 */
const INSTANT = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*";
const DAY = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]";
/** An hourly collector files its snapshot under the truncated timestamp. */
const HOUR = `${DAY}T[0-9][0-9]`;

/** `_on` and an export's period are calendar days; everything else is a moment. */
function expectationFor(column: string): "instant" | "day" | null {
  if (/_at$/u.test(column)) return "instant";
  if (/_on$/u.test(column) || column === "period_start" || column === "period_end") return "day";
  return null;
}

export function dateIntegrity(backendDb: BackendDb): DateViolation[] {
  const sqlite = unsafeDb(backendDb).sqlite;
  const tables = (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  const violations: DateViolation[] = [];
  for (const table of tables) {
    const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>;
    for (const column of columns) {
      const expects = expectationFor(column.name);
      if (!expects || !/text|char|clob/iu.test(column.type)) continue;
      const patterns = expects === "instant" ? [INSTANT] : [DAY, HOUR];
      const row = sqlite
        .prepare(
          `SELECT COUNT(*) AS rows, MIN("${column.name}") AS sample FROM "${table}"
           WHERE "${column.name}" IS NOT NULL AND ${patterns.map(() => `"${column.name}" NOT GLOB ?`).join(" AND ")}`,
        )
        .get(...patterns) as { rows: number; sample: string | null };
      if (row.rows > 0) violations.push({ table, column: column.name, expects, rows: row.rows, sample: row.sample });
    }
  }
  return violations;
}
