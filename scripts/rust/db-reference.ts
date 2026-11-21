import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { openBackendDb, unsafeDb } from "../../apps/backend/src/db/client.js";

/**
 * The TypeScript side of the Rust `db` crate's parity tests: it opens a
 * database through the real `openBackendDb` (migrator, date guards and all) so
 * the Rust tests compare against what production code does, not a copy of it.
 *
 *   bun scripts/rust/db-reference.ts open <db>          # {"before":n,"after":n} rows in __drizzle_migrations
 *   bun scripts/rust/db-reference.ts exec <db> <sql>    # {"ok":true} or {"error":"<SQLite message>"}
 */
const [command, path, statement] = process.argv.slice(2);

function appliedMigrations(file: string): number {
  if (!existsSync(file)) return 0;
  const sqlite = new Database(file, { readonly: true });
  try {
    const table = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'").get();
    if (!table) return 0;
    return (sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
  } finally {
    sqlite.close();
  }
}

if (command === "open" && path) {
  const before = appliedMigrations(path);
  openBackendDb(path).close();
  console.log(JSON.stringify({ before, after: appliedMigrations(path) }));
} else if (command === "exec" && path && statement) {
  const backendDb = openBackendDb(path);
  try {
    unsafeDb(backendDb).sqlite.run(statement);
    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    console.log(JSON.stringify({ error: (error as Error).message }));
  } finally {
    backendDb.close();
  }
} else {
  console.error("usage: db-reference.ts open <db> | exec <db> <sql>");
  process.exit(2);
}
