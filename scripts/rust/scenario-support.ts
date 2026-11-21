import type { unsafeDb } from "../../apps/backend/src/db/client.js";

/**
 * What every SQL-equivalence runner shares with its Rust counterpart
 * (crates/domain/tests/support/mod.rs): how a step's arguments name earlier
 * results, and how a database is dumped so both sides compare with the same
 * rules.
 */

export function lookup(vars: Record<string, unknown>, reference: string): unknown {
  const [name = "", field = ""] = reference.split(".");
  if (!(name in vars)) throw new Error(`unbound ${name}`);
  return (vars[name] as Record<string, unknown>)[field];
}

/** `{"$": "<name>.<field>"}` arguments replaced by fields of bound results. */
export function resolve(value: unknown, vars: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolve(item, vars));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$ === "string" && Object.keys(record).length === 1) return lookup(vars, record.$);
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, resolve(item, vars)]));
  }
  return value;
}

/** One line per row, by SQLite itself, so both sides dump with the same rules. */
export function dump(sqlite: ReturnType<typeof unsafeDb>["sqlite"], ignored: readonly string[] = []): Record<string, string[]> {
  const tables = sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  const out: Record<string, string[]> = {};
  for (const { name } of tables) {
    if (ignored.includes(name)) continue;
    const columns = sqlite.query("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(name) as { name: string }[];
    const cells = columns.map(({ name: column }) => `typeof("${column}") || ':' || quote("${column}")`).join(" || ' ' || ");
    const rows = sqlite.query(`SELECT quote(rowid) || ' ' || ${cells} AS line FROM "${name}" ORDER BY rowid`).all() as { line: string }[];
    if (rows.length) out[name] = rows.map((row) => row.line);
  }
  return out;
}
