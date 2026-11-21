import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type BackendDb, openBackendDb, unsafeDb } from "../../apps/backend/src/db/client.js";
import { redactExternalSecrets } from "../../apps/backend/src/foundation/redact.js";
import { mcpResponse } from "../../apps/backend/src/interfaces/mcp.js";
import { flushUsage } from "../../apps/backend/src/observability/usage.js";
import { operationInput, parseArguments } from "../../apps/backend/src/operations/cli-args.js";
import { type OperationContext, OperationInputError, operationDef, runOperation } from "../../apps/backend/src/operations/registry.js";
import { loadRuntimeConfig } from "../../apps/backend/src/runtime/config.js";
import { dump } from "./scenario-support.js";

/**
 * The TypeScript side of the Rust operations scenario test (crates/ops/tests/scenarios.rs).
 * Every spec in crates/ops/tests/scenarios/<area>.json is a list of cases; each case runs on
 * a fresh database and DATA_DIR under a fixed clock, every step as its own process would
 * (a fresh database handle and configuration, usage flushed at the end), and records:
 *
 *   {"sql": "<statements>"}                         runs them; records nothing
 *   {"clock": "<ISO instant>"}                      moves the clock
 *   {"write": "<path under $CASE>", "text"|"base64": …}   writes a file
 *   {"op": "<name>", "args": {…}, "actor"?: "ops-cli"|"ops-mcp"}   runOperation → result | error
 *   {"cli": ["<command>", …], "stdin"?: "…"}       cli.ts main → stdout, stderr, exit code
 *   {"mcp": <JSON-RPC body>, "actorId"?: n|null, "client"?: "key"}   mcpResponse → response
 *   {"query": "<SELECT>"}                           → rows
 *
 * and after the steps every table (minus `ignoredTables`) as `dump` prints it, the files under
 * $CASE, and every HTTP request the operations made. HTTP is answered from the case's
 * `responses` (`{"method", "url", "status", "headers"?, "body"?: text, "json"?: value}`, each
 * served once, first match by method and exact URL); an unanswered request is a `fetch failed`
 * TypeError. `$CASE` in a step stands for the case directory, which is `$CASE` in everything recorded, and the spec's `normalize`
 * pairs (`[regex, replacement]`, over the recorded JSON text) replace what TypeScript leaves
 * nondeterministic (uuids, lease owners, durations).
 */

type Step = {
  sql?: string;
  clock?: string;
  write?: string;
  text?: string;
  base64?: string;
  op?: string;
  args?: unknown;
  actor?: string;
  cli?: string[];
  stdin?: string;
  mcp?: unknown;
  actorId?: number | null;
  client?: string;
  query?: string;
};
type Canned = { method?: string; url: string; status?: number; headers?: Record<string, string>; body?: string; json?: unknown };
type Case = { name: string; env?: Record<string, string>; responses?: Canned[]; steps: Step[] };
type Spec = {
  clock: string;
  env: Record<string, string>;
  ignoredTables?: string[];
  /** `[pattern, replacement]` applied to everything recorded, for what TypeScript itself leaves nondeterministic. */
  normalize?: [string, string][];
  setup?: string[];
  cases: Case[];
};

const repo = path.resolve(import.meta.dir, "../..");
const specs = path.join(repo, "crates/ops/tests/scenarios");
const out = path.join(repo, "parity/ops/scenarios");
const base = path.join(repo, "_trash-rust/tmp/ops-scenarios");

let nowMs = 0;
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(nowMs);
    else super(...(args as [string]));
  }
  static override now(): number {
    return nowMs;
  }
}

/** Every file under `root`, sorted, with its size and sha256. */
function files(root: string): Record<string, { bytes: number; sha256: string }> {
  const found: Record<string, { bytes: number; sha256: string }> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !/pipeline\.db(-wal|-shm|-journal)?$/.test(entry.name)) {
        const bytes = fs.readFileSync(full);
        found[path.relative(root, full)] = { bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found;
}

async function runCase(spec: Spec, testCase: Case, caseDir: string) {
  fs.rmSync(caseDir, { recursive: true, force: true });
  const dataDir = path.join(caseDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "pipeline.db");
  const env: Record<string, string> = { ...spec.env, ...testCase.env, DATA_DIR: dataDir };
  nowMs = RealDate.parse(spec.clock);
  {
    const backendDb = openBackendDb(dbPath);
    for (const sql of spec.setup ?? []) unsafeDb(backendDb).sqlite.exec(sql);
    backendDb.close();
  }
  const requests: unknown[] = [];
  const responses = JSON.parse(JSON.stringify(testCase.responses ?? []).replaceAll("$CASE", caseDir)) as Canned[];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.body ? await request.text() : null;
    const headers = Object.fromEntries([...request.headers.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    requests.push({ method: request.method, url: request.url, headers, body });
    const index = responses.findIndex((canned) => (canned.method ?? "GET") === request.method && canned.url === request.url);
    if (index < 0) throw new TypeError("fetch failed");
    const [canned] = responses.splice(index, 1);
    const payload = canned?.json !== undefined ? JSON.stringify(canned.json) : (canned?.body ?? "");
    return new Response(payload, { status: canned?.status ?? 200, headers: canned?.headers ?? {} });
  }) as typeof fetch;

  /** One process: a fresh handle and configuration, usage flushed and the handle closed after. */
  const process_ = async <T>(
    work: (backendDb: () => BackendDb, context: (actor: string) => OperationContext) => Promise<T>,
  ): Promise<T> => {
    let opened: BackendDb | null = null;
    let config: ReturnType<typeof loadRuntimeConfig> | null = null;
    const db = () => (opened ??= openBackendDb(dbPath));
    const context = (actorType: string): OperationContext => ({
      dbPath,
      config: () => (config ??= { ...loadRuntimeConfig(env, db()), PIPELINE_DB: dbPath }),
      db,
      fetchImpl: globalThis.fetch,
      actorType,
    });
    try {
      return await work(db, context);
    } finally {
      if (opened) {
        flushUsage(opened);
        (opened as BackendDb).close();
      }
    }
  };

  const outputs: unknown[] = [];
  // `$CASE` in a step (a path in SQL, an argument, a canned body) is the case directory.
  for (const step of JSON.parse(JSON.stringify(testCase.steps).replaceAll("$CASE", caseDir)) as Step[]) {
    if (step.clock !== undefined) {
      nowMs = RealDate.parse(step.clock);
      continue;
    }
    if (step.write !== undefined) {
      const target = path.join(caseDir, step.write);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, step.base64 !== undefined ? Buffer.from(step.base64, "base64") : (step.text ?? ""));
      continue;
    }
    if (step.sql !== undefined) {
      await process_(async (db) => unsafeDb(db()).sqlite.exec(step.sql as string));
      continue;
    }
    if (step.query !== undefined) {
      outputs.push({
        rows: await process_(async (db) =>
          unsafeDb(db())
            .sqlite.query(step.query as string)
            .all(),
        ),
      });
      continue;
    }
    if (step.op !== undefined) {
      outputs.push(
        await process_(async (_db, context) => {
          try {
            return { result: (await runOperation(step.op as string, context(step.actor ?? "ops-mcp"), step.args ?? {})) ?? null };
          } catch (error) {
            return {
              error: { input: error instanceof OperationInputError, message: error instanceof Error ? error.message : String(error) },
            };
          }
        }),
      );
      continue;
    }
    if (step.cli !== undefined) {
      outputs.push(await process_(async (_db, context) => runCli(step.cli as string[], context("ops-cli"), step.stdin)));
      continue;
    }
    if (step.mcp !== undefined) {
      outputs.push({
        response: await process_(async (db, context) => {
          const ctx = context("ops-mcp");
          return (
            (await mcpResponse(db(), ctx.config(), step.mcp, step.client ?? "client", step.actorId === undefined ? 42 : step.actorId)) ??
            null
          );
        }),
      });
      continue;
    }
    throw new Error(`${testCase.name}: unknown step ${JSON.stringify(step)}`);
  }
  const tables = await process_(async (db) => dump(unsafeDb(db()).sqlite, ["runtime_usage", ...(spec.ignoredTables ?? [])]));
  return { name: testCase.name, outputs, requests, tables, files: files(caseDir) };
}

/** `cli.ts` `main()` minus the process: stdout, stderr and the exit code. */
async function runCli(argv: string[], context: OperationContext, stdin: string | undefined) {
  let stdout = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  const realStdin = Bun.stdin.text;
  if (stdin !== undefined) Bun.stdin.text = async () => stdin;
  try {
    const args = parseArguments(argv);
    const def = operationDef(args.command);
    if (!def) throw new Error(`unknown command: ${args.command}`);
    const result = await runOperation(args.command, context, operationInput(args.command, args));
    if (!def.streams) {
      const format = def.format;
      stdout += `${redactExternalSecrets(format && !args.flags.has("json") ? format(result as never) : JSON.stringify(result, null, 2))}\n`;
    }
    const failedDoctor = args.command === "doctor" && result && typeof result === "object" && "ok" in result && result.ok === false;
    return { stdout, stderr: "", code: failedDoctor ? 1 : 0 };
  } catch (error) {
    return { stdout, stderr: `${redactExternalSecrets(error instanceof Error ? error.message : String(error))}\n`, code: 1 };
  } finally {
    process.stdout.write = write;
    Bun.stdin.text = realStdin;
  }
}

export async function recordScenarios(only: string[]): Promise<void> {
  globalThis.Date = FixedDate as DateConstructor;
  fs.mkdirSync(out, { recursive: true });
  const names = fs
    .readdirSync(specs)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .filter((name) => only.length === 0 || only.includes(name))
    .sort();
  for (const name of names) {
    const spec = JSON.parse(fs.readFileSync(path.join(specs, `${name}.json`), "utf8")) as Spec;
    const recorded = [];
    for (const [index, testCase] of spec.cases.entries()) {
      const caseDir = path.join(base, name, String(index));
      const result = await runCase(spec, testCase, caseDir);
      let text = JSON.stringify(result).replaceAll(caseDir, "$CASE");
      for (const [pattern, replacement] of spec.normalize ?? []) text = text.replace(new RegExp(pattern, "g"), replacement);
      recorded.push(JSON.parse(text));
    }
    fs.writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(recorded, null, 2)}\n`);
    console.log(`ops scenarios ${name}: ${recorded.length} cases`);
  }
  globalThis.Date = RealDate;
}
