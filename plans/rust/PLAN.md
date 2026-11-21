# Rust rewrite — plan

Inputs: `inventory.md` (whole backend), `telegram-bot-spec.md` (bot contract), `DECISIONS.md` (owner decisions).
Branch `rust`; `main` stays the production line until one cutover commit. CI deploys only from `main`
(`check.yml:290,311`), so pushes to `rust` run checks only.

## Layout

- Cargo workspace at repo root (`Cargo.toml`), crates under `crates/`:
  `foundation` (config, i18n, markdown, time, ids), `db` (SQLite, schema, triggers, leases),
  `domain` (studio, content, publishing, delivery state), `adapters` (one module per external platform),
  `bot` (Telegram UI), `http` (axum routes incl. `/api/public/site`, `/media/*`), `ops` (registry → CLI + MCP),
  `app` (binary: workers, schedulers, bot runner, HTTP server).
- Stories sidecar: the existing mtcute code moves to `sidecars/stories/` (TS, Bun), called over local HTTP.
- Build output: `_trash-rust/target` (global cargo config), never inside crates.

## Key choices

- Runtime tokio; HTTP axum; DB rusqlite (bundled SQLite, WAL, `BEGIN IMMEDIATE`), opening the SAME database file
  and schema — no data migration. Drizzle migration bookkeeping is read, not rewritten.
- Telegram: raw Bot API client (`teloxide-core` requests only) + own router, because callback_data must be
  byte-compatible with today's keyboards, including `@grammyjs/menu` encoded buttons already sitting in chats.
- i18n: Russian only (DECISIONS). The `ru` half of `catalog.ts` is exported once to `locales/ru.json` and embedded;
  same placeholders, same Russian plural rules, verified by goldens. No interface-language switch.

## Parity method for the bot (the core guarantee)

1. In the TS tree add a golden dumper: seed fixture DB (`scripts/fixtures/site-fixture.ts`) → for every screen and
   flow step in spec §10 record `{method, text, parse_mode, reply_markup}` exactly as grammY would send it.
2. Rust renders the same fixtures; a test diffs byte-for-byte against the goldens (93 screens minus the language
   screen, 50 publication actions, 13 flows, every `ru` string); goldens are recorded with the actor locale `ru`.
3. Callback replay: feed recorded callback_data (incl. menu-plugin format and stale cards) to Rust and compare
   the resulting effects.
A screen is "done" only when its golden matches.

## Phases (each ends with tests green + `cargo build --release`)

| # | Phase | TS to port | Done when |
|---|---|---|---|
| 0 | Workspace, config, i18n export, DB open + triggers + leases | ~5.7k | opens a copy of a real DB, guards pass |
| 1 | Golden dumper in TS + parity harness in Rust | new | goldens generated for all spec §10 rows |
| 2 | Domain core: studio, content, publishing read/write | ~8.1k | key invariant tests ported and green |
| 3 | Telegram bot (priority) | ~10.1k | every golden matches, callback replay green |
| 4 | Delivery + platform adapters + workers (19 loops) | ~8.0k | idempotency/lease tests green, dry-run against fixtures |
| 5 | HTTP edge + public site contract | ~1.0k | `publicSite` contract byte-identical (ETag) |
| 6 | Ops registry, CLI, MCP (68 ops, 83 tools) | ~9.3k | `guide --json` / `--help` identical structure |
| 7 | Stories sidecar wiring, Docker image, compose, cutover | infra | runs on Maru first (canary), then one cutover commit to `main` |

## Tests to port (key only)

Delivery invariants (conditional writes, retry idempotency, takedown+journal transaction), date-column guards,
bot goldens + callback freshness, public site contract, operations registry projections. Everything else is dropped.

## Bot quirks (spec §11)

Ported as-is for 1:1 (silent answer + chat message, stale hints, unreachable replies, open settings input).
Listed for fixing after cutover, not during the rewrite.
