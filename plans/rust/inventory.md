# solo-publisher backend inventory for the Rust rewrite

Snapshot of the TypeScript/Bun sources (last commit on main: 2026-11-13, 1356 commits). Numbers are measured with `wc -l`/grep unless marked "not verified". Read-only analysis; nothing in the repo was changed except this file.

## 1. Top-level layout

Totals: `apps/backend/src` = 327 .ts files / 42,373 lines; `apps/backend/tests` = 176 .ts files / 26,756 lines (166 `*.test.ts` = 26,383 lines); total backend = ~69k lines. Counts below are direct files only (no subdirectory rollup).

| Dir (apps/backend/src) | Files | Lines | Purpose |
|---|---|---|---|
| `.` (api, bot, botTargets, cli, json, studio) | 6 | 609 | Hono composition root (`api.ts`), grammY bot factory (`bot.ts`), target catalogue (`botTargets.ts`, 11 targets), CLI entry (`cli.ts`), Studio profile config view (`studio.ts`) |
| `application/` | 4 | 614 | `ApplicationPorts` (`ports.ts`, 477 lines: the DB handle interface + record types), conversation flow, publication ref |
| `bot/` | 41 (+5 in `bot/settings/`) | 5,938 (+805) | Telegram bot UI: screens, callbacks, menus, intake, albums, effects. Total 46 files / 6,743 lines. Covered by another agent |
| `channels/` | 14 | 1,300 | Channel registry, OAuth (Meta/X/YouTube), token stores/renewal, API keys, Zernio connections |
| `content/` | 15 | 956 | Text/markdown/entities, thread parts, translation (DeepSeek), asset limits, site media naming |
| `db/` | 5 | 216 | `client.ts` (open, PRAGMAs, drizzle migrate, date-guard triggers), `unsafe.ts` |
| `db/repositories/` | 13 | 1,257 | Per-aggregate stores (drafts, thread parts, studio posts/queue/videos, settings, channels, events...) |
| `db/schema/` | 12 | 1,242 | Drizzle table definitions (61 tables) |
| `delivery/` | 23 | 4,169 | Publish workflow, site jobs/media, reconciliation, video worker, media prepare, remote media processor client, Zernio, IndexNow |
| `delivery/ports/` | 1 | 138 | Platform ports wiring (serial queue per platform) |
| `delivery/social/` | 9 | 1,754 | Platform adapters: telegram, telegramStories (MTProto), x, threads, instagram, discord, payload helpers |
| `foundation/` | 23 | 1,560 | config (zod env schema), logger, http (`requestJson`, `externalFetch`), time/tz, secret-box (AES-256-GCM), scheduler, worker signal, auth, ranged-file, redact |
| `foundation/external/` | 7 | 245 | Thin clients: DeepSeek, Telegram files, mtcute session, Instagram/Threads/YouTube/Zernio helpers |
| `foundation/i18n/` | 2 | 1,664 | `catalog.ts` (1,506 message keys, en + ru) + `t()`/`plural()` (uses `Intl.PluralRules`) |
| `foundation/runtime/` | 6 | 435 | ffmpeg/ffprobe runner (concurrency 2), data-dir checks/chown, worker-state heartbeat, timeout |
| `interfaces/` | 2 | 725 | MCP server (`mcp.ts` 719) + protocol metadata |
| `interfaces/http/` | 9 | 703 | Route modules: health, discovery, MCP/media upload, OAuth x3, public site |
| `interfaces/telegram/` | 11 | 1,380 | Telegram-side adapters: event consumer, control cards, previews, video notifications, daily backup, media/video ingress |
| `notifications/` | 1 | 96 | Notification job cycle |
| `observability/` | 13 | 1,560 | Alerts, token health, auth circuit, usage counters, runtime health, memory, date integrity/repair |
| `operations/` | 38 | 6,088 | Operations registry (1,367 lines) + 37 operation implementations (backup, restore, audit, repair, purge, resend, verify...) |
| `operations/commands/` | 4 | 402 | Requeue/media-replacement/content-repair/scope-plan |
| `public/` | 3 | 440 | Public site read model (feed + ETag), site image metadata (image-size), public video asset |
| `publishing/` | 36 | 4,795 | Publication plan/state machine, queue (820), job policy/retry, video service (562), preflight, cancellation, requeue |
| `runtime/` | 6 | 352 | `server.ts` (Bun.serve), `docker-entrypoint.ts` (root -> drop privileges), `workers.ts`, `app-runtime.ts`, config loaders |
| `story-cards/` | 5 | 644 | Story card queue/worker + renderer subprocess (sharp: SVG overlay + emoji composite on PNG background) |
| `studio/` | 3 | 374 | Studio access, projections, video FSM |
| `studio/services/` | 10 | 1,912 | The Studio service layer shared by bot and MCP (posts 752, videos 371, queue, settings, channels, media...) |

Outside backend src:

| Path | Files | Lines | Purpose |
|---|---|---|---|
| `shared/` | 2 | 88 | `serial-queue.ts` (promise-chain mutex used by backend + media-processor), `theme-script.ts` |
| `scripts/` | 12 | 1,600 | Repo tooling: check gates, `ops-prod.ts` (ssh+docker exec), `deploy-release.ts`, `dev-seed.ts`, `image-smoke.ts`, layer checker |
| `deploy/` | 27 | 1,935 | Host-side: `deploy-agent.ts` (632, Bun service that is the only thing allowed to call Docker), `media-processor/` (separate Bun service, 559 lines), compose files, Caddyfile (179 lines, maintainer-specific incl. Family routes), systemd units, 3 test files (355 lines) |
| `docs/` | 12 | 1,242 | architecture, install, backups, destinations, mcp (each en + ru) |
| `apps/backend/drizzle/` | 37 .sql + meta | 1,686 | Migrations |
| `apps/backend/assets/story-card/` | - | 13 MB | Manrope font, Noto/Twemoji emoji SVGs, background PNG |
| `.github/workflows/` | 2 | 869 | `check.yml` (755: static, analysis, tests, image build, deploy gate on `/readyz`, promote to Maru), `media-processor.yml` |
| `plugin/` | 5 | 250 | Claude/Codex plugin docs for MCP |
| root | - | - | `install.sh` (240, POSIX sh installer), `compose.yaml`, `Caddyfile` (self-host), `Dockerfile*` in apps/backend |

## 2. Runtime

Entrypoints (Bun): `runtime/docker-entrypoint.ts` (container PID under `tini`; as root fixes ownership of data dirs, irreversibly `setgroups/setgid/setuid` to user `bun`, probes writability, then `import`s `runtime/server.js`); `runtime/server.ts` (starts runtime, bot runner, `Bun.serve`); `cli.ts` (ops CLI, run as `docker compose exec app bun /app/ops/cli.js <cmd>` or via `bun run ops:prod`); `runtime/config-check.ts`; `story-cards/renderer-process.ts` (child process, JSON on stdin). Bundles built with `bun build` into `runtime/`, `ops/`, `entrypoint/`, `story-renderer/`.

One OS process (plus short-lived story renderer children and ffmpeg children). No queue broker: queues are SQLite tables. Shutdown: SIGINT/SIGTERM -> stop HTTP, stop bot runner, stop loops, close DB, 10 s hard exit.

Scheduler: `foundation/scheduler.ts` `startLoop(name, intervalMs, task)`: setInterval + single-flight + "again" flag on wake, optional heartbeat; `worker-signal.ts` lets code wake the `publish` and `telegram-events` loops immediately. Each loop writes a heartbeat row into `worker_state`; `/readyz` reports them. 19 loops:

| Loop | Interval | What |
|---|---|---|
| queue | `IDLE_POLL_INTERVAL_SECONDS` (5 s) + wake | `runDeliveryPublishCycle` (social publish jobs, p-limit, job heartbeat 180 s, lock 900 s, timeout 600 s, 4 attempts, partial 12) |
| platform-tokens | 6 h | Renew Meta (Threads/Instagram) long-lived tokens |
| credentials | 60 s | Re-apply tokens/keys stored in DB onto live config |
| x-token | 10 min | Refresh X OAuth token |
| story-cards | 5 s | Render story cards |
| publish-watchdog | 60 s | Recover stale publish locks |
| publication-reconciliation | max(60, 5) s | Reconcile ambiguous publications against platforms |
| notifications | 5 s | Notification jobs |
| video | 5 s | Video pipeline (prepare/publish/metrics) |
| site | 10 s | Site build jobs (only if site enabled) |
| site-watchdog | 60 s | Recover stale site locks |
| media-cache | 1 h | Prune cache |
| operational-retention | 24 h | Prune history under maintenance lock |
| observability | 300 s | Probes: restart, memory, credentials, token health, failures, alerts |
| telegram-events | 5 s + wake | Domain events -> Telegram cards |
| telegram-translations | 1 s | DeepSeek draft translation, refresh card |
| telegram-albums | 1 s | Finalize pending media-group albums |
| telegram-alerts | 5 s | Deliver alerts to admin |
| telegram-daily-backup | 60 s tick | Send DB backup (VACUUM INTO) to admin as document |

Startup recovery: stale publish/site/story-card locks released with a short grace (30 s) before loops start. In `NODE_ENV=test` no loops start.

Packaging: `compose.yaml` (self-host: Caddy 2.10, optional `bot-api` = aiogram/telegram-bot-api for 2 GB downloads, `app` on 127.0.0.1:8788 with healthcheck `bun -e fetch(/readyz)`); `Caddyfile` = TLS + `reverse_proxy app:8788` with `X-Real-IP`. Image: `oven/bun:1.4.0-debian` build, `oven/bun:1.4.0-slim` runtime + tini + static ffmpeg/ffprobe 6.1.1 (mwader), glibc required (sharp), linux/amd64 + arm64, published to ghcr. Maintainer production: `deploy/studio.compose.yaml` per Studio (alex, maru; env files `deploy/alex.env`, `deploy/maru.env`), `deploy-agent.ts` (host systemd service, 9899, bearer token, rollback by digest), `deploy/caddy/Caddyfile` (host proxy, also fronts non-Studio services), optional remote media processor on another host (VAAPI). `install.sh` = one-command self-host install (checks Docker/DNS, writes `.env` with generated secrets, `docker compose up`, waits for `/readyz`).

Env vars read (names only). Schema in `foundation/config.ts` (zod; blank = unset; production invariants):
- Core: NODE_ENV, DEPLOYMENT_ENV, LOG_LEVEL, PORT, BIND_HOST, DATA_DIR, PUBLIC_BASE_URL, PUBLIC_MEDIA_BASE_URL, TRUSTED_CLIENT_IP_HEADER, CLIENT_IP_HASH_SALT, COMMAND_CENTER_TOKEN, TOKEN_ENCRYPTION_KEY, GIT_REVISION, DRIZZLE_MIGRATIONS_DIR
- Studio access: MCP_STUDIO_TOKEN, MCP_STUDIO_ACTOR_ID, STUDIO_ACTOR_IDS, CONTROLLER_ADMIN_IDS
- Telegram: CONTROLLER_BOT_TOKEN, TELEGRAM_API_BASE_URL, TELEGRAM_CHANNEL_USERNAME, TELEGRAM_STORIES_CHANNEL, TELEGRAM_CHANNEL_STORIES_API_ID / _API_HASH / _SESSION (compose also: TELEGRAM_API_ID, TELEGRAM_API_HASH for the bot-api container)
- Timings: PUBLISH_JOB_TIMEOUT_SECONDS, METRICS_REFRESH_INTERVAL_SECONDS, CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS, OBSERVABILITY_INTERVAL_SECONDS, IDLE_POLL_INTERVAL_SECONDS, THREADS_CONTAINER_TIMEOUT_SECONDS
- Media: MEDIA_PROCESSOR_PROVIDER, MEDIA_PROCESSOR_URL, MEDIA_PROCESSOR_TOKEN, MEDIA_PROCESSOR_TIMEOUT_SECONDS, STORY_CARD_ASSETS_DIR, STORY_CARD_RENDERER_ENTRY
- Platforms: THREADS_RU_/EN_ACCESS_TOKEN, THREADS_APP_ID/SECRET, X_CLIENT_ID/SECRET, ENABLE_X_METRICS, ENABLE_X_PROFILE_METRICS, DISCORD_CHANNEL_ID, DISCORD_GUILD_ID, DISCORD_BOT_TOKEN, INSTAGRAM_{EN,RU}_ACCESS_TOKEN / _USER_ID, INSTAGRAM_APP_ID/SECRET, INSTAGRAM_GRAPH_API_VERSION, YOUTUBE_{RU,EN}_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN, ZERNIO_API_KEY, INDEXNOW_ENABLED
- AI: DEEPSEEK_API_KEY; GROK_CLI_PATH is declared but no consumer found in src (not verified in bot/ beyond grep: only config.ts references it)
- Ops: DEPLOY_AGENT_URL, DEPLOY_AGENT_TOKEN, OPS_SSH_TARGET (scripts)
- Derived (not env): PIPELINE_DB=`$DATA_DIR/pipeline.db`, STUDIO_MEDIA_DIR=`video-media`, MEDIA_CACHE_DIR=`media-cache`, VIDEO_FRAME_DIR=`video-frames`, STORY_CARD_DIR=`story-cards`, SITE_PUBLIC_DIR=`site`, REMOTE_MEDIA_PATH=`media`.
- Config is not immutable: `applyStoredCredentials` mutates the live config every 60 s from DB rows (tokens, API keys); studio settings are live getters over `studio_profile`. Rust needs a shared mutable/swappable config (not verified design choice).

## 3. HTTP surface

Framework: Hono on `Bun.serve` (`maxRequestBodySize` ~1 GB + 1 MB, `idleTimeout` 255 s). `strict:false` (trailing slash matches). `/oauth/*` and `/stats*` get `X-Robots-Tag: noindex` + `Cache-Control: no-store`. Unknown -> `404 "not found\n"`; handler throw -> 500. **No web UI, no static assets served**: the "Command Center" is only a name in config (`COMMAND_CENTER_URL=<base>/command-center`; no such route exists in src) and the public website is a separate service (alexgetman-site) that polls this Studio. Auth: `COMMAND_CENTER_TOKEN` (header `X-Command-Token`/`X-Admin-Token`, cookie `command_token`, `?token=` only on GET/HEAD; timing-safe compare) and `Bearer MCP_STUDIO_TOKEN` -> actor id. Visitor identity = HMAC-SHA256(`CLIENT_IP_HASH_SALT`, trusted header).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz`, `/tg-feed/healthz` | none | `ok` |
| GET | `/readyz` | none | JSON: DB query, data dir writable, media dirs writable, worker heartbeats; 503 if any check fails |
| GET | `/api/mcp` | Bearer | SSE: `endpoint` event then `ping` every 30 s; 401 + `WWW-Authenticate` resource_metadata |
| POST | `/api/mcp` | Bearer (actor) | JSON-RPC: `initialize`, `tools/list`, `tools/call`; notifications -> 202; protocolVersion `2024-11-05`, serverInfo `solo-publisher-studio-mcp` 2.1.0 |
| POST | `/api/studio/media` | Bearer | Raw-body upload (not multipart), headers `X-Filename`, `Content-Type`; streams to `.incoming/<uuid>` with byte cap (`STUDIO_MEDIA_MAX_BYTES`, ~1 GB); max 2 concurrent (429 + `retry-after`); returns `asset_id, kind, filename, byte_size` |
| GET | `/.well-known/oauth-protected-resource` | none | JSON, cache 1 h |
| GET | `/.well-known/mcp/server-card.json` | none | JSON, cache 1 h |
| GET | `/oauth/{threads,instagram}/start`, `/oauth/{threads,instagram}` | command token (start) / signed `state` (callback) | Meta OAuth connect + callback -> stores sealed token, registers channel; HTML result page |
| GET | `/oauth/x/start`, `/oauth/x` | command token / state (PKCE) | X OAuth2 |
| GET | `/oauth/youtube/start`, `/oauth/youtube` | command token / state | Google OAuth |
| GET | `/api/public/site` | none | **Public contract** (below); 404 when site disabled |
| GET/HEAD | `/media/video/asset/:id` | none | `:id` = 64-hex sha256 of a video asset in `studio_media_assets`; whole file, no ranges, `noindex`, cache 300 s (Meta fetches this for Reels) |
| GET/HEAD | `/media/*` | none | `/media/staging/*` -> `$DATA_DIR/media` (works even with site off); other paths -> `$DATA_DIR/site/media` (site on only). Path-traversal guard (403). HTTP Range via `rangedFileResponse`. Cache: `?v=<12 hex>` -> 1 y immutable, else 1 d + SWR 7 d |
| GET | `/:hex32.txt` | none | IndexNow key file (`indexNowKey`), 404 otherwise |
| GET | `/generated/responsive/:file` | none | Pre-generated `<name>-<width>.webp` from `$DATA_DIR/site/generated/responsive`; widths from `RESPONSIVE_WIDTHS`; never generates on request |

`/api/public/site` contract: body `{"site":{en,ru identity},"items":[FeedItem...]}`. `site` per locale: name (falls back to domain host), tagline, about, bio, profiles[{label,url}], timezone. `FeedItem` (strict zod): id, post_id, date, updated_at_ru/en, text, text_ru, text_en, html, html_en, slug_ru/en, seo_title_ru/en, has_ru/en, media[], media_en[] (type, path, alt, poster, width, height, responsive, poster_responsive; passthrough fields stripped to those), image, image_en, audio_url_*, spotify_url_*, entities[{kind,slug,title_ru,title_en,link_role}], views. Media entries are filtered to files that exist on disk and enriched with image dimensions + responsive srcset. Strong ETag = sha256 of body (base64url, 27 chars); `If-None-Match` -> 304; `Prefer: wait=N` (max 25 s) long-polls re-checking every 3 s; `Cache-Control: no-cache`. Read model is cached per DB handle and invalidated by an attached in-memory DB with TEMP triggers + `pragma_data_version`, plus clock for scheduled locales. Test side of the contract: `tests/publicSite.test.ts`, `siteReadModel.test.ts`, `siteParity.test.ts`.

## 4. Data

Engine: SQLite via `bun:sqlite` (synchronous), ORM Drizzle (`drizzle-orm/bun-sqlite`, `casing: snake_case`), one file `$DATA_DIR/pipeline.db`. Opened with `PRAGMA journal_mode=WAL`, `busy_timeout=30000`, `synchronous=NORMAL`, `cache_size=-16384`, `mmap_size=32 MB`, `wal_autocheckpoint=4000`; `foreign_keys=OFF` during migrate, then ON. Backups use `VACUUM INTO` (merges WAL). Concurrency: the server process and the `ops` CLI process both open the same file; 57 `.transaction(` calls and 47 `immediate`/`BEGIN IMMEDIATE` mentions (publish/claim paths are immediate write transactions); 76 files reach raw SQLite through `unsafeDb(...)`, 24 `sql\`` fragments, 69 `.returning(` calls.

Migrations: 37 files `apps/backend/drizzle/0000_baseline.sql` .. `0036_site_media_editorial_dates.sql` (1,686 lines, 323 statements split by `--> statement-breakpoint`), journal `meta/_journal.json`. Applied by drizzle's migrator at every open, so production already holds a `__drizzle_migrations` bookkeeping table. Not verified (could not inspect drizzle internals here): its exact columns/hash format. A Rust binary that must adopt the existing production DB has to either reproduce that bookkeeping byte-for-byte or take over by an explicit one-time step. Migrations use table rebuilds (`*_new` + rename) and `ALTER TABLE ... DROP COLUMN` (needs SQLite >= 3.35; bundled bun:sqlite here = 3.53.4; `libsqlite3-sys` bundled is fine, system sqlite on AlmaLinux 9 is older).

Result of replaying all migrations into an in-memory DB (measured with bun:sqlite): **61 tables, 519 columns, 107 indexes, 1 static trigger, 0 views**, foreign keys only on 6 video/social tables (`video_drafts`, `video_targets`, `video_jobs`, `video_metric_*`, `video_frame_features`, `social_comments`). CHECK constraints in 6 tables (`credential_checks` 3, `metric_schedule` 3, `video_metric_schedule` 3, `video_metric_snapshots` 1, `x_activity_imports` 1). Composite primary keys are common. Timestamps are TEXT ISO strings.

Tables by area (columns in parentheses):
- Content/publishing core: `drafts`(11), `post_locales`(16, per-locale text/html/entities/media JSON/slug/seo_title/site flags/publish_at/site_updated_at), `draft_thread_parts`(9), `draft_translations`(9, work queue), `draft_story_cards`(15, work queue), `pending_albums`(14), `publication_targets`(13, per target status/external ids/url/verification), `publish_jobs`(15, queue: attempt_count, next_attempt_at, locked_by/at, payload_json, current_phase, reconcile_attempt_count), `publication_events`(9), `publication_cancellations`(3), `site_jobs`(11, queue), `site_pageviews`(4), `articles`(5), `article_locales`(9)
- Video: `video_drafts`(18), `video_targets`(18), `video_jobs`(14, queue), `video_metric_schedule`(10), `video_metric_snapshots`(6), `video_frame_features`(6), `social_comments`(9)
- Studio/settings: `studio_profile`(14, singleton: timezone, site_enabled, names/tagline/about/bio/profiles JSON per locale, default targets), `studio_notification_settings`(6), `studio_notification_jobs`(9, queue), `studio_weekly_digest_settings`, `studio_news_digest_settings`, `studio_milestone_settings`, `studio_backup_settings`, `studio_youtube_settings`, `bot_ui_settings`(4), `studio_media_assets`(10, sha256-indexed uploads), `channel_connections`(11), `interface_bindings`(8), `conversation_sessions`(10, bot FSM)
- Credentials/ops: `platform_tokens`(9, AES-GCM sealed tokens), `credential_checks`, `worker_state`(3, heartbeats), `runtime_usage`(8), `alert_dedup`, `maintenance_locks`, `format_support`, `media_test_cases`
- Analytics: `post_metrics`, `metric_samples`, `metric_schedule`, `analytics_rollups`, `analytics_sync`, `creator_profiles`, `creator_profile_snapshots`, `audience_activity`, `audience_demographics`, `x_activity_imports`, `x_activity_items`, `x_activity_metric_snapshots`, `games`
- Engagement/knowledge: `post_comments`(11), `telegram_discussion_threads`(4), `knowledge_entities`, `knowledge_entity_aliases`, `draft_entity_candidates`, `draft_entity_links`
- SQLite internal: `sqlite_sequence` (some AUTOINCREMENT ids).

Triggers/constraints that matter for the port:
1. `date_guard_<table>_<column>_{insert,update}` triggers are generated at every open by `db/date-guards.ts` from live schema: every TEXT column named `*_at` must GLOB an ISO instant `YYYY-MM-DDTHH:MM:SS*`; `*_on`/`period_start`/`period_end` must be a day or `YYYY-MM-DDTHH`. The Rust port must install the same triggers (same names, same GLOB patterns, so a mixed TS/Rust period stays consistent) and must build timestamps in UTC from parts (project rule: no host-timezone date parsing).
2. `post_locales_site_content_updated` (migrations 0035/0036): AFTER UPDATE trigger that sets `site_updated_at` using `json_group_array/json_extract` over `site_media_json`. It lives in SQL, so it ports for free as long as the SQLite build has JSON1.
3. The public site read model creates a TEMP attached in-memory DB `public_site_cache` with TEMP triggers per connection and reads `pragma_data_version` (`public/site-read-model.ts`). Needs a driver that exposes these (rusqlite does; verify with sqlx before choosing).
4. Delivery invariants from AGENTS.md that live in SQL `WHERE` clauses: lease/status/external-id conditions on writes, takedown + journal in one transaction. These are the behaviours tests like `publicationOwnership`, `actionLock`, `postRecoveryScenario` pin down.
5. `schemaMatchesMigrations.test.ts` asserts Drizzle schema == migrations; in Rust the SQL migrations become the single source (no ORM).

Secrets at rest: `platform_tokens.sealed_token` = `base64(iv).base64(tag).base64(ciphertext)` AES-256-GCM with 12-byte IV, key = `TOKEN_ENCRYPTION_KEY` (32 bytes hex); `fingerprint` = first 32 hex chars of SHA-256. Must stay byte-compatible so the Rust binary can read tokens the TS binary wrote.

## 5. External integrations

Almost every platform call is plain `fetch` through `foundation/http.ts` (`requestJson`/`externalFetch`: 30 s default timeout via AbortController, error classes `ExternalHttpError` with `Retry-After`/`X-RateLimit-Reset` parsing, `ExternalTransportError`, URL/body secret redaction). So most of the integration layer ports to `reqwest` without an SDK. Tests forbid unstubbed network (`tests/helpers/no-network.ts`), and every adapter takes `fetchImpl` as a parameter.

| Service | Client | Operations |
|---|---|---|
| Telegram Bot API (publish side) | raw fetch to `${TELEGRAM_API_BASE_URL}/bot<token>/<method>` (`delivery/social/telegram.ts`, `platform-adapters.ts`, `foundation/external/telegram-files.ts`) | sendMessage/sendPhoto/sendVideo/media groups, editMessage*, deleteMessage, getFile + file download (local Bot API server raises 50 MB cap to 2 GB; files may be read straight from the shared `/var/lib/telegram-bot-api` volume) |
| Telegram Bot API (controller bot) | grammY + `@grammyjs/auto-retry`, `@grammyjs/menu`, `@grammyjs/runner` (long polling, concurrent) | whole bot UI, `setMyCommands`, `sendDocument` (daily backup), `getFile` for intake. Other agent covers |
| Telegram MTProto | `@mtcute/bun` / `@mtcute/core` (`foundation/external/telegram-session.ts`, `delivery/social/telegramStories.ts`, `ops telegram-stories-login`) | Post **channel Stories** (`stories.sendStory`) with caption entities; session file path from `TELEGRAM_CHANNEL_STORIES_SESSION`; mtcute needs WASM files next to the bundle; video must stay < 9.5 MiB to avoid the big-file upload path (`MEDIA_FILE_INVALID`) |
| X (Twitter) | raw fetch, OAuth2 PKCE (`channels/x-oauth.ts`) | `api.x.com/2/tweets` (threads), `/2/media/upload`, `/2/users/me`, `/2/oauth2/token` refresh, X Articles (`/2/articles/draft`, `/publish`), delete |
| Threads | raw fetch `graph.threads.net/v1.0` | container create/poll (`THREADS_CONTAINER_TIMEOUT_SECONDS`), publish, replies/comments read, `refresh_access_token`, OAuth `threads.net/oauth/authorize` |
| Instagram | raw fetch `graph.instagram.com` (+ `graph_api_version` v23.0), `api.instagram.com/oauth/access_token` | Reels/Stories containers, publish, token refresh; media is fetched by Meta from `/media/video/asset/<sha256>` |
| YouTube | raw fetch `googleapis.com`, `oauth2.googleapis.com`, `accounts.google.com` | resumable upload `upload/youtube/v3/videos?uploadType=resumable`, videos.list status checks, YouTube Analytics (scope `yt-analytics.readonly`), OAuth refresh; two accounts (RU/EN) |
| Discord | raw fetch `discord.com/api/v10` bot token | send message with media, delete, `users/@me` check |
| Zernio | raw fetch `zernio.com/api/v1` (`delivery/zernio.ts`, 244 lines, `channels/zernio-connections.ts`) | Third-party posting aggregator: accounts list, publish via connected accounts (API key `ZERNIO_API_KEY`) |
| DeepSeek | raw fetch `api.deepseek.com/v1/chat/completions` model `deepseek-chat` | RU -> EN translation of drafts (temperature 0.1, 40 s) |
| IndexNow | raw fetch `api.indexnow.org/indexnow` | Ping URLs after site publish; key file served at `/<key>.txt` |
| Remote media processor | raw fetch to `MEDIA_PROCESSOR_URL` `/v1/transforms/ffmpeg` (POST) and `/v1/transforms/ffmpeg/<sha256>/<standard|telegram>` (GET), `/health`; bearer token | Offloads Story/short-video encodes (VAAPI `h264_vaapi` on the other host) |
| Deploy agent | fetch to `DEPLOY_AGENT_URL` (`foundation/deployment.ts`, 118 lines) | Release info + rollback request, bearer |
| Local tools | `Bun.spawn` ffmpeg/ffprobe, story renderer child | see section 6 |

No S3/object storage: storage is the local data volume (+ operator-driven backup streams: `backup`, `backup-media` stream a DB dump / media archive to stdout for a pulling machine). `GROK_CLI_PATH`/`GROK_HOME` appear in config/compose but no spawn of Grok was found in src (not verified in all of bot/ beyond a repo-wide grep).

## 6. Media processing

- **ffmpeg/ffprobe as subprocesses** (`foundation/runtime/ffmpeg.ts`): global limiter of 2 concurrent ffmpeg (p-limit), SIGKILL on timeout (600 s default), stderr trimmed to last 6 meaningful lines, exit 137 = OOM message; `ffprobe -of json` for width/height/duration/codecs/fps/audio bitrate (30 s timeout). Static ffmpeg 6.1.1 is copied into the image; the Rust image must keep shipping it.
- Recipes: responsive site images `-vf scale='min(W,iw)':-2 -c:v libwebp -quality 80` (`delivery/site-media.ts`, widths in `content/site-media-naming.ts`, generated before the post enters the feed; freshness by mtime); video prepare/transcode with `libx264` and scale/pad filters (`delivery/media-prepare.ts`); story re-encode to < 9 MiB with bitrate maths (`delivery/social/telegramStories.ts`); story master encode in `delivery/story-media.ts` + `deploy/media-processor/story-encode.ts` (libx264 or `h264_vaapi`, two output legs `standard` and `telegram`, shared with the remote service); poster/frame extraction (`runFfmpegCapture` returns raw RGB from stdout).
- **sharp** (libvips, native N-API) is used in exactly one place: `story-cards/renderer-process.ts` (isolated child process, `sharp.cache(false)`, concurrency 1): resize a 1080x1920 background PNG with `fit: cover`, composite an SVG text overlay (Manrope variable font, glow filter, letter-spacing) and a 58 px emoji SVG -> PNG, output JPEG q92 4:4:4. SVG text layout with a variable font + `feGaussianBlur` filter is the hard part for Rust (see section 8).
- **image-size**: reads width/height from image files (`public/site-images.ts`); trivial in Rust (`imagesize` crate or `image` header read).
- Data limits: media cap `STUDIO_MEDIA_MAX_BYTES` (~1 GB), Telegram story cap 9.5 MiB, `MEDIA_PROCESSOR_MAX_BYTES` on the remote service.
- Native deps to carry in Rust image: ffmpeg + ffprobe binaries only (if the story renderer moves to resvg/tiny-skia no libvips needed). `deploy/media-processor` can stay Bun (559 lines, separate service, optional) or be ported last.
- Other process-level facilities: `data-dirs.ts` checks writability and `chown`s dirs as root; Rust entrypoint must do the same privilege drop (`setgroups/setgid/setuid`, irreversible) before opening the DB.

## 7. Operations registry, CLI, MCP

`operations/registry.ts` (1,367 lines) is one table of operation definitions: `{summary, section, startHere?, schema (zod), mutates, note?, agent, databaseIndependent?, handler, format?, streams?, journalRef?, journalsInHandler?}`. Measured counts (grep over the file): **68 operations**; 43 `mutates: true` / 25 read-only; 44 `agent: true` / 24 CLI-only; sections: delivery 29, media 14, channels 11, health 8, studio 3, host 3. `OperationContext = {dbPath, config(), db(), fetchImpl, actorType}` with lazy config/db (so `restore` and `guide` work without an openable DB). Mutations are journalled (best-effort row, or in the handler's own transaction when `journalsInHandler`).

Three projections of the same registry:
1. **CLI** (`cli.ts` + `operations/cli-args.ts`, 80 lines): `bun src/cli.ts <command> --flag value`, `--db PATH`, `--json`; help generated from the registry grouped by section; per-op `format` for terminal output, otherwise pretty JSON; output passes through secret redaction; `streams: true` ops (db backup/export, media archive) write bytes to stdout and print nothing else; `doctor` sets exit code 1 on failure; usage counters flushed on exit. Production route is `bun run ops:prod [--as alex|maru] <command>` = ssh + `docker exec ... bun /app/ops/cli.js` (maintainer-only, `scripts/ops-prod.ts` 168 lines, CI and AGENTS.md depend on the `ops` command name and `guide --json`).
2. **MCP ops tools**: every `agent: true` operation becomes tool `ops_<name with - -> _>` (44 tools), description `[section] summary (note)` and JSON Schema derived from the zod schema (`inputJsonSchema`, with CLI-only `placeholder` stripped).
3. **MCP studio tools**: `interfaces/mcp.ts` hand-written 39 `studio_*` tools (posts create/get/validate/status/history/attach/remove media/preview/edit/publish/schedule/cancel; videos create/list/get/preview/status/history/rename/replace targets/update metadata/schedule/preflight/publish/retry/remove target/cancel; capabilities, queue, notification settings, locale, channels, Zernio connection options, YouTube signature, media list), each with its own zod schema; errors map to JSON-RPC `-32602` with `path: message`. Total tool surface = **83 tools**. `tools/list` is built at module load. Both CLI and MCP go through `runOperation`, so input validation/coercion is shared (zod `.transform`s such as ISO instant parsing, de-duplicated id arrays).

Transport is plain JSON-RPC over HTTP POST plus a keep-alive SSE GET (no session state beyond a random `connection_id` echoed in the `endpoint` event). Usage tracking `studio.mcp.request` per call.

## 8. Dependencies and Rust equivalents

Runtime npm deps (`apps/backend/package.json`; root also lists `@mtcute/bun`):

| npm | Used in | Rust candidate | Risk |
|---|---|---|---|
| hono (4.x) | `api.ts` + 8 route modules only | axum + tower-http | Low. Small surface; need exact headers, strict=false trailing-slash behaviour, HEAD handling, Range (tower-http `ServeFile` or hand-rolled port of `ranged-file.ts` 59 lines), SSE (`axum::response::sse`), 1 GB streaming upload with cap |
| bun runtime (`Bun.serve`, `Bun.spawn`, `Bun.file`, `Bun.write`) | 25 call sites | tokio, tokio::process, tokio::fs | Low |
| bun:sqlite + drizzle-orm (124 files import it) + drizzle-kit/drizzle-zod | all persistence | rusqlite (bundled, `bundled` feature gives modern SQLite + JSON1) preferred over sqlx | Medium-high. Sync, `BEGIN IMMEDIATE`, `pragma_data_version`, TEMP triggers/ATTACH, `VACUUM INTO`, `RETURNING` are all used; rusqlite maps 1:1, sqlx abstracts away connection-level features (recommendation, not verified). The Drizzle query layer is the biggest hand-translation: 124 files, 69 `.returning`, 24 raw `sql` fragments; no ORM equivalent worth the churn (use plain SQL + small row structs) |
| zod 4 | config, MCP/ops input schemas, payload parsing (11 files) | serde + `schemars` (JSON Schema for MCP) + `validator`/manual | Medium. Zod gives validation + transforms + JSON Schema + human error text in one; MCP/ops error text (`path: message`) and the tool `inputSchema` JSON would have to be reproduced; generate golden JSON from TS `tools/list` and diff |
| grammy, @grammyjs/auto-retry, /menu, /runner | bot (69 files import grammy) | teloxide or frankenstein + custom retry/menu/sequentialize | High, but owned by the bot agent. `sequentialize` ordering and the menu plugin have no Rust twin; `bot.ts`/`interfaces/telegram` call `bot.api.*` directly |
| @mtcute/bun, @mtcute/core | Telegram **Stories** only (3 files) + login op | grammers-client / grammers-tl (raw `stories.sendStory`) | High, not verified: need to confirm grammers can invoke `stories.sendStory` with `InputMediaUploadedDocument` + entities and upload with the < 10 MiB part rules; mtcute session storage (SQLite file at `TELEGRAM_CHANNEL_STORIES_SESSION`) is not grammers-compatible, so a one-time re-login (`telegram-stories-login`) is likely. Fallback: keep this adapter as a tiny Bun/Node sidecar |
| sharp (libvips) | story card renderer only | resvg/usvg + tiny-skia + fontdb + `image` (JPEG 4:4:4 q92 via `jpeg-encoder`/`mozjpeg`) | Medium-high. Needs SVG `<text>` with a variable font (weights 680/440), `letter-spacing`, `feGaussianBlur`+feFlood+feComposite glow, cover-resize, JPEG chroma 4:4:4; pixel-identical output is not achievable, define a visual tolerance. Alternative: keep libvips via `libvips` bindings or shell out |
| image-size | `public/site-images.ts` | `imagesize` | Low |
| p-limit | ffmpeg limiter, publish concurrency | `tokio::sync::Semaphore` | Low |
| node:crypto | AES-256-GCM, HMAC-SHA256, SHA-256, randomUUID/Bytes, timingSafeEqual | `aes-gcm`, `hmac`, `sha2`, `rand`, `uuid`, `subtle` | Low (format must stay compatible, section 4) |
| `Intl.DateTimeFormat` / `Intl.PluralRules` (6 files: time.ts, i18n, story-cards/copy.ts, telegram backup) | zone-aware schedule math, offset labels (`shortOffset`), locale date display, CLDR plurals ru/en | chrono + chrono-tz, `icu` (ICU4X) for plural rules and localized date formatting | Medium. Owner-visible strings (bot, notifications) depend on exact Intl output; golden-test against Node output for ru/en |
| fetch/AbortSignal/URL/ReadableStream | all outbound HTTP | reqwest (rustls, stream, multipart), `url`, `tokio-util` | Low-medium: replicate 30 s per-request ceiling, redaction, retry-after parsing, resumable YouTube upload and chunked Telegram upload |
| `JSON.stringify` key order | ETag of `/api/public/site` is sha256 of the body | serde_json with `preserve_order` + struct field order | Medium: byte-identical body needed to keep ETags stable across the cutover (else every site client refetches once, harmless) and for diff-testing |
| tini / process model | entrypoint | static binary + tini (or `--init`), `nix`/`libc` for setuid | Low |

Dev-only (not ported): typescript 7.0.2, @biomejs/biome, lefthook, taze, knip, dependency-cruiser config, `tools/layer-checker`, drizzle-kit. Replace with `cargo clippy/fmt/test`, `cargo-deny`/`cargo audit`, and module visibility instead of `architecture.test.ts` + `check-layers.ts`.

Other porting hazards found:
- 1,506 i18n keys (en + ru) in a TS object, used with `{name}` interpolation; port as static data (include_str! JSON/TOML) generated once from the TS catalog.
- `ApplicationPorts` (477 lines) is a facade of 13 store objects plus clock; closures over a live mutable `config`; many modules take `fetchImpl` for test injection. In Rust: traits or a `Http` trait object injected at the edges; use `Arc<ArcSwap<Config>>`.
- Single-threaded JS gave implicit mutual exclusion in a few in-process caches (module-level Maps/WeakMaps, `activeMediaUploads`, `serialQueue` per platform in `delivery/ports/social.ts`, feed cache keyed by DB handle). These need explicit locks in tokio.
- `STUDIO_MEDIA_MAX_BYTES = 1_000_000_000`; `Prefer: wait=25` long poll holds an HTTP connection while polling DB every 3 s.

## 9. Tests

Framework `bun test` (`bun:test` `describe/it/expect`), preload `tests/helpers/no-network.ts` makes any unstubbed non-loopback `fetch` throw. Helpers open in-memory DBs (`helpers/db.ts`, `open-db.ts`, plus fixtures for posts/videos/channels/analytics). Counts: **166 `*.test.ts` files in `apps/backend/tests` (26,383 lines), 1,146 tests**; `deploy/` has 3 test files (355 lines), 9 tests; total 1,155 (counted by grep of line-leading `test(`/`it(`; `test.each`/nested forms may be undercounted, so treat as a floor). About 22 files / ~190 tests are bot/UI (`bot*.test.ts`, `botScreens` golden `tests/screens/bot-screens.txt`, `dialogUi`, `callbackEffects`, `message`, `text`, `titleEmphasis`, `i18n`): bot agent's scope.

Do not port as-is: `architecture.test.ts` (227 lines, reads TS source text for layering), `schemaMatchesMigrations` (Drizzle-specific), `selfHostInstall`/`deployment`/`deployRelease`/`opsProd`/`proxyTopology` (test scripts and Caddy, unchanged while those stay TS), `interfaceContour`/`surfaceParity` (re-express against the Rust registry).

Contract tests to port first (behaviour that is externally visible or silently breaks delivery), by area:
- Wire contracts: `publicSite` (22), `siteReadModel` (17), `siteParity`, `siteImages`, `siteMedia`, `siteMetadata`, `siteModified`, `http` , `mediaUpload`, `rangedFile`, `mcpStudio`, `opsRegistry` (15), `operationsGuide`, `surfaceOutputRedaction`, `config` (12), `apiKeys`
- Data invariants: `db`, `dateIntegrity`, `dailyBackup`, `backupExport`, `dataDirs`, `operationalRetention`
- Publishing state machine: `queue` (33), `publicationPlan` (13), `publicationState`, `publicationOwnership`/`Owner`, `jobPolicy`, `jobPhase`, `publishErrors`, `ambiguousPublication`, `settle`, `postRetry`, `postResend`, `postRecoveryScenario`, `publicationReconciliation` (12), `deliveryCancellation`, `actionLock`, `resumeFrom`, `skipOperation`, `lifecycleOperations`, `schedule`, `scheduler`, `workerRegistry`, `runtimeWorkers`, `workerSignal`
- Adapters (stubbed HTTP): `telegramPublisher`, `telegramErrors`, `xPublisher`, `xOauth`, `xArticle`, `xContentState`, `threadsPublisher` (23), `threadsAuthorize`, `metaOauth`, `metaTokens`, `tokenHealth`, `instagramContainer`, `discordPublisher`, `zernioPublish`, `zernioConnections`, `videoPublishers` (19), `providerRouting`, `socialPorts`
- Video/media: `video` (29), `videoFsm`, `videoWorker`, `videoSettle`, `videoCancel`, `videoRescheduleGuard`, `videoMetadataLimits`, `mediaProcessor` (29), `mediaPrepare`, `mediaPolicy`, `mediaIdempotency`, `ffmpeg`, `storyCards`, `stories`, `storyDerivatives`, `telegramStoryDelivery`
- Studio services: `studioPosts`, `studioServices`, `threadParts`, `postTranslation`, `markdownArticle`, `textLocale`, `time`/`videoTime` (zone math)

Extra suggestion (not in repo): record golden HTTP/MCP transcripts from the TS server against `dev-seed.ts` fixtures (`bun scripts/dev-seed.ts`) and replay them against the Rust server.

## 10. Suggested phases (each deployable and verifiable)

Line counts are TS lines to port (src only, from section 1); tests to port are in addition (~63% of src size overall). Total src 42.4k; bot-related ~10.1k (incl. i18n); non-bot ~32.3k.

Constraint that shapes the order: one SQLite file, one writer process per Studio, one Telegram bot token (long polling cannot run in two processes), and the TS server currently owns migrations. So the cutover is per capability, not per process, until the last phase. Two processes can share the WAL database safely for reads (the TS code already does this between server and CLI, with `busy_timeout` 30 s) but only one may run the loops and the bot.

| # | Phase | Scope (TS source) | ~Lines | Deployable / how verified |
|---|---|---|---|---|
| 0 | Foundations + DB layer | `foundation/*` (excl. i18n catalog) 2.2k, `db/*` (client, schema as SQL, date guards, 12 repositories) 2.7k, `application/` 0.6k, `studio.ts`/`json.ts`; migrations runner compatible with the existing drizzle bookkeeping; date-guard + `post_locales` triggers; AES-GCM secret box; config loader with all production invariants; logger with redaction | ~5.7k | Not deployed. Verify: open a copy of the production DB, run schema diff (61 tables/519 columns/107 indexes), config + date + db + secret tests, decrypt a `platform_tokens` row written by TS |
| 1 | Read-only HTTP edge | `interfaces/http` health/discovery/public-site/media serving, `public/*`, `foundation/ranged-file`, `/.well-known/*`, IndexNow key file | ~1.0k | Deploy as a second process behind Caddy path split (`/api/public/site`, `/media/*`, `/generated/*`, health) against the live DB read-only. Verify: byte-for-byte diff of `/api/public/site` body + ETag vs TS on the same DB, Range/HEAD/304/long-poll tests. Lowest-risk first win, proves axum + rusqlite + feed cache invalidation |
| 2 | Publishing + Studio core | `publishing/*` 4.8k, `content/*` 1.0k, `studio/*` 2.3k (services posts/videos/queue/settings/channels/media, video FSM), `observability/usage` bits | ~8.1k | Library only, exercised by tests and by phase 4 CLI. Verify: ported contract tests (queue, state machine, retry policy, schedule/zone math, ambiguous publication, cancellation), plus SQL equivalence harness: run the same scripted scenarios in TS and Rust against two copies of one DB and diff resulting tables |
| 3 | Delivery workers + platform adapters | `delivery/*` 6.1k (publish workflow, reconciliation, site jobs/media, video worker, media prepare, remote media client, Zernio, IndexNow, platform ports) + `channels/*` 1.3k (OAuth, token stores/renewal, registry) + `foundation/external/*` + story-cards 0.6k | ~8.0k | Port adapter by adapter behind a feature gate while TS keeps running the loops: order Telegram(Bot API, plain fetch) -> site jobs/media (ffmpeg) -> Discord -> X -> Threads -> Instagram -> YouTube -> Zernio -> story cards -> Telegram Stories (MTProto, highest risk, last or sidecar). Verify per adapter with stubbed HTTP tests, then a shadow run on a staging Studio (maru is the natural canary: `Deploy-Maru: yes` trailer promotes only what alex proved healthy, so canary first on the Studio that publishes less) |
| 4 | Operations: registry, CLI, MCP, observability | `operations/*` 6.5k, `interfaces/mcp.ts` + `mcp-protocol` 0.7k, `/api/mcp`, `/api/studio/media`, OAuth routes 0.2k, `observability/*` 1.6k, `notifications/` 0.1k, `cli.ts`, `scheduler`, `worker-signal`, `worker-state` | ~9.3k | CLI + MCP on Rust. Verify: golden `tools/list` JSON (83 tools) and `ops guide --json` diff vs TS; ported `opsRegistry`/`mcpStudio`/`surfaceParity` tests; run read-only ops (`status`, `audit`, `doctor`) against a prod DB copy. After this the Rust binary can replace `bun /app/ops/cli.js`, keeping the `ops` command contract used by `ops:prod` |
| 5 | Telegram bot + Telegram interface adapters | `bot/*` 6.7k, `interfaces/telegram/*` 1.4k (event consumer, control cards, previews, video notifications, daily backup, ingress), `bot.ts`/`botTargets.ts` 0.3k, i18n catalog 1.7k, translation/albums workers | ~10.1k | Owned by the bot agent; interface to rest = `StudioServices`, `BackendDb` ports, `foundation/i18n`, `effects`/`conversation-state`, `studio/services/settings`, `story-cards/store` (bot imports: foundation 127, studio 57, db 34, application 14, interfaces 12, publishing 10, content 8, channels 6 import statements). Verify: ported bot tests + golden screens (`tests/screens/bot-screens.txt`), manual taps on a test bot |
| 6 | Single-binary cutover + packaging | `runtime/*` 0.35k (entrypoint privilege drop, workers wiring, shutdown), Dockerfile (static ffmpeg, glibc not needed unless libvips kept), compose, `install.sh` update, CI `check.yml` rewrite (cargo build/test/clippy, image build, `/readyz` gate, Maru promotion), `scripts/ops-prod.ts` path, healthcheck (currently `bun -e fetch`), decide fate of `deploy/deploy-agent.ts` (632) and `deploy/media-processor` (559) which are independent Bun services and may stay | ~0.4k + infra | Cutover on alex's canary Maru first: stop TS container, start Rust on the same volume (rollback = previous immutable image digest via the deploy agent; keep migrations backward compatible for one release because the old image must be able to open the DB). Verify: `/readyz`, all 19 worker heartbeats, one real publication end-to-end per platform |

Cross-cutting rules for the plan:
- Do the SQL-compatible DB layer first and share one canonical migration set; never let the Rust binary create schema TS cannot open during the dual-run window.
- Keep `ops` command names/outputs stable (CI, AGENTS.md and the maintainer's `ops:prod` depend on them).
- Design an injectable HTTP client from day one; the TS suite's strongest property is that every adapter is testable with stubbed `fetch`.
- Convert each phase's tests together with the code; treat the 1,146 backend tests as the specification (the project rule "tests where they earn their keep" applies; contract list is in section 9).

## 11. Top risks

1. Telegram Stories over MTProto (mtcute -> grammers or sidecar): unverified capability, session incompatibility, 9.5 MiB big-file quirk.
2. Persistence layer: replacing Drizzle across 124 files while preserving `BEGIN IMMEDIATE` claim/lease semantics, date-guard triggers, `data_version`/TEMP-trigger feed cache, and adopting the existing `__drizzle_migrations` bookkeeping on the production database.
3. Story card renderer (sharp/libvips SVG text with variable font and blur filter): no pixel-identical Rust path.
4. Behavioural parity of things Node gives for free: `Intl` zone/plural/date formatting (ru/en user-visible text), JSON byte output (public-site ETag), zod validation messages and JSON Schema (MCP tool schemas), in-process single-thread mutual exclusion.
5. Publishing to a live audience twice during cutover: shared bot token, one writer, two runtimes; delivery invariants (idempotent-or-ambiguous) must be preserved exactly. Mitigate with the phased/canary-on-Maru plan above.

Not verified / open: exact Drizzle bookkeeping table format; grammers support for `stories.sendStory`; whether `GROK_CLI_PATH` has any live consumer in `bot/`; exact test counts when `test.each`/nested tests are used; web UI: none exists in this repo, the "Command Center" name is a leftover with no route.
