# app — the `solo-publisher` binary

The Studio process (`apps/backend/src/runtime/server.ts`): configuration from the environment (`foundation::config`,
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
Stories go out through the Stories sidecar (`adapters::HttpStoriesSidecar`); without `STORIES_SIDECAR_URL` +
`STORIES_SIDECAR_TOKEN` a Story fails as "Telegram Stories sidecar is not configured".

## Environment

Required: `CONTROLLER_BOT_TOKEN`, `CONTROLLER_ADMIN_IDS`, `DATA_DIR` (the database is `$DATA_DIR/pipeline.db`).

Optional: `BIND_HOST`, `PORT`, `TELEGRAM_API_BASE_URL`, `LOG_LEVEL`, `DEPLOY_AGENT_URL` + `DEPLOY_AGENT_TOKEN`,
`STORIES_SIDECAR_URL` + `STORIES_SIDECAR_TOKEN` (Rust only; the token at least 32 characters, as the sidecar requires), `TOKEN_ENCRYPTION_KEY`,
`PUBLIC_BASE_URL`, `TELEGRAM_CHANNEL_USERNAME`, `STUDIO_ACTOR_IDS`; any other `.env` variable reads as in TypeScript.

Production (`NODE_ENV=production`, `DEPLOYMENT_ENV=production`) also requires `COMMAND_CENTER_TOKEN`,
`CLIENT_IP_HASH_SALT`, `PUBLIC_BASE_URL`.

## Run

```
cargo build --release -p app && _trash-rust/target/release/solo-publisher
```

## Container

`Dockerfile.rust` (context: the repository root, filtered by `Dockerfile.rust.dockerignore`) builds one image with
two processes, because the Studio hands the Stories sidecar file paths (a re-encoded Story sits in the Studio's temp
directory) and because the deploy agent, its rollback by digest and `docker exec` keep the one `backend` container
they know:

| Path | What |
|---|---|
| `/app/bin/solo-publisher` | this binary (`cargo build --release -p app`, rust:1.100-bookworm) |
| `/app/bin/studio-entrypoint` | `crates/entrypoint`, the container's process under `tini -g` |
| `/app/sidecar/` | `sidecars/stories` bundled by `bun build` with mtcute's WASM beside it |
| `/app/apps/backend/assets/` | Story-card background and fonts (`STORY_CARD_ASSETS_DIR`'s default) |
| `/usr/local/bin/{ffmpeg,ffprobe,bun}` | static ffmpeg 6.1.1 (as the TypeScript image), Bun 1.4.0 from the `oven/bun` slim base |

`studio-entrypoint`, started as root: creates and `chown`s the data directories (`runtime::data_dirs`, as
`docker-entrypoint.ts`), then re-executes itself through `setpriv --reuid --regid --groups` as `bun` (uid 1000),
keeping compose's `group_add` groups and dropping group 0 — the workspace forbids `unsafe`, so the syscalls are
setpriv's; the exec after them makes the drop irreversible. As `bun` it probes the directories with a write, draws a
random sidecar token, starts the Studio with `STORIES_SIDECAR_URL=http://127.0.0.1:8790` and `STORIES_SIDECAR_TOKEN`,
and the sidecar on loopback with the same token, restarting the sidecar if it dies (1 s doubling to 30 s). The
Studio's exit is the container's; `tini -g` hands SIGTERM to all three, and the entrypoint only waits.

```
docker build -f Dockerfile.rust -t solo-publisher-rust .
docker compose -f compose.yaml -f compose.rust.yaml up -d --build      # self-host, same stack, Rust app
```

`deploy/studio.rust.compose.yaml` is `deploy/studio.compose.yaml` for this image (the deploy agent's `composeFile`;
only `pids_limit` differs). The healthcheck stays `bun -e fetch('/readyz')` on 8788. Stories sign-in, once per
session: `docker exec -it -u bun <container> bun /app/sidecar/login.js`. CI (`rust`, `rust-image` in
`.github/workflows/check.yml`) builds and inspects the image without pushing it; nothing deploys it yet.
