# app — the `solo-publisher` binary

The Studio process (`apps/backend/src/runtime/server.ts`) restricted to what is ported: configuration from the
environment (`foundation::config`, the same variables as TypeScript), the database at `PIPELINE_DB` (migrations and
date guards), and the Telegram bot on long polling (`setMyCommands` at startup). SIGINT/SIGTERM stop polling, wait for
updates in hand (10 s at most, then exit 1) and close the database. No HTTP server yet.

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

Optional: `TELEGRAM_API_BASE_URL`, `LOG_LEVEL`, `DEPLOY_AGENT_URL` + `DEPLOY_AGENT_TOKEN`, `TOKEN_ENCRYPTION_KEY`,
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
