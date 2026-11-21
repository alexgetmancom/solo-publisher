# Rust port — status (2026-11-21)

Done and merged on `rust` (local; push blocked until the GitHub token gets Workflows: write):
bot (106 goldens), domain, runtime, story_render, public_site (prod-copy byte-identical), adapters (228 request goldens),
channels + OAuth (18 scenarios), delivery (publish cycle, reconciliation, video, site; 67 scenarios), http (222
responses incl. OAuth), Telegram loops, app wiring (`crates/app`: bot + HTTP 127.0.0.1:8788 + all loops; `host.rs`),
Stories sidecar (`sidecars/stories`), `Dockerfile.rust`, compose variants, CI jobs `rust` / `rust-image`.

In progress: `ops` (registry, CLI, MCP `/api/mcp`) in worktree `_trash-rust/wt/ops`, branch `rust-ops` — check its
commits, finish, merge.

Left: ops; push + green CI (first real test of the privilege drop in `rust-image`); canary on Maru; cutover commit to
`main` (owner's explicit ok only). Fix-after-cutover TS quirks: see READMEs (`Known`/`kept` sections).

Live test: `@getmantest_bot`, DB `_trash-rust/live-test/pipeline.db` (a prod copy; run WITHOUT TOKEN_ENCRYPTION_KEY so
stored platform tokens stay sealed and nothing reaches real audiences). Restart command: see `crates/app/README.md`.
