# ops — the operations registry, the `ops` CLI and the Studio MCP server (Rust)

One table of operations (`registry.rs`); the CLI dispatch, `--help`, the `guide` catalogs and the `ops_*` MCP tools
are projections of it.

| Module | Holds |
|---|---|
| `registry.rs` | `OperationDef`, `run_operation`, catalog, usage lines, mutation journal |
| `schema.rs` | field builders: parse/coerce/transform + JSON Schema output (`io: "input"`), key order included |
| `guide.rs` | the `guide` catalog and routing |
| `cli.rs`, `main.rs` | the binary `ops` and its argument parsing |
| `context.rs` | `OperationContext`, `Surface`, `Terminal`, `Input`, `OpError` |
| `host.rs` | `ProcessSurface`, `OpsHost`, `OpsAdapters`, `ProcessTerminal`: the services built inside the CLI process |
| `mcp.rs` | `McpServer::respond`, 39 `studio_*` tools, `ops_*` projection, `submit_feedback` |
| `handlers/{reads,commands,lifecycle,media,admin}.rs` | the operation handlers, by area |

## Adding an operation

One `op(...)` entry in `definitions()` (catalog order is the order operators see) and its handler
`fn(&OperationContext, &Input) -> Fut<OpResult>` in the area's handler module. Results are `serde_json::Value` in
the goldens' key order; `run_operation` prints integral floats as JavaScript does (`js_numbers`).

## Surfaces

- CLI: `ops <command> --flag value [--db PATH] [--json]`, what `cargo xtask ops-prod` runs through `docker exec` and a
  self-hosted Studio as `docker compose exec app ops`. Each run opens the database and configuration on first use
  (`ProcessSurface`), flushes usage and closes on exit. The publish doorbell rings nothing in this process (the worker
  lives in the Studio and polls).
- MCP: `crates/http/src/mcp.rs` mounts `GET`/`POST /api/mcp` and implements `Surface` over the server's `Backend`
  (its database, live configuration and boundaries).

## Goldens

```
cargo test -p ops                               # catalog.rs (catalog, schemas, tools/list, the binary as a process)
                                                # scenarios.rs (OPS_SCENARIOS=area,… limits it)
cargo test -p http_edge --test mcp              # the transport through the router (oneshot)
```

The goldens in `parity/ops/` are the contract; nothing re-records them.
`scenarios.rs` replays `tests/scenarios/<area>.json` on a fresh
database per case under a fixed clock, each step as its own process, with canned HTTP; compared: every output (key
order included), request, table and file.
