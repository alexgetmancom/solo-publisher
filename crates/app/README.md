# app — the `solo-publisher` binary

The Studio process (`apps/backend/src/runtime/server.ts`) restricted to what is ported: configuration from the
environment (`foundation::config`, the same variables as TypeScript), the database at `PIPELINE_DB` (migrations and
date guards), and the Telegram bot on long polling (`setMyCommands` at startup). SIGINT/SIGTERM stop polling, wait for
updates in hand (10 s at most, then exit 1) and close the database. No HTTP server and no workers yet.

The boundaries that are database state run on their ported stores: Story cards (`domain::story_cards`; queued cards
wait, as the renderer is not here), reminders (`domain::notifications`; queued, not delivered without the worker), the
credential breaker, the readiness report and runtime usage (`domain::observability`, usage flushed at shutdown), the
video completion notice (`domain::delivery`). The media probe runs `ffprobe`/`ffmpeg` from `PATH`
(`runtime::ffmpeg`). Boundaries whose owner is not ported refuse with
`not available in this build: <area>` (`src/unported.rs`); the startup line `studio started` lists them under
`notInThisBuild`. Stored platform credentials (`platform_tokens`) are not applied to the configuration yet, so the
readiness report counts only what the environment sets.

## Environment

Required: `CONTROLLER_BOT_TOKEN`, `CONTROLLER_ADMIN_IDS`, `DATA_DIR` (the database is `$DATA_DIR/pipeline.db`).

Optional: `TELEGRAM_API_BASE_URL`, `LOG_LEVEL`, `DEPLOY_AGENT_URL` + `DEPLOY_AGENT_TOKEN`, `TOKEN_ENCRYPTION_KEY`,
`PUBLIC_BASE_URL`, `TELEGRAM_CHANNEL_USERNAME`, `STUDIO_ACTOR_IDS`; any other `.env` variable reads as in TypeScript.

Production (`NODE_ENV=production`, `DEPLOYMENT_ENV=production`) also requires `COMMAND_CENTER_TOKEN`,
`CLIENT_IP_HASH_SALT`, `PUBLIC_BASE_URL`.

## Run

```
cargo build --release -p app && _trash-rust/target/release/solo-publisher
```
