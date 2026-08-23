import path from "node:path";
import { type BackendDb, openBackendDb } from "./db/client.js";
import type { BackendConfig } from "./foundation/config.js";
import { operationInput, parseArguments } from "./operations/cli-args.js";
import { type OperationContext, operationCatalog, operationDef, runOperation } from "./operations/registry.js";
import { loadRuntimeConfig } from "./runtime/config.js";

const CLI_ACTOR = "ops-cli";

function printHelp(): void {
  const lines = operationCatalog().map((entry) => `${entry.mutates ? "[MUTATION] " : "           "}${entry.usage}`);
  console.log(
    ["solo-publisher backend operations", "", ...lines, "", "--db PATH overrides the database; --json prints the raw result."].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(args.command)) {
    printHelp();
    return;
  }
  const dbPath = args.values.get("db") ?? path.join(process.env.DATA_DIR ?? "/data", "pipeline.db");
  const def = operationDef(args.command);
  if (!def) throw new Error(`unknown command: ${args.command}`);
  // Held in a cell so the lazy accessors can fill them in without TypeScript
  // losing the type across the closure boundary.
  const opened: { db: BackendDb | null; config: BackendConfig | null } = { db: null, config: null };
  const context: OperationContext = {
    dbPath,
    // The Studio's own settings live in its database, so asking for the
    // configuration opens it. Both stay lazy: `help` touches neither.
    config: () => (opened.config ??= { ...loadRuntimeConfig(process.env, context.db()), PIPELINE_DB: dbPath }),
    db: () => (opened.db ??= openBackendDb(dbPath)),
    fetchImpl: fetch,
    actorType: CLI_ACTOR,
  };
  try {
    const result = await runOperation(args.command, context, operationInput(args.command, args));
    const format = def.format;
    // A streaming operation has already written its bytes to stdout. Printing a
    // summary after them would append JSON to an archive.
    if (!def.streams) console.log(format && !args.flags.has("json") ? format(result as never) : JSON.stringify(result, null, 2));
    if (args.command === "doctor" && result && typeof result === "object" && "ok" in result && result.ok === false) process.exitCode = 1;
  } finally {
    opened.db?.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
