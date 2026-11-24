# app — the `solo-publisher` binary

The Studio process: configuration from the environment (`foundation::config`,
the same variables as TypeScript), the database at `PIPELINE_DB` (migrations and date guards), the Telegram bot on
long polling (`setMyCommands` at startup), the workers below and the HTTP surface (`http_edge`, every route but MCP)
on `BIND_HOST:PORT` (default `127.0.0.1:8788`, as TypeScript). The port is bound before polling starts, so a taken one
fails the process at once; `studio listening` logs the address.

SIGINT/SIGTERM stop in `server.ts`'s order: HTTP stops accepting and answers the requests in flight, polling stops, the
loops stop, the doorbells are unhooked, updates in hand finish, the database closes; all of it within 10 s, else exit 1.

## Workers (`src/workers.rs`)

`runtime/workers.ts` + `interfaces/telegram/worker.ts`, each loop with its heartbeat row and the usage flush. At
startup the locks a previous process left are taken back after a 30 s grace (publish jobs, site jobs), then Story-card
locks. In TypeScript's order:

| Loop | Interval | Body |
|---|---|---|
| `platform-tokens`, `credentials`, `x-token` | 6 h, 60 s, 10 min | `channels::loops` |
| `story-cards` | `IDLE_POLL_INTERVAL_SECONDS` | `story_render::run_story_card_cycle` |
| `queue` | `IDLE_POLL_INTERVAL_SECONDS`, rung by `WorkerQueue::Publish` | `delivery::publish_workflow::run_delivery_publish_cycle` |
| `publish-watchdog` | 60 s | `recover_stale_publish_jobs` |
| `publication-reconciliation` | `max(60, IDLE_POLL)` s | `run_publication_reconciliation` |
| `notifications` | `IDLE_POLL_INTERVAL_SECONDS` | `domain::notifications::run_notification_cycle` |
| `video` | `IDLE_POLL_INTERVAL_SECONDS` | `delivery::video_worker::run_video_cycle` |
| `site`, `site-watchdog` | 10 s, 60 s; idle while the site is off | `run_site_job_cycle`, `recover_stale_site_jobs` |
| `media-cache` | 1 h | `prune_media_cache` |
| `operational-retention` | 24 h | `prune_operational_history` under the maintenance lock |
| `observability` | `OBSERVABILITY_INTERVAL_SECONDS` | `channels::loops::observability_tick` |

then the Telegram loops (`bot::workers`: translations, albums, events, alerts, daily backup).

## Host (`src/host.rs`)

The boundaries are the ported stores: Story cards (`domain::story_cards`), reminders (`domain::notifications`), the
credential breaker, the readiness report and runtime usage (`domain::observability`, usage flushed at shutdown), the
video completion notice (`domain::delivery`), connect links (`channels`). One `delivery::story_derivatives::DeliveryMedia`
is both the publish loop's `MediaPreparation` and Studio's `StoryDerivatives`; the worker bell is
`runtime::worker_signal::WorkerSignals`. The adapters Studio waits on: the media probe runs `ffprobe`/`ffmpeg` from
`PATH`, the provider calls are `adapters::providers`, the Zernio directory is `channels::zernio`. Telegram channel
Stories go out over MTProto in this process (`mtproto::MtprotoStories`, with the `TELEGRAM_CHANNEL_STORIES_*` of the
live configuration).

## Environment

Required: `CONTROLLER_BOT_TOKEN`, `CONTROLLER_ADMIN_IDS`, `DATA_DIR` (the database is `$DATA_DIR/pipeline.db`).

Optional: `BIND_HOST`, `PORT`, `TELEGRAM_API_BASE_URL`, `LOG_LEVEL`, `DEPLOY_AGENT_URL` + `DEPLOY_AGENT_TOKEN`,
`TOKEN_ENCRYPTION_KEY`,
`PUBLIC_BASE_URL`, `TELEGRAM_CHANNEL_USERNAME`, `STUDIO_ACTOR_IDS`; any other `.env` variable reads as in TypeScript.

Production (`NODE_ENV=production`, `DEPLOYMENT_ENV=production`) also requires `COMMAND_CENTER_TOKEN`,
`CLIENT_IP_HASH_SALT`, `PUBLIC_BASE_URL`.

## Run

```
cargo build --release -p app && _trash-rust/target/release/solo-publisher
```

## Container

`Dockerfile` (context: the repository root, filtered by `Dockerfile.dockerignore`) builds one image, one process
(the Studio) in one `backend` container, the one the deploy agent, its rollback by digest and `docker exec` know:

| Path | What |
|---|---|
| `/app/bin/solo-publisher` | this binary (`cargo build --release -p app`, rust:1.100-bookworm) |
| `/app/bin/studio-entrypoint` | `crates/entrypoint`, the container's process under `tini -g`; `--check-config` only loads the configuration |
| `/app/bin/ops` | the operations CLI: `cargo xtask ops-prod` runs it directly, a self-hosted Studio behind `bun /app/ops/cli.js` |
| `/app/bin/deploy-agent` | `crates/deploy_agent`, static (musl); never runs here: each deployment copies it onto the host (`deploy/README.md`) |
| `/app/entrypoint/config-check.js` | `studio-entrypoint --check-config`, which the TypeScript deploy agent runs on a new image before swapping it in, until a host switches to the binary (that runs `studio-entrypoint --check-config` as the entrypoint) |
| `/app/assets/story-card/` | Story-card background and fonts (`STORY_CARD_ASSETS_DIR`'s default) |
| `/usr/local/bin/{ffmpeg,ffprobe,bun}` | static ffmpeg 6.1.1, Bun 1.4.0 from the `oven/bun` slim base |

`studio-entrypoint`, started as root: creates and `chown`s the data directories (`runtime::data_dirs`, as
`docker-entrypoint.ts`), then re-executes itself through `setpriv --reuid --regid --groups` as `bun` (uid 1000),
keeping compose's `group_add` groups and dropping group 0 — the workspace forbids `unsafe`, so the syscalls are
setpriv's; the exec after them makes the drop irreversible. As `bun` it probes the directories with a write and
replaces itself with the Studio, which `tini -g` then hands SIGTERM directly; the Studio's exit is the container's.

```
docker build -t solo-publisher .
cargo xtask image-smoke solo-publisher   # what CI checks on every image it builds
```

The healthcheck is `bun -e fetch('/readyz')` on 8788. Stories sign-in, once per session:
`docker compose exec -it app bun /app/ops/cli.js telegram-stories-login`. CI builds the image on every push (`image-check`); on
`main` it builds both architectures, inspects each with `cargo xtask image-smoke`, and deploys
(`backend-image` → `deploy`).
