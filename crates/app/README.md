# app — the `solo-publisher` binary

The Studio process (`apps/backend/src/runtime/server.ts`) restricted to what is ported: configuration from the
environment (`foundation::config`, the same variables as TypeScript), the database at `PIPELINE_DB` (migrations and
date guards), the Telegram bot on long polling (`setMyCommands` at startup), the workers below and the HTTP surface
(`http_edge`, every route but MCP) on `BIND_HOST:PORT` (default `127.0.0.1:8788`, as TypeScript). The port is bound
before polling starts, so a taken one fails the process at once; `studio listening` logs the address.

SIGINT/SIGTERM stop in `server.ts`'s order: HTTP stops accepting and answers the requests in flight, polling stops, the
loops stop, updates in hand finish, the database closes; all of it within 10 s, else exit 1.

Workers (`src/workers.rs`, `runtime/workers.ts` + `interfaces/telegram/worker.ts`): story-cards, notifications and the
Telegram loops (`bot::workers`: translations, albums, events, alerts, daily backup), each with its heartbeat row and the
usage flush; channels (`platform-tokens`, `credentials` — stored tokens applied to the live config — `x-token`) and
`observability`. Publishing, video and site loops come with the delivery slice. Connect links and the Zernio directory
are `channels`; the provider calls (`post_outcome`, Reels, YouTube privacy) are `adapters::providers`.

The boundaries that are database state run on their ported stores: Story cards (`domain::story_cards`; queued cards
wait, as the renderer is not here), reminders (`domain::notifications`; queued, not delivered without the worker), the
credential breaker, the readiness report and runtime usage (`domain::observability`, usage flushed at shutdown), the
video completion notice (`domain::delivery`). The media probe runs `ffprobe`/`ffmpeg` from `PATH`
(`runtime::ffmpeg`). Boundaries whose owner is not ported refuse with
`not available in this build: <area>` (`src/unported.rs`); the startup line `studio started` lists them under
`notInThisBuild`.

## Environment

Required: `CONTROLLER_BOT_TOKEN`, `CONTROLLER_ADMIN_IDS`, `DATA_DIR` (the database is `$DATA_DIR/pipeline.db`).

Optional: `BIND_HOST`, `PORT`, `TELEGRAM_API_BASE_URL`, `LOG_LEVEL`, `DEPLOY_AGENT_URL` + `DEPLOY_AGENT_TOKEN`, `TOKEN_ENCRYPTION_KEY`,
`PUBLIC_BASE_URL`, `TELEGRAM_CHANNEL_USERNAME`, `STUDIO_ACTOR_IDS`; any other `.env` variable reads as in TypeScript.

Production (`NODE_ENV=production`, `DEPLOYMENT_ENV=production`) also requires `COMMAND_CENTER_TOKEN`,
`CLIENT_IP_HASH_SALT`, `PUBLIC_BASE_URL`.

## Run

```
cargo build --release -p app && _trash-rust/target/release/solo-publisher
```
