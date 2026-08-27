import type { UnsafeBackendDb } from "../../src/db/client.js";
import { installDateGuards } from "../../src/db/date-guards.js";

/** Plants rows the database would refuse today, the way they arrived before it
 * refused them. The integrity check and its repair exist for exactly those, so
 * their tests have to be able to write one. */
export function withoutDateGuards(backendDb: UnsafeBackendDb, write: () => void): void {
  const triggers = (
    backendDb.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'date_guard_%'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  for (const name of triggers) backendDb.sqlite.run(`DROP TRIGGER IF EXISTS "${name}"`);
  try {
    write();
  } finally {
    installDateGuards(backendDb.sqlite);
  }
}
