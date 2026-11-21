import { setSystemTime } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBackendDb, type UnsafeBackendDb, unsafeDb } from "../../apps/backend/src/db/client.js";
import { type BackendConfig, loadConfig, withStudioProfile } from "../../apps/backend/src/foundation/config.js";
import { dump, resolve } from "./scenario-support.js";

/**
 * What every delivery scenario runner shares with its Rust counterpart
 * (crates/delivery/tests/support/mod.rs). A scenario runs on a fresh in-memory
 * database under a fixed clock and a fixed `Math.random`, with every HTTP call
 * — `fetchImpl` arguments and the global `fetch` alike — going to a recorder
 * that answers the scenario's canned responses in order. A canned response may
 * carry `sql`, run on the database the moment the request is served: a lease
 * taken over, a target edited while the provider was being asked. `$DATA` in
 * a step's SQL or arguments is the scenario's data directory, which is the same
 * path on both sides (the runs are sequential), so content hashes of paths agree.
 *
 * The output is every step's result, every request as it went out, and every
 * non-empty table. Credentials appear as `{{NAME}}`, the scenario's data
 * directory as `$DATA`, and lease owners as `$HOST` / `$PID` / `$UUID`, so
 * both sides record the same text.
 *
 *   {"clock": "<ISO>"} | {"sql": "<statement>"} | {"call": "<name>", "args": [...], "bind"?: "<name>"}
 */

export type Canned = { status: number; headers?: [string, string][]; body?: string; sql?: string } | { throws: string; sql?: string };
type Step = { clock?: string; sql?: string; call?: string; args?: unknown[]; bind?: string };
type Scenario = {
  name: string;
  env?: Record<string, string | null>;
  files?: Record<string, { fill: string; size: number } | { ffmpeg: string[] }>;
  responses?: Canned[];
  steps: Step[];
};
export type Spec = {
  clock: string;
  jitter: number;
  env: Record<string, string>;
  credentials: Record<string, string>;
  ignoredTables: string[];
  setup: string[];
  beforeDump: string[];
  scenarios: Scenario[];
};
export type Context = { backendDb: UnsafeBackendDb; config: BackendConfig; fetchImpl: typeof fetch; data: string };
export type Call = (context: Context, name: string, args: unknown[]) => Promise<unknown>;

const root = path.join(import.meta.dir, "../..");
const SECRET_NAME = /TOKEN|SECRET|KEY/;
const MAX_TEXT_BODY = 16 * 1024;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const sha256 = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

function scrubber(spec: Spec, data: string): (value: string) => string {
  const secrets = Object.entries({ ...spec.env, ...spec.credentials })
    .filter(([name, value]) => SECRET_NAME.test(name) && value.length >= 6)
    .sort((left, right) => right[1].length - left[1].length);
  return (value) => {
    let text = value.replaceAll(data, "$DATA");
    for (const [name, secret] of secrets) text = text.replaceAll(secret, `{{${name}}}`);
    // Lease owners name this host, this process and a random UUID.
    text = text.replaceAll(`:${os.hostname()}:${process.pid}`, ":$HOST").replaceAll(`${process.pid}:`, "$PID:");
    return text.replace(UUID, "$UUID");
  };
}

function scrubDeep(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item, scrub)]));
  return value;
}

function bytesShape(bytes: Uint8Array, scrub: (text: string) => string): Record<string, unknown> {
  if (bytes.length <= MAX_TEXT_BODY) {
    try {
      return { text: scrub(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
    } catch {
      // Not text: recorded by digest below.
    }
  }
  return { size: bytes.length, sha256: sha256(bytes) };
}

function multipartParts(bytes: Uint8Array, boundary: string, scrub: (text: string) => string): unknown[] {
  const body = Buffer.from(bytes);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = body.indexOf(delimiter) + delimiter.length;
  while (start >= delimiter.length && body.subarray(start, start + 2).toString() === "\r\n") {
    const end = body.indexOf(delimiter, start);
    const part = body.subarray(start + 2, end - 2);
    const split = part.indexOf("\r\n\r\n");
    parts.push({ headers: part.subarray(0, split).toString().split("\r\n").map(scrub), ...bytesShape(part.subarray(split + 4), scrub) });
    start = end + delimiter.length;
  }
  return parts;
}

function recorder(backendDb: UnsafeBackendDb, responses: Canned[], scrub: (text: string) => string) {
  const requests: unknown[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const boundary = request.headers.get("content-type")?.match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
    const bytes = new Uint8Array(await request.arrayBuffer());
    requests.push({
      method: request.method,
      url: scrub(request.url),
      headers: [...request.headers].map(([name, value]) => [
        name,
        boundary && name === "content-type" ? "multipart/form-data" : scrub(value),
      ]),
      body: boundary ? { parts: multipartParts(bytes, boundary, scrub) } : bytesShape(bytes, scrub),
    });
    const next = queue.shift();
    if (!next) throw new TypeError("no canned response left");
    if (next.sql) unsafeDb(backendDb).sqlite.run(next.sql);
    if ("throws" in next) throw new TypeError(next.throws);
    return new Response(next.body ?? "", { status: next.status, headers: next.headers ?? [] });
  }) as typeof fetch;
  return { requests, fetchImpl, unused: () => queue.length };
}

/** The files a scenario starts with: filler bytes, or what ffmpeg makes. */
function writeFiles(data: string, at: Date, files: Scenario["files"] = {}): void {
  for (const [name, spec] of Object.entries(files)) {
    const target = path.join(data, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if ("fill" in spec) fs.writeFileSync(target, spec.fill.repeat(spec.size));
    else {
      const made = Bun.spawnSync(["ffmpeg", "-loglevel", "error", ...spec.ffmpeg, target]);
      if (made.exitCode !== 0) throw new Error(`ffmpeg could not make ${name}: ${made.stderr.toString()}`);
    }
    // Freshness is read from mtimes: every input is as old as the spec's clock.
    fs.utimesSync(target, at, at);
  }
}

/** `$DATA` in a step's arguments is the scenario's data directory. */
function withData(value: unknown, data: string): unknown {
  if (typeof value === "string") return value.replaceAll("$DATA", data);
  if (Array.isArray(value)) return value.map((item) => withData(item, data));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withData(item, data)]));
  return value;
}

function errorResult(error: unknown): unknown {
  return { error: error instanceof Error ? error.message : String(error) };
}

async function run(spec: Spec, scenario: Scenario, call: Call, label: string): Promise<unknown> {
  setSystemTime(new Date(Date.parse(spec.clock)));
  const data = path.join(root, "_trash-rust/tmp/delivery-scenarios", label, scenario.name);
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(data, { recursive: true });
  writeFiles(data, new Date(Date.parse(spec.clock)), scenario.files);
  const env: Record<string, string> = { ...spec.env, DATA_DIR: data };
  for (const [key, value] of Object.entries(scenario.env ?? {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  const scrub = scrubber(spec, data);
  const backendDb = openBackendDb(":memory:") as UnsafeBackendDb;
  const { sqlite } = unsafeDb(backendDb);
  const { requests, fetchImpl, unused } = recorder(backendDb, scenario.responses ?? [], scrub);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const vars: Record<string, unknown> = {};
  const results: { call: string; result: unknown }[] = [];
  try {
    for (const statement of spec.setup) sqlite.run(statement);
    for (const step of scenario.steps) {
      if (step.clock !== undefined) setSystemTime(new Date(Date.parse(step.clock)));
      else if (step.sql !== undefined) sqlite.run(step.sql.replaceAll("$DATA", data));
      else if (step.call !== undefined) {
        const config = { ...withStudioProfile(loadConfig(env), backendDb), ...spec.credentials } as BackendConfig;
        let result: unknown;
        try {
          const value = await call(
            { backendDb, config, fetchImpl, data },
            step.call,
            withData(resolve(step.args ?? [], vars), data) as unknown[],
          );
          if (step.bind) vars[step.bind] = value;
          result = value === undefined ? null : value;
        } catch (error) {
          result = errorResult(error);
        }
        results.push({ call: step.call, result });
      } else throw new Error(`step without clock, sql or call in ${scenario.name}`);
    }
    for (const statement of spec.beforeDump) sqlite.run(statement);
    const tables = Object.fromEntries(Object.entries(dump(sqlite, spec.ignoredTables)).map(([table, rows]) => [table, rows.map(scrub)]));
    return JSON.parse(
      JSON.stringify({ name: scenario.name, results: scrubDeep(results, scrub), requests, unusedResponses: unused(), tables }),
    ) as unknown;
  } finally {
    globalThis.fetch = realFetch;
    backendDb.close();
  }
}

/** Every file under the data directory, relative and sorted: what a call left on disk. */
export function listFiles(data: string): string[] {
  return (fs.readdirSync(data, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(data, path.join(entry.parentPath, entry.name)))
    .sort();
}

/** Runs every scenario of the spec at `argv[2]` and prints the outcomes as JSON. */
export async function runScenarios(label: string, call: Call): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error(`usage: ${label}-scenarios.ts <spec.json>`);
    process.exit(2);
  }
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as Spec;
  Math.random = () => spec.jitter;
  const scenarios = [];
  for (const scenario of spec.scenarios) scenarios.push(await run(spec, scenario, call, label));
  console.log(JSON.stringify({ scenarios }));
}
