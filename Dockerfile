# The Studio: one image, one container.
#
# studio-entrypoint (crates/entrypoint) runs under `tini -g`: as root it fixes
# data directory ownership and drops to `studio` (uid 1000) through setpriv,
# then becomes the Studio (`solo-publisher`), which posts Telegram channel
# Stories over MTProto itself (crates/mtproto). The operations CLI is `ops` on
# PATH (`cargo xtask ops-prod <command>` runs it), and the healthcheck is
# `studio-entrypoint --ready`.
#
# The image also carries that binary, `/app/bin/deploy-agent`, which never runs
# here: the deployment copies it out onto the host (`cargo xtask
# deploy-release`). It is static (musl), so it runs on whatever C library the
# host has.
#
# Build context: the repository root, filtered by Dockerfile.dockerignore.

# --- Studio binaries ---
# cargo-chef's image is rust:1.100-bookworm with cargo-chef on it.
FROM lukemathwalker/cargo-chef:0.1.78-rust-1.100-bookworm@sha256:9573268a2a874efc1c755a0094a50c25988b2c6a0b7a520ddb7fd08d868d1c43 AS chef
WORKDIR /src
RUN rustup target add x86_64-unknown-linux-musl

# The workspace reduced to what its dependencies depend on: unchanged while
# Cargo.toml and Cargo.lock are, whatever the sources do.
FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS studio-build
COPY --from=planner /src/recipe.json recipe.json
# Empty means one job per CPU; a memory-tight builder passes a number.
ARG CARGO_JOBS=
# The dependencies as their own layer, which the build cache keeps while
# recipe.json is unchanged: they were 279 of the 297 crates every release
# compiled. No cache mounts, so the registry and target live in the layer.
RUN cargo chef cook --release --locked ${CARGO_JOBS:+-j $CARGO_JOBS} -p app -p entrypoint -p ops --recipe-path recipe.json \
  && cargo chef cook --release --locked ${CARGO_JOBS:+-j $CARGO_JOBS} --target x86_64-unknown-linux-musl -p deploy_agent \
       --recipe-path recipe.json
# rust-toolchain.toml stays out of the context: the image is the toolchain, and
# the file's component list would make rustup download clippy and rustfmt.
COPY Cargo.toml Cargo.lock ./
# crates/db/build.rs embeds crates/db/migrations, the single source of the schema.
COPY crates ./crates
RUN cargo build --release --locked ${CARGO_JOBS:+-j $CARGO_JOBS} -p app -p entrypoint -p ops \
  && cargo build --release --locked ${CARGO_JOBS:+-j $CARGO_JOBS} --target x86_64-unknown-linux-musl -p deploy_agent \
  && install -D -m 0755 target/release/solo-publisher target/release/studio-entrypoint target/release/ops \
       target/x86_64-unknown-linux-musl/release/deploy-agent -t /out/

# --- Runtime ---
FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0 AS studio
# setpriv comes with util-linux in the base. uid and gid 1000 own the data
# volumes production already has.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 studio \
  && useradd --uid 1000 --gid studio --shell /bin/sh --create-home studio
# Unpacked as-is: upx would cost every launch.
COPY --from=mwader/static-ffmpeg:6.1.1@sha256:a44cd22b260c527f54e99517186a209b805d0a2319e0886d356e840f62a72132 /ffmpeg /usr/local/bin/
COPY --from=mwader/static-ffmpeg:6.1.1@sha256:a44cd22b260c527f54e99517186a209b805d0a2319e0886d356e840f62a72132 /ffprobe /usr/local/bin/
WORKDIR /app
# STORY_CARD_ASSETS_DIR's default: background, Manrope, Noto Color Emoji and
# the emoji SVGs. The renderer reads its fonts from here, not from fontconfig.
COPY crates/story_render/assets ./assets
COPY --from=studio-build /out/ ./bin/
# `ops`, `studio-entrypoint` and the rest by name.
ENV PATH=/app/bin:$PATH

ARG GIT_REVISION=unknown
ENV GIT_REVISION=${GIT_REVISION}

# Stays root: the entrypoint fixes bind-mount ownership, then drops for good.
# `docker exec` bypasses it, so pass `-u studio` there. `-g` delivers a stop
# signal to the whole group, the Studio included.
ENTRYPOINT ["tini", "-g", "--", "/app/bin/studio-entrypoint"]
