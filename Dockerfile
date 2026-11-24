# The Studio: one image, one container.
#
# studio-entrypoint (crates/entrypoint) runs under `tini -g`: as root it fixes
# data directory ownership and drops to `bun` (uid 1000) through setpriv, then
# becomes the Studio (`solo-publisher`), which posts Telegram channel Stories
# over MTProto itself (crates/mtproto). The Bun base stays for the two shims the
# deploy tooling calls: `bun /app/ops/cli.js` and `bun /app/entrypoint/config-check.js`.
#
# Build context: the repository root, filtered by Dockerfile.dockerignore.

# --- Studio binaries ---
FROM rust:1.100-bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea AS studio-build
WORKDIR /src
# rust-toolchain.toml stays out of the context: the image is the toolchain, and
# the file's component list would make rustup download clippy and rustfmt.
COPY Cargo.toml Cargo.lock ./
# crates/db/build.rs embeds crates/db/migrations, the single source of the schema.
COPY crates ./crates
# Empty means one job per CPU; a memory-tight builder passes a number.
ARG CARGO_JOBS=
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked ${CARGO_JOBS:+-j $CARGO_JOBS} -p app -p entrypoint -p ops \
  && install -D -m 0755 target/release/solo-publisher target/release/studio-entrypoint target/release/ops -t /out/

# --- Runtime ---
FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6 AS studio
# setpriv comes with util-linux in the base.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
# Unpacked as-is: upx would cost every launch.
COPY --from=mwader/static-ffmpeg:6.1.1@sha256:a44cd22b260c527f54e99517186a209b805d0a2319e0886d356e840f62a72132 /ffmpeg /usr/local/bin/
COPY --from=mwader/static-ffmpeg:6.1.1@sha256:a44cd22b260c527f54e99517186a209b805d0a2319e0886d356e840f62a72132 /ffprobe /usr/local/bin/
WORKDIR /app
# STORY_CARD_ASSETS_DIR's default: background, Manrope, Noto Color Emoji and
# the emoji SVGs. The renderer reads its fonts from here, not from fontconfig.
COPY crates/story_render/assets ./assets
COPY --from=studio-build /out/ ./bin/
# The operations CLI: `bun /app/ops/cli.js <command>` (scripts/ops-prod.ts,
# docs/install.md) runs /app/bin/ops, which is also on PATH as `ops`.
COPY crates/ops/image/cli.js ./ops/cli.js
# The deploy agent's configuration check of a new image:
# `bun /app/entrypoint/config-check.js` runs `studio-entrypoint --check-config`.
COPY crates/entrypoint/image/config-check.js ./entrypoint/config-check.js
ENV PATH=/app/bin:$PATH

ARG GIT_REVISION=unknown
ENV GIT_REVISION=${GIT_REVISION}

# Stays root: the entrypoint fixes bind-mount ownership, then drops for good.
# `docker exec` bypasses it, so pass `-u bun` there. `-g` delivers a stop
# signal to the whole group, the Studio included.
ENTRYPOINT ["tini", "-g", "--", "/app/bin/studio-entrypoint"]
