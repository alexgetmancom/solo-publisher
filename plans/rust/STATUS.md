# Rust port — status (2026-11-22)

Cut over on branch `rust-cutover` (one commit on top of `rust`, not pushed): the production image is built from the
Rust `Dockerfile`, the TypeScript backend is gone, and CI gates the deployment on the Rust workspace. Merging it into
`main` deploys Rust to alex (and to Maru only with `Deploy-Maru: yes`).

What still runs TypeScript: the deploy agent, its retry and the CI deploy driver with their tests (`deploy/*.ts`,
`scripts/deploy-release.ts`, the `scripts/no-network.ts` test preload), and the two Bun shims in the image
(`bun /app/ops/cli.js`, `bun /app/entrypoint/config-check.js`). Developer and CI tooling is `cargo xtask`
(`crates/xtask`): `check` (the pre-push gate), `ops-prod` (the production route) and `image-smoke`.

The remote media processor is Rust since 2026-11-24 (`crates/media_processor`, binary `media-processor`; image
`deploy/media-processor/Dockerfile`, no Bun), encoding with the recipe the Studio's local executor uses
(`crates/vertical_media`). Not yet built by CI or run on VM-106: the first image comes from the next `main` push, and
its activation there stays manual.

Tests: every live TypeScript comparison is now a committed golden recorded before the cutover under ffmpeg 6.1.1
(`crates/*/tests/*.golden.json`, the bot seeds in `parity/bot-goldens/seeds/`, `crates/db/tests/fixtures/`). Nothing
re-records them; a deliberate change edits the golden and adds a line to `DECISIONS.md`.

Known gaps: the Studio refuses to start without `CONTROLLER_BOT_TOKEN` (TypeScript ran without a bot), so a fresh
self-host install needs the bot configured before its first start; there is no local seed (`dev-seed.ts`, `bun run
demo`) yet. Fix-after-cutover TS quirks: see the crate READMEs (`Known`/`kept` sections).

Live test: `@getmantest_bot`, DB `_trash-rust/live-test/pipeline.db` (a prod copy; run WITHOUT TOKEN_ENCRYPTION_KEY so
stored platform tokens stay sealed and nothing reaches real audiences). Restart command: see `crates/app/README.md`.
