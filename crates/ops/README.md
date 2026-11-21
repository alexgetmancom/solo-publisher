# ops — the operations registry, the `ops` CLI and the Studio MCP server (Rust)

Port of `apps/backend/src/operations/*`, `cli.ts` and `interfaces/mcp.ts`. One table of operations
(`registry.rs`); the CLI dispatch, `--help`, the `guide` catalogs and the `ops_*` MCP tools are projections of it.

| Module | TypeScript |
|---|---|
| `registry.rs` (`OperationDef`, `run_operation`, catalog, usage lines, mutation journal) | `operations/registry.ts` |
| `schema.rs` (zod-equivalent field builders: parse/coerce/transform + `toJSONSchema(io: "input")`, key order included) | the zod schemas of `registry.ts` and `mcp.ts` |
| `guide.rs` | `operations/guide.ts` |
| `cli.rs`, `main.rs` (binary `ops`) | `cli.ts`, `operations/cli-args.ts` |
| `context.rs` (`OperationContext`, `Surface`, `Terminal`, `Input`, `OpError`) | `OperationContext` |
| `host.rs` (`ProcessSurface`, `OpsHost`, `OpsAdapters`, `ProcessTerminal`) | what `createStudioServices` built inside the CLI process |
| `mcp.rs` (`McpServer::respond`, 39 `studio_*` tools, `ops_*` projection, `submit_feedback`) | `interfaces/mcp.ts`, `mcp-protocol.ts` |
| `handlers/{reads,commands,lifecycle,media,admin}.rs` | the handler modules of `operations/*` |

## Adding an operation

One `op(...)` entry in `definitions()` (catalog order = TypeScript order) and its handler
`fn(&OperationContext, &Input) -> Fut<OpResult>` in the area's handler module. Results are `serde_json::Value` in
TypeScript key order; `run_operation` prints integral floats as JavaScript does (`js_numbers`).

## Surfaces

- CLI: `ops <command> --flag value [--db PATH] [--json]`, the argv contract of `bun /app/ops/cli.js` (what
  `scripts/ops-prod.ts` runs through `docker exec`). Each run opens the database and configuration on first use
  (`ProcessSurface`), flushes usage and closes on exit. The publish doorbell rings nothing in this process (the worker
  lives in the Studio and polls), as in TypeScript.
- MCP: `crates/http/src/mcp.rs` mounts `GET`/`POST /api/mcp` and implements `Surface` over the server's `Backend`
  (its database, live configuration and boundaries).

## Parity

```
bun scripts/rust/ops-goldens.ts                 # parity/ops/{catalog,http}.json + every scenario
bun scripts/rust/ops-goldens.ts scenarios AREA  # parity/ops/scenarios/AREA.json only
cargo test -p ops                               # catalog.rs (catalog, schemas, tools/list, the binary as a process)
                                                # scenarios.rs (OPS_SCENARIOS=area,… limits it)
cargo test -p http_edge --test mcp              # the transport through the router (oneshot)
```

`scenarios.rs` replays `tests/scenarios/<area>.json` (spec format: `scripts/rust/ops-scenarios.ts`) on a fresh
database per case under a fixed clock, each step as its own process, with canned HTTP; compared: every output (key
order included), request, table and file.
