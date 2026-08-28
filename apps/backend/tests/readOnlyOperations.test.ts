import { describe, expect, it } from "bun:test";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { publicationTargets, publishJobs } from "../src/db/schema.js";
import { type OperationContext, operationCatalog, operationDef, runOperation } from "../src/operations/registry.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * `mutates` is the one thing every surface repeats back to whoever is driving
 * it: the CLI prints `[MUTATION]`, `guide` says "read-only", and the MCP tool
 * list carries the same catalog to an agent. Nothing checked that the flag was
 * true — a handler declared read-only could write, and the operator, the agent
 * and the mutation journal would all be told it had not.
 *
 * So every read-only operation is run against a seeded database and the
 * database is compared with itself afterwards. An operation that throws for
 * want of an argument still passes, because refusing to run is not writing;
 * what it cannot do is come back having changed a row.
 *
 * Deliberately not `PRAGMA query_only` in `runOperation`. The server process
 * shares one SQLite connection between the HTTP surface, the bot, the MCP
 * endpoint and the publish workers, so a read-only operation holding
 * `query_only` across a provider round-trip would fail a worker's settlement —
 * trading a mislabelled flag for a delivery outage.
 */

/** Tables a read-only operation is allowed to touch: they record that the read
 * happened, not what was read. Keep this list short — anything else is state
 * an operator would call a change. */
const TELEMETRY = new Set(["usage_events", "usage_aggregates", "worker_state", "credential_checks"]);

/** Arguments that get an operation past its own validation, so the run reaches
 * a handler rather than stopping at the schema. An operation with no entry is
 * still run with no arguments: it either needs none or refuses, and both are
 * answers this test accepts. */
const ARGUMENTS: Record<string, Record<string, unknown>> = {
  recent: { limit: 5 },
  find: { text: "seeded" },
  verify: { ref: "post:106" },
  timeline: { ref: "post:106" },
  "post-text": { ref: "post:106" },
  "format-support": { ref: "post:106" },
  "media-job": { id: 1 },
  "media-status": {},
  "x-analytics": {},
  "x-reach": {},
};

function snapshot(backendDb: UnsafeBackendDb): Record<string, string> {
  const sqlite = backendDb.sqlite;
  const tables = (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  const state: Record<string, string> = {};
  for (const table of tables) {
    if (TELEMETRY.has(table)) continue;
    state[table] = JSON.stringify(sqlite.prepare(`SELECT * FROM "${table}"`).all());
  }
  return state;
}

function seed(backendDb: UnsafeBackendDb): void {
  seedTextPost(backendDb, { postId: 106, draftId: 106, ru: "Сид", en: "seeded", targets: { threads_en: true } });
  backendDb.db
    .insert(publicationTargets)
    .values({
      publicationKey: "post:106",
      target: "threads_en",
      status: "published",
      externalId: "external-1",
      updatedAt: new Date().toISOString(),
    })
    .run();
  backendDb.db
    .insert(publishJobs)
    .values({
      publicationKey: "post:106",
      target: "threads_en",
      status: "published",
      payloadJson: { text_en: "seeded" },
      publishAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

function context(backendDb: UnsafeBackendDb): OperationContext {
  return {
    dbPath: ":memory:",
    config: () => loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }),
    db: () => backendDb,
    // Every read-only operation that reaches outward gets nothing back; what is
    // under test is the database, not the provider.
    fetchImpl: (async () => Response.json({}, { status: 503 })) as unknown as typeof fetch,
    actorType: "test",
  };
}

describe("operations that call themselves read-only", () => {
  const readOnly = operationCatalog()
    .filter((entry) => !entry.mutates)
    // `backup-stream` hands back a stream the caller consumes, and `guide` is
    // the one operation that runs when there is no usable database at all.
    .filter((entry) => entry.name !== "backup-stream" && entry.name !== "guide")
    .map((entry) => entry.name);

  it("covers the whole read-only half of the catalog", () => {
    expect(readOnly.length).toBeGreaterThan(15);
    for (const name of readOnly) expect(operationDef(name)?.mutates).toBe(false);
  });

  for (const name of readOnly) {
    it(`leaves the database alone: ${name}`, () =>
      withDb(async (backendDb) => {
        seed(backendDb);
        const before = snapshot(backendDb);

        await runOperation(name, context(backendDb), ARGUMENTS[name] ?? {}).catch(() => undefined);

        const after = snapshot(backendDb);
        const changed = Object.keys(before).filter((table) => before[table] !== after[table]);
        expect({ operation: name, changed }).toEqual({ operation: name, changed: [] });
      }));
  }
});
