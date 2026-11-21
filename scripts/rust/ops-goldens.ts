import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createApiHandler } from "../../apps/backend/src/api.js";
import { openBackendDb } from "../../apps/backend/src/db/client.js";
import { loadConfig, withStudioProfile } from "../../apps/backend/src/foundation/config.js";
import { mcpResponse } from "../../apps/backend/src/interfaces/mcp.js";
import { inputJsonSchema, operationCatalog, operationDef, operationUsageKeys } from "../../apps/backend/src/operations/registry.js";
import { recordScenarios } from "./ops-scenarios.js";

/**
 * The TypeScript side of the Rust operations parity tests (crates/ops/tests/{catalog,scenarios}.rs).
 *
 *   bun scripts/rust/ops-goldens.ts                     writes parity/ops/catalog.json and every scenario
 *   bun scripts/rust/ops-goldens.ts scenarios [area…]   only parity/ops/scenarios/<area>.json (see ops-scenarios.ts)
 *
 * Recorded: the catalog every surface projects (usage lines, sections, notes), every
 * operation's input JSON Schema, the MCP `tools/list` answer, the usage keys, and the CLI
 * as a process — `--help`, every `guide` view as text and JSON under several launcher
 * environments, and the dispatcher's own refusals — with stdout, stderr and the exit code.
 * Paths are `$TMP` (the scratch directory this script fills). `parity/ops/http.json` is the MCP
 * transport through the Hono app (`createApiHandler`): every request's status, headers and body
 * (for the SSE stream, its first event), replayed by crates/http/tests/mcp.rs.
 */

if (process.argv[2] === "scenarios") {
  await recordScenarios(process.argv.slice(3));
  process.exit(0);
}

const repo = path.resolve(import.meta.dir, "../..");
const out = path.join(repo, "parity/ops");
const tmp = path.join(repo, "_trash-rust/tmp/ops-goldens");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
fs.mkdirSync(path.join(tmp, "dir.db"), { recursive: true });
fs.mkdirSync(out, { recursive: true });

const dbPath = path.join(tmp, "data/pipeline.db");
const backendDb = openBackendDb(dbPath);
const config = withStudioProfile(loadConfig({ DATA_DIR: path.join(tmp, "data"), PUBLIC_BASE_URL: "https://studio.example" }), backendDb);

const normalize = (value: string): string => value.replaceAll(tmp, "$TMP");

const schemas = Object.fromEntries(
  operationCatalog().flatMap((entry) => {
    const def = operationDef(entry.name);
    return def ? [[entry.name, inputJsonSchema(def.schema)]] : [];
  }),
);
const toolsList = await mcpResponse(backendDb, config, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "client", 1);
const toolsListAnonymous = await mcpResponse(backendDb, config, { jsonrpc: "2.0", id: 2, method: "tools/list" }, "client", null);
backendDb.close();

type Run = { argv: string[]; env: Record<string, string>; stdout: string; stderr: string; code: number | null };

/** The CLI as a process, from an empty working directory so no `.env.local` is found. */
function run(argv: string[], env: Record<string, string> = {}): Run {
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const result = spawnSync("bun", [path.join(repo, "apps/backend/src/cli.ts"), ...argv], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: path.join(tmp, "data"), ...env },
    encoding: "utf8",
  });
  return { argv: argv.map(normalize), env, stdout: normalize(result.stdout), stderr: normalize(result.stderr), code: result.status };
}

const launcher = { OPS_INVOCATION: "bun run ops:prod --as maru", OPS_INSTANCE: "maru", OPS_INSTANCES: "alex,maru" };
const missing = ["--db", path.join(tmp, "absent/pipeline.db")];
const directory = ["--db", path.join(tmp, "dir.db")];
const runs: Run[] = [
  run(["help"]),
  run(["--help"]),
  run([]),
  run(["guide"]),
  run(["guide", "--json"]),
  run(["guide", "--all", "--json"]),
  ...["health", "delivery", "media", "channels", "studio", "host"].map((section) => run(["guide", "--section", section, "--json"])),
  run(["guide", "--section", "delivery"]),
  run(["guide", "--all"]),
  run(["guide", "--json", ...missing]),
  run(["guide", ...missing]),
  run(["guide", "--json", ...directory]),
  run(["guide", "--json"], launcher),
  run(["guide", "--section", "health"], { ...launcher, ...{ OPS_SSH_TARGET: "studio-host" } }),
  run(["guide", "--json", ...missing], { OPS_SSH_TARGET: "  " }),
  run(["guide", "--json", ...missing], { OPS_INSTANCES: "alex" }),
  run(["guide", "--section", "nowhere"]),
  run(["guide", "--all=true", "--json"]),
  run(["guide", "--all", "true"]),
  run(["guide", "stray"]),
  run(["guide", "--bogus", "--json"]),
  run(["guide", "--bogus", "value", "--other"]),
  run(["nonexistent"]),
  run(["toString"]),
  run(["recent", "10"]),
  run(["recent", "--limit"]),
  run(["recent", "--limit", "abc"]),
  run(["recent", "--limit", "0"]),
  run(["recent", "--limit", "2.5"]),
  run(["events", "--since", "34Z"]),
  run(["events", "--severity", "fatal"]),
  run(["retry", "--ref", "   "]),
  run(["retry", "--ref", "post:1", "--target="]),
  run(["publish", "--locale", "ru", "--targets", " , ", "--text", "x"]),
  run(["publish", "--locale", "de", "--targets", "x", "--text", "x"]),
  run(["video-script", "--ref", "post:1", "--text", "x", "--source", "dream"]),
  run(["doctor", "--json", "--db", path.join(tmp, "doctor/pipeline.db")]),
];

type HttpReq = { method?: string; target: string; headers?: [string, string][]; body?: string };
const MCP_TOKEN = "studio-token-for-tests-0001";
const bearer = (token = MCP_TOKEN): [string, string] => ["authorization", `Bearer ${token}`];
const rpc = (body: unknown, auth = true): HttpReq => ({
  method: "POST",
  target: "/api/mcp",
  headers: [["content-type", "application/json"], ...(auth ? [bearer()] : [])],
  body: typeof body === "string" ? body : JSON.stringify(body),
});
async function recordHttp() {
  const dataDir = path.join(tmp, "http");
  fs.mkdirSync(dataDir, { recursive: true });
  const httpDb = openBackendDb(path.join(dataDir, "pipeline.db"));
  const env = { DATA_DIR: dataDir, PUBLIC_BASE_URL: "https://studio.example.com/", MCP_STUDIO_TOKEN: MCP_TOKEN, MCP_STUDIO_ACTOR_ID: "7" };
  const handler = createApiHandler({ config: withStudioProfile(loadConfig(env), httpDb), backendDb: httpDb });
  const requests: HttpReq[] = [
    { target: "/api/mcp" },
    { target: "/api/mcp", headers: [bearer("wrong-token-wrong-token-00")] },
    { target: "/api/mcp", headers: [bearer()] },
    { target: "/api/mcp/", headers: [bearer()] },
    rpc("{not json"),
    rpc("null"),
    rpc(""),
    rpc({ jsonrpc: "2.0", method: "notifications/initialized" }),
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, false),
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, false),
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "studio_locale", arguments: {} } }, false),
    rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "studio_locale", arguments: {} } }),
    rpc([
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ops_recent", arguments: { limit: 0 } } },
      { jsonrpc: "2.0", method: "x" },
    ]),
    rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "submit_feedback", arguments: { message: "hi" } } }, false),
    { method: "PUT", target: "/api/mcp", headers: [bearer()] },
  ];
  const recorded = [];
  for (const req of requests) {
    const response = await handler(
      new Request(`http://localhost${req.target}`, {
        method: req.method ?? "GET",
        headers: req.headers ?? [],
        ...(req.body === undefined ? {} : { body: req.body }),
      }),
    );
    const headers = Object.fromEntries([...response.headers.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    let body: string | null = null;
    if (response.headers.get("content-type") === "text/event-stream" && response.body) {
      const reader = response.body.getReader();
      const first = await reader.read();
      await reader.cancel();
      body = new TextDecoder().decode(first.value).replace(/connection_id=[0-9a-f-]{36}/, "connection_id=$UUID");
    } else body = response.body ? await response.text() : null;
    recorded.push({ request: req, status: response.status, headers, body });
  }
  httpDb.close();
  fs.writeFileSync(path.join(out, "http.json"), `${JSON.stringify(recorded, null, 2)}\n`);
}
await recordHttp();

const catalog = {
  catalog: operationCatalog(),
  usageKeys: operationUsageKeys(),
  schemas,
  toolsList,
  toolsListAnonymous,
  runs,
};
fs.writeFileSync(path.join(out, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`ops goldens: ${operationCatalog().length} operations, ${runs.length} runs`);
await recordScenarios([]);
