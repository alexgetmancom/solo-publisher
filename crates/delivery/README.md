# delivery — the delivery workers (Rust)

Port of the TypeScript `delivery/*` (minus the adapters, which are `crates/adapters`) and the retention routines of
`operations/maintenance.ts`. Every loop body takes a `Delivery` — the database, publishing's `Boundaries`, and one
`AdapterContext` (configuration snapshot, HTTP client, clock) for the whole cycle. Every write after an earlier check
carries that check in its `WHERE`; a step that may have reached an audience settles as ambiguous, never re-sent.

| Module | TypeScript |
|---|---|
| `publish_workflow` | `publish-workflow.ts` (+ `createPlatformPorts` as `delivery_ports`) |
| `reconciliation` | `publication-reconciliation.ts` |
| `external_edits`, `external_removals` | `external-edits.ts`, `external-removals.ts` |
| `media_prepare` | `media-prepare.ts` (`prepare_media_items`, `prune_media_cache`) |
| `story_media`, `story_derivatives` (`DeliveryMedia`) | `story-media.ts` + the local recipes of `deploy/media-processor/story-encode.ts`, `story-derivatives.ts` |
| `video_worker`, `video_retention` | `video-worker.ts`, `video-retention.ts` |
| `site_jobs`, `site_media`, `site_media_storage`, `site_index_now`, `site_content_index` | the `site-*.ts` files |
| `maintenance` | `pruneOperationalHistory`, `withMaintenanceLock` |
| `routing` | `targetRouting`, `videoChannelIdentity` |

`draft-story-media.ts` is `Posts::prepare_draft_story_media` in `domain` (it calls `StoryDerivatives::ensure`);
`ambiguous-publication.ts`, `platform-absence.ts`, `media-idempotency.ts` live in `adapters`.

## Wiring (`runtime/workers.ts`)

At startup: `publishing.recover_stale_publish_jobs(PUBLISH_RESTART_LOCK_GRACE_SECONDS)` and
`site_jobs::recover_stale_site_jobs(&d, SITE_JOB_RESTART_LOCK_GRACE_SECONDS)`. Then, each through the heartbeat loops:

| Loop | Interval | Body |
|---|---|---|
| `queue` | `IDLE_POLL_INTERVAL_SECONDS` + wake | `run_delivery_publish_cycle(&d, &delivery_ports(&d, media, stories)?)` |
| `publish-watchdog` | 60 s | `publish_workflow::recover_stale_publish_jobs(&d)` |
| `publication-reconciliation` | `max(60, IDLE_POLL)` s | `run_publication_reconciliation(&d)` |
| `video` | `IDLE_POLL_INTERVAL_SECONDS` | `video_worker::run_video_cycle(&d)` (recovers its locks first, prunes sources last) |
| `site` | 10 s, only while `site_jobs::site_enabled(&d)?` | `site_jobs::run_site_job_cycle(&d)` |
| `site-watchdog` | 60 s, same gate | `recover_stale_site_jobs(&d, SITE_JOB_LOCK_TIMEOUT_SECONDS)` |
| `media-cache` | 1 h | `prune_media_cache(d.config(), d.now_ms())` |
| `operational-retention` | 24 h | `with_maintenance_lock(sqlite, clock, \|\| prune_operational_history(sqlite, clock))` |

Boundaries for `app/src/host.rs`: one `DeliveryMedia::new(client, shared_config, clock)` per process is both the
adapters' `MediaPreparation` (`PreparedMedia::new(Rc::new(media.clone()))` via `delivery_ports`) and Studio's
`StoryDerivatives` (renders run on `spawn_local`, one at a time, shared by path). The worker bell is
`runtime::worker_signal::WorkerSignals`, woken by `set_worker_wake(WorkerQueue::Publish, Some(queue_loop.waker()))`.
Stories go through `mtproto::MtprotoStories::new(shared_config)` (`app` builds it).

## Parity

```
cargo test -p delivery        # needs bun, ffmpeg and ffprobe on PATH
```

`tests/{delivery,video,site}_scenarios.rs` run every scenario of their JSON spec through this crate and compare with
what the TypeScript modules did with it (`tests/*.golden.json`, recorded from the TypeScript backend before the cutover; nothing re-records them; data directories under
`/tmp/solo-publisher-goldens/`, because media cache keys hash the path; media inputs are `tests/fixtures/`; WebP
variants and posters, whose bytes follow the ffmpeg build, are compared by path and links), on fresh databases under one fixed clock, with the same canned platform answers (a canned answer may carry `sql`, run when
it is served: a lease taken over, a target edited mid-call). Compared: every step result, every request (method, URL,
headers, body), every table, and files on disk; credentials are `{{NAME}}`, the data directory `$DATA`, lease owners
`$HOST`/`$PID`/`$UUID`. Rust-only tests cover the deliberate deviations and what TypeScript cannot be driven to (a hung
provider under the publish timeout, lane independence).

## Deliberate deviations (delivery invariants)

- Reconciliation confirms a publish or video job and its target in one transaction, the target fenced on still being
  the unanswered publication (and its external id); when that fence fails both writes roll back and the job is released
  for a fresh read. TypeScript wrote the target after the job's fence alone.
- A video publish job whose target is held for verification leaves the target alone and completes, like a cancelled or
  published one; TypeScript failed it into `scheduled`/`failed`, the state an operator retries into a second upload.
- A publish attempt that times out is dropped at the timeout (no late write), as `runtime::timeout` does.

Other differences: an IndexNow failure is journalled by the next site cycle (the spawned send holds no database);
several render failures of one cycle are journalled in source order; the IndexNow batch is sorted by bytes; a new
IndexNow key is the hex of a random UUID; I/O error texts are Rust's.
