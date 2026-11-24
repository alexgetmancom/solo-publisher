# The Studio: one image, one container.
#
# studio-entrypoint (crates/entrypoint) runs under `tini -g`: as root it fixes
# data directory ownership and drops to `studio` (uid 1000) through setpriv,
# then becomes the Studio (`solo-publisher`), which posts Telegram channel
# Stories over MTProto itself (crates/mtproto). The operations CLI is `ops` on
# PATH (`docker compose exec app ops <command>`), and the healthcheck is
# `studio-entrypoint --ready`.
#
# The image also carries that binary, `/app/bin/deploy-agent`, which never runs
# here: the deployment copies it out onto the host (`cargo xtask
# deploy-release`). It is static (musl), so it runs on whatever C library the
# host has.
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
  && musl="$(uname -m)-unknown-linux-musl" \
  && rustup target add "$musl" \
  && cargo build --release --locked ${CARGO_JOBS:+-j $CARGO_JOBS} --target "$musl" -p deploy_agent \
  && install -D -m 0755 target/release/solo-publisher target/release/studio-entrypoint target/release/ops \
       "target/$musl/release/deploy-agent" -t /out/

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
