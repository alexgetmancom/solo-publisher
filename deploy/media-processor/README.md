# Remote media processor

The optional remote `MEDIA_PROCESSOR_PROVIDER=remote_http` executor. Its source
is the Rust binary `media-processor` (`crates/media_processor`); the ffmpeg
recipe it runs is `crates/vertical_media`, the same one the backend's `local`
provider encodes with on the CPU. This directory is its packaging: the image
(`Dockerfile`, on `Dockerfile.runtime-base`, Debian's ffmpeg with Intel's iHD
VAAPI driver), the VM's `compose.yml` and the tunnel unit. The `local` provider
does not contact this service.

## Self-hosting modes

Choose one media execution mode per backend installation:

- `local`: the backend container performs media transforms with its bundled CPU
  ffmpeg. Use this when the application host has enough CPU and memory.
- `remote_http`: the backend keeps the application, database, Telegram polling,
  and publication queues, while this service performs the expensive Story and
  short-form video encoding on another host. A reverse tunnel or private
  network endpoint can carry the authenticated requests.

The application worker and this media processor are different roles. A remote
media processor must not be confused with the optional second backend runtime;
starting both backend runtimes against one SQLite database and bot token is not
the normal deployment mode.

In the maintainer's production deployment, the backend runs on the VPS and the
remote media processor runs on VM-106 (`agent106`) with VAAPI. The backend does
not use its local encoder for the heavy Story and short-form video transform in
that mode. Small auxiliary work such as upload normalization, poster extraction,
responsive image variants, and compatibility fallbacks may still run locally.
Other self-hosted installations may select `local` instead.

## Runtime contract

The binary listens on `0.0.0.0:8787` and reads `MEDIA_PROCESSOR_TOKEN` (at least
16 characters, or it refuses to start), `MEDIA_PROCESSOR_WORK_DIR` (`/work`),
`MEDIA_PROCESSOR_MAX_BYTES` (1 GiB), `MEDIA_PROCESSOR_TIMEOUT_SECONDS` (900, the
ffmpeg run alone), `MEDIA_PROCESSOR_CACHE_TTL_SECONDS` (86400),
`MEDIA_PROCESSOR_RETRY_AFTER_SECONDS` (60) and `MEDIA_PROCESSOR_REVISION`. A
number that does not parse refuses the start. Rendered variants are cached as
`${WORK}/cache/<key>.<standard|telegram>.<mp4|jpg>` (written beside the name and
renamed into it); every hour, cache entries and request folders older than the
cache TTL are removed.

The remote image requires an Intel VAAPI render node and encodes video Stories
as H.264 through `h264_vaapi`. Configure the host compose environment with an
immutable image reference:

```dotenv
MEDIA_PROCESSOR_IMAGE=ghcr.io/<owner>/alexgetman-media-processor@sha256:<digest>
MEDIA_PROCESSOR_TOKEN=<random secret shared with the backend>
```

`compose.yml` deliberately has no `build:` directive. A production worker must
run the digest built by CI, never a hand-copied source tree. The compose file
also maps `/dev/dri/renderD128`; hosts without Intel VAAPI must select the
backend's explicit `local` provider instead of silently falling back.

## Deployment model

CI builds and publishes this image on `main` when the processor or the recipe
crate changes, when the workspace manifests or `Cargo.lock` change, or when this
directory's `Dockerfile*` or `compose.yml` do (`.github/workflows/check.yml`,
the `media=true` paths). Other releases reuse the last tested immutable digest. Image activation
is intentionally manual: a deployment target selects a tested digest, pulls it,
recreates only `media-processor`, probes `/health`, and restores the previous
digest if that probe fails. Target names, image repository, compose path, service
name, health URL, and deployment transport belong in deployment configuration;
none are tied to a particular account or VM name.

For a migration from a legacy hand-built process, the one-time
`DEPLOY_ALLOW_INITIAL_SEED=true` setting permits the first immutable deployment
without inventing a rollback revision. If it fails, it reports that fact and
does not claim to have rolled back. Remove the setting after the first healthy
image: every later deployment then has a genuine previous digest.

The initial host bootstrap installs the compose file, a private deployment
agent, and an outbound management tunnel. Afterwards the agent receives only
immutable digests. Do not edit files in the worker directory or run `docker
compose build` there: both create source drift from this directory.

## Operations diagnostics

The backend operations CLI reaches the processor over the same production
tunnel used by publication:

```sh
cargo xtask ops-prod media-status
cargo xtask ops-prod media-diagnose
cargo xtask ops-prod media-job --ref post:106
cargo xtask ops-prod media-reprocess --ref post:106
```

`media-diagnose` runs a fixed idempotent image fixture and never publishes.
`media-reprocess` is a dry run unless `--apply` is present; applying it only
creates or warms Story media variants and still never calls a social provider.

The worker owns one hardware encoder slot. Identical in-flight requests share
that work by content-derived idempotency key. Distinct work received while the
slot is occupied returns `429 media_processor_busy` with `Retry-After`; the
durable site or publish queue retries it later. `/health` reports `status:
"busy"` and `ok: false` while the slot is occupied, so a shallow HTTP response
cannot hide exhausted processing capacity.

Wide media builds its blurred backdrop at 540×960 before scaling that already
soft image to 1080×1920. Keep the foreground at full output resolution. A
production-source VM-106 benchmark measured the two-output 53-second Story at
about 69 seconds with this recipe, down from about 275 seconds when the
ten-pass blur ran over every full-resolution frame.

## Shared short-form output

Site video and Instagram Stories use the same `standard` H.264 derivative,
limited to 59 seconds. Telegram Stories use the companion `telegram`
derivative, whose bitrate is reduced to stay safely below the upload boundary.
Both outputs come from one ffmpeg filter graph: decode, backdrop blur, foreground
scale, and overlay happen once before the prepared frames split into the two
hardware encoders.

The backend derives the processor idempotency key from the source bytes and one
shared recipe identity. Site and social jobs therefore converge on the same
cache entry even when they run independently or in a different order. The
first request performs the work; later and concurrent requests reuse it.
