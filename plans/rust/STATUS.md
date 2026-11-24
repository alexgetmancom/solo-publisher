# Rust port — status (2026-11-24)

Production runs the Rust Studio since the cutover (`90af5830` on `main`): the image is built from the Rust
`Dockerfile`, the TypeScript backend is gone, and CI gates the deployment on the Rust workspace. A push to `main`
deploys alex, and Maru only with `Deploy-Maru: yes`.

Nothing runs TypeScript or Bun (2026-11-24): the Studio image is `debian:trixie-slim` with the Rust binaries, static
ffmpeg 6.1.1, `tini` and `ca-certificates`, and its runtime user is `studio` (uid 1000). The repository's one non-Rust
source is `install.sh`; no `package.json` or lockfile is left in the repository or in CI. The operations CLI is `ops`
on the image's PATH (`docker compose exec app ops <command>`), the healthcheck is `studio-entrypoint --ready`, and the
deploy agent is Rust (`crates/deploy_agent`, binary `deploy-agent`, shipped in the Studio image at
`/app/bin/deploy-agent`, run by both hosts). Developer and CI tooling is `cargo xtask` (`crates/xtask`): `check` (the
pre-push gate), `ops-prod` (the production route), `image-smoke`, `deploy-release` (CI's deployment) and
`family-routes` (CI's check of the adapted host proxy).

The remote media processor is Rust since 2026-11-24 (`crates/media_processor`, binary `media-processor`; image
`deploy/media-processor/Dockerfile`, no Bun), encoding with the recipe the Studio's local executor uses
(`crates/vertical_media`). Not yet built by CI or run on VM-106: the first image comes from the next `main` push, and
its activation there stays manual.

Tests: every live TypeScript comparison is now a committed golden recorded before the cutover under ffmpeg 6.1.1
(`crates/*/tests/*.golden.json`, the bot seeds in `parity/bot-goldens/seeds/`, `crates/db/tests/fixtures/`). Nothing
re-records them; a deliberate change edits the golden and adds a line to `DECISIONS.md`.

Known gaps: the Studio refuses to start without `CONTROLLER_BOT_TOKEN` (TypeScript ran without a bot), so a fresh
self-host install needs the bot configured before its first start; there is no local seed yet. Quirks kept from the
port for after the cutover: see the crate READMEs (`Known`/`kept` sections).

Live test: `@getmantest_bot`, DB `_trash-rust/live-test/pipeline.db` (a prod copy; run WITHOUT TOKEN_ENCRYPTION_KEY so
stored platform tokens stay sealed and nothing reaches real audiences). Restart command: see `crates/app/README.md`.
