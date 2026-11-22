# Rust port — status (2026-11-22)

Done, merged and pushed on `rust`; CI green on da1fc459 (all jobs, including `rust` and `rust-image`):
bot (106 goldens), domain, runtime, story_render, public_site (prod-copy byte-identical), adapters (228 request goldens),
channels + OAuth (18 scenarios), delivery (publish cycle, reconciliation, video, site; 67 scenarios), http (222
responses incl. OAuth), Telegram loops, app wiring (`crates/app`: bot + HTTP 127.0.0.1:8788 + all loops; `host.rs`),
Stories sidecar (`sidecars/stories`), `Dockerfile.rust`, compose variants, CI jobs `rust` / `rust-image`.

Also `ops`: 68 operations, 83 MCP tools, `/api/mcp` mounted, `/app/bin/ops` in the image behind `bun /app/ops/cli.js`
(74 scenario cases, catalog and MCP goldens). TS parity runners write their result to a file (`argv[3]`), not stdout;
ffmpeg-made fixtures are committed and JPEG `Lavc` comments are ignored, so goldens hold on any ffmpeg build.

Left: canary on Maru; cutover commit to `main` (owner's explicit ok only). Fix-after-cutover TS quirks: see READMEs (`Known`/`kept` sections).

Live test: `@getmantest_bot`, DB `_trash-rust/live-test/pipeline.db` (a prod copy; run WITHOUT TOKEN_ENCRYPTION_KEY so
stored platform tokens stay sealed and nothing reaches real audiences). Restart command: see `crates/app/README.md`.
