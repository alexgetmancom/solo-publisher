# Decisions

Where the Rust Studio deliberately differs from the TypeScript backend it replaced, and the choices the goldens and
tests rely on. A deliberate behaviour change edits its golden in the same commit and adds a line here.

## Telegram bot

- The bot interface is Russian only: no `en` interface locale, no 🌐 Language settings screen, only `ru` catalog
  strings; menu fingerprint and locale-dependent parts use `ru` constantly. English content stays: English posts, `en`
  targets and channels, `schedule_en`, the `en` queue filter. Code, comments and logs are English (repo rule).
- Consequences: `setMyCommands` uses the `ru` description (TypeScript sent EN; `entry/bootstrap.json` differs on
  purpose). An actor with no stored locale reads as `en` in TypeScript; Rust always renders `ru`, and the goldens are
  recorded with `ru` stored explicitly. `ru.json` was exported with the EN value wherever the `ru` key was missing,
  because `t()` fell back to `catalog.en`, which kept the rendered output.
- `crates/foundation/locales/ru.json` is the source of truth for the interface catalog, edited by hand since the one
  export from the old catalog. First edit: `settings.category-system-body` drops «язык» (there is no language setting) —
  «⚙️ Система\n\nЧасы, копия базы и цифры, которые вводятся руками.»; the golden harness asserts the recorded TypeScript
  text and expects the new one (`deliberate_deviations`).
- `conversationSessions.save` carries the expected-revision check in the upsert's own `WHERE`
  (`ON CONFLICT … DO UPDATE … WHERE revision = expected`; zero rows → `action.session-stale`) instead of reading the
  revision first. Non-racing results match TypeScript; a revision bumped between read and write is refused, not overwritten.
- `retryVideoTarget` carries the retryable status it read in the target update's own `WHERE` (`… AND status = ?`; zero
  rows → `err.retry-only-failed`, nothing armed). A target that moved between read and write is refused, not overwritten.
- Story cards: an emoji inside the headline renders in colour (Noto Color Emoji via resvg), not as the text-coloured
  silhouette librsvg drew. Layout and line breaks are unchanged; the pixel fixtures cover cards without an inline emoji.

## Delivery

- `refreshXToken` writes the renewed pair only if the `platform_tokens` row is still the one it read
  (`UPDATE … WHERE updated_at = ? AND sealed_refresh_token IS ?`; with no row read, `INSERT … ON CONFLICT DO NOTHING`).
  Zero rows → `XRefresh::Superseded`: neither the row nor the live config is touched, and the loop logs it at info. The
  OAuth callback still writes unconditionally. A pair reconnected between read and write is kept, not overwritten by the
  older refresh.
- `crates/adapters`: any Stories answer other than an explicit "not sent" settles as ambiguous; a YouTube upload or Reels
  publish that succeeded without returning an id is reported with no id instead of failing into a retry (a second post);
  result-object key order may differ from TypeScript where requests stay byte-identical.
- `crates/delivery` and `crates/adapters`: a split Discord post refused on a later message returns a partial publication
  (`_discordMessageIds`) and the retry sends only the rest (TypeScript threw and re-posted the first message);
  reconciliation confirms a job and its target together, the target fenced on still being the unanswered publication,
  and releases the job when it moved; a video publish job whose target is held for verification completes without
  touching the target (TypeScript failed it into a retryable state, i.e. a second upload); a publish attempt is dropped
  at its timeout instead of running on unobserved.
- `story-media-prune` and `disk` list Story variants sorted by name, not in the filesystem's directory order (which
  differed between hosts and broke the ops golden on CI); the golden's plan is in sorted order.

## Telegram Stories (`crates/mtproto`)

- Stories run in process on grammers 0.12 (`mtproto::MtprotoStories` behind `adapters::StoriesClient`); there is no
  sidecar, no `STORIES_SIDECAR_*` variable. `ops telegram-stories-login` signs in itself.
- The session file stays in mtcute 0.32's SQLite layout (`auth_keys`, `key_value['dc_main']` as `serializeBasicDcOption`),
  read and written by `mtproto::session::SessionFile`, so production's signed-in account carries over. A new home DC or
  permanent key is written back (`dc_main` as version 2); grammers' peers and update state stay in memory; a test-server
  session is refused.
- A Story that fails before `stories.sendStory` is handed to the sender — connect, identity, channel resolution, the
  upload, or the 120 s deadline running out during them — is not sent; TypeScript counted any non-RPC error inside
  mtcute's `sendStory` (an upload deadline included) as possibly posted. After it, an RPC error with code 500 and up or
  negative is ambiguous (TypeScript: every RPC error was not sent). Nothing is retried except a flood wait of at most
  10 s; a dropped connection never is.
- `stories.sendStory` is byte-identical to mtcute's (`crates/mtproto/tests/send_story.golden.json`) except for the
  upload: the file is named by its base name (mtcute sent the absolute path it was given: `InputFile.name`,
  `documentAttributeFilename`), and the upload carries its MD5 (mtcute: empty) in 512 KiB parts.
- `foundation::time` looks zones up in the bundled tzdb explicitly: grammers enables jiff's default features, which
  would otherwise put the host's `/usr/share/zoneinfo` first and accept names `Intl` refused (`posixrules`).

## Test data

- The TypeScript comparisons are committed goldens recorded under ffmpeg 6.1.1 (the CI and production build). Delivery
  scenarios keep their `DATA_DIR` under `/tmp/solo-publisher-goldens/` on every machine, because media cache keys hash
  the file's path; the channels golden writes the runtime row's build revision as `<revision>`. The secret box
  round-trips in Rust and still opens the TypeScript-sealed fixtures.
- Delivery scenario media inputs are committed bytes (`crates/delivery/tests/fixtures/`), not made by ffmpeg at test
  time: the mpeg4 clip came out different per core count (slice threading), and the site golden hashes what is derived
  from it. What ffmpeg's encoders write (WebP variants, posters) is compared by path and links, with names taken from
  their hashes read as the file they name, because those bytes follow the ffmpeg build.

## Media processor (`crates/media_processor`, binary `media-processor`)

- Routes, auth, status codes, bodies, JSON shapes and key order, the cache layout, the hourly 24 h prune, port 8787 and
  every `MEDIA_PROCESSOR_*` variable are unchanged from TypeScript; `site_vertical` is kept although no client sends it.
  The image is `debian:trixie-slim` with Debian's `ffmpeg` and `intel-media-va-driver`; no Bun.
- One vertical media recipe (`crates/vertical_media`) for both executors, `Encoder::{Software, Vaapi}` being the only
  thing the argv branches on (device args, `format=nv12,hwupload`, codec flags). The VAAPI argv is byte-identical to the
  TypeScript (`crates/vertical_media/tests/remote_recipe.golden.json`); the local software argv is unchanged. The probes
  stay apart: remotely duration is capped at 59 s and absent audio counts as 128 kbps, locally neither.
- Deliberate deviations: a `MEDIA_PROCESSOR_*` number that does not parse refuses the start (TypeScript ran with `NaN`);
  the work and cache directories are created at start; a request sharing a render that threw gets 503
  `media_processing_shared_job_failed` (TypeScript: 500); a filesystem or spawn failure is a 500 with a
  `media_processor_error: …` text body, and an unmeasurable work disk a 500 `media_processor_work_dir_unavailable: …`
  (TypeScript: Bun's error page); an ffprobe that cannot start reads as an unreadable source; `/health` `queued` is
  always 0 (distinct work was never queued); the bearer token is compared in constant time; SIGTERM stops the process
  (PID 1). The completion log line keeps the TypeScript shape (`job`, `timings` at the top level), not the Studio
  logger's `details`.
- The media image rebuilds on `crates/media_processor`, `crates/vertical_media`, the workspace `Cargo.toml`/`Cargo.lock`
  and `deploy/media-processor/{compose.yml,Dockerfile*}`; `vertical_media`, `Cargo.toml` and `Cargo.lock` rebuild the
  Studio image too, `crates/media_processor` does not.

## Tooling

- Developer and CI tooling is `cargo xtask` (`crates/xtask`, alias in `.cargo/config.toml`): `check [--jobs N]
  [STEP...]` (language, fmt, clippy, test, build — serial, stops at the first failure; lefthook's pre-push and CI's
  `rust` job run it), `ops-prod`, `image-smoke <image>` (the image as an argument, not `IMAGE`), `deploy-release`
  (CI's deployment), `family-routes` (CI pipes `caddy adapt` into it). The language gate fails on any TypeScript,
  JavaScript or Python source outside the allow-list in `crates/xtask/src/check.rs`. Dropped with the TypeScript: knip,
  biome, taze, the Dockerfile workspace gate, `package.json`, `bun.lock`, `bunfig.toml`, the coverage ratchet, the
  `typescript` check step. `bun audit` is `cargo-audit audit` on `Cargo.lock`, when it changes and weekly.
- The production route is `cargo xtask ops-prod [--as alex|maru]`. It runs `/app/bin/ops` directly as `-u 1000` (it ran
  `bun /app/ops/cli.js` as `-u bun`, the same uid and groups), passes `OPS_INVOCATION=cargo xtask ops-prod --as <name>`,
  prints `ops-prod → <name> (<container>)`, and reads `OPS_SSH_TARGET` from the repository root's `.env.local` when the
  variable is not set. The guide's production prefix and `parity/ops/catalog.json` say `cargo xtask ops-prod`.
- A self-hosted Studio's operations route is `docker compose exec app ops <command>` (`/app/bin` is on the image's
  PATH); `guide`'s local prefix without `OPS_INVOCATION` is `ops`. `parity/ops/catalog.json` and
  `parity/ops/scenarios/mcp.json` are edited for it.

## Deploy agent and image

- The deploy agent is Rust (`crates/deploy_agent`, binary `deploy-agent`, hyper 1 on a current-thread runtime): routes,
  bearer check, status codes, `{ok, target, release, currentRevision}` and `{ok: false, message}` bodies, the state
  file, env file rewriting, every `docker`/`docker compose` argv but one, the 90 s/2 s/5 s health timings, the 150 s
  remote timeout, the lock, the retry schedule, the notification texts, the `deploy_rb_ask:`/`deploy_pr_ask:` callbacks
  and every `DEPLOY_*` variable are unchanged. Deliberate changes: the configuration check runs
  `docker compose … run --rm --no-deps --entrypoint /app/bin/studio-entrypoint <service> --check-config`; a request runs
  detached from its connection, so a caller hanging up no longer cancels a deployment between replacing a container and
  rolling it back; state and env files are written beside the target and renamed into place; every URL it calls must be
  `http://`, checked at start; a remote agent that refuses the connection is retried (the OS's `Connection refused`
  matches the transient pattern), a request that times out is not; a non-boolean `configCheck` refuses the start. Kept
  though inert: `docker image inspect <container name>` for the running image's digest and id, which Docker resolves
  only for images.
- The configuration check is a per-target setting, `"configCheck"` in `DEPLOY_TARGETS_JSON` (on unless `false`); the
  media processor's target, whose image has no `studio-entrypoint`, turns it off. A request that names no target goes to
  `alex`, or to the only target of an agent that drives one (the Studio host's agent calls the media processor host's
  agent as `POST /v1/deploy`); `DEPLOY_DEFAULT_TARGET` stays removed and the single-target variables are not read
  (`deploy/README.md` derives `DEPLOY_TARGETS_JSON` from them once).
- The agent binary ships in the Studio image (`/app/bin/deploy-agent`, built in the same Dockerfile stage for
  `$(uname -m)-unknown-linux-musl`, so it runs on the host whatever its glibc). `cargo xtask deploy-release` copies it out
  of the image it is deploying (`docker create` + `docker cp`) into `/home/deploy/bin/deploy-agent` on every run and
  restarts the unit only when the bytes differ. Which agent the restart runs is the unit's `ExecStart`, switched once per
  host by hand. VM-106's agent is not updated by any deployment.
- `deploy-release` reads the agent's state file with `cat` and parses it in the xtask (not `bun -e` on the host), and
  `IMAGE` must be a `ghcr.io/alexgetmancom/solo-publisher` digest before anything runs.
- The Studio image runs on `debian:trixie-slim@sha256:8aa5a7bf…` (the media processor's pin) with `ca-certificates`,
  `tini`, setpriv from util-linux and the static ffmpeg/ffprobe 6.1.1 from `mwader/static-ffmpeg:6.1.1@sha256:a44cd22b…`;
  no Bun. Both hosts run the Rust deploy agent, which runs `studio-entrypoint --check-config` itself.
- The runtime user is `studio` (was `bun`): uid 1000, gid 1000, `/home/studio`, `/bin/sh`, so the data volumes, owned by
  uid 1000, carry over untouched. `studio-entrypoint` drops to it; `cargo xtask ops-prod` keeps `-u 1000`; `docker exec`
  takes `-u studio`.
- The healthcheck is `studio-entrypoint --ready` in both compose files: `GET /readyz` on `127.0.0.1:$PORT` (8788), healthy
  on a 2xx, 4 s timeouts under compose's 5 s. `studio-entrypoint` refuses an unknown argument: ignoring one as root
  started a second Studio. Cost, for the one release whose rollback target predates this: that image's entrypoint
  ignores `--ready`, and the Studio it then starts exits on the taken port before any worker, so a rollback to it under
  the new compose file reports unhealthy while the rolled-back Studio itself runs. `deploy-release` installs
  `deploy/studio.compose.yaml` on every deployment; no host step.
