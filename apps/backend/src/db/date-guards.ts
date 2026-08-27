import type { Database } from "bun:sqlite";

/**
 * The database refuses a date that is not one.
 *
 * A rule in a document is advice and a check in an importer guards one door;
 * "34Z" walked through a different one and took eight days of readings off the
 * charts without a single error. These triggers are the barrier itself: every
 * writer hits them, including raw SQL through `unsafeDb`, a migration copying
 * rows, and code written years from now by someone who never read the rule.
 *
 * They are installed from what the database actually holds rather than from a
 * list, so a column added by tomorrow's migration is guarded the next time the
 * process starts, with nobody remembering to add it.
 */
const INSTANT = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*";
const DAY = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]";
/** `sampled_on` buckets by hour when the collector runs hourly, and the bucket
 * is the truncated timestamp: a day with an hour on it, still not a moment. */
const HOUR = `${DAY}T[0-9][0-9]`;
const PREFIX = "date_guard_";

/** A `_at` column is a moment; `_on` and an export's period are the day (or the
 * hour) something is filed under. */
function expectationFor(column: string): { patterns: string[]; shape: string } | null {
  if (/_at$/u.test(column)) return { patterns: [INSTANT], shape: "an ISO instant such as 2026-08-27T14:01:34Z" };
  if (/_on$/u.test(column) || column === "period_start" || column === "period_end")
    return { patterns: [DAY, HOUR], shape: "a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15" };
  return null;
}

export function installDateGuards(sqlite: Database): number {
  // One query for every column in the database: a PRAGMA per table costs more
  // than the triggers themselves, and this runs on every open.
  const columns = sqlite
    .prepare(
      `SELECT m.name AS "table", info.name AS "column", info.type AS "type"
         FROM sqlite_master AS m
         JOIN pragma_table_info(m.name) AS info
        WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ table: string; column: string; type: string }>;
  const wanted = new Map<string, string>();
  for (const { table, column, type } of columns) {
    const expectation = expectationFor(column);
    if (!expectation || !/text|char|clob/iu.test(type)) continue;
    const message = `${table}.${column} must be ${expectation.shape}`;
    const rejects = expectation.patterns.map((pattern) => `NEW."${column}" NOT GLOB '${pattern}'`).join(" AND ");
    for (const [event, clause] of [
      ["insert", `BEFORE INSERT ON "${table}"`],
      ["update", `BEFORE UPDATE OF "${column}" ON "${table}"`],
    ] as const)
      wanted.set(
        `${PREFIX}${table}_${column}_${event}`,
        `CREATE TRIGGER "${PREFIX}${table}_${column}_${event}" ${clause}
         FOR EACH ROW WHEN NEW."${column}" IS NOT NULL AND ${rejects}
         BEGIN SELECT RAISE(ABORT, '${message.replace(/'/gu, "''")}'); END`,
      );
  }
  const existing = new Set(
    (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '${PREFIX}%'`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  // A column that stopped being a date, or a table that is gone, leaves a
  // trigger behind that would guard nothing and confuse the next reader.
  const stale = [...existing].filter((name) => !wanted.has(name));
  const missing = [...wanted].filter(([name]) => !existing.has(name));
  if (!stale.length && !missing.length) return 0;
  sqlite.transaction(() => {
    for (const name of stale) sqlite.run(`DROP TRIGGER IF EXISTS "${name}"`);
    for (const [, statement] of missing) sqlite.run(statement);
  })();
  return missing.length;
}
