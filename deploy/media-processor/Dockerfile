# The remote media processor: the `media-processor` binary (crates/media_processor)
# on the VAAPI ffmpeg runtime base (Dockerfile.runtime-base). Nothing else runs here.
#
# Build context: the repository root, filtered by Dockerfile.dockerignore beside
# this file.
ARG RUNTIME_BASE_IMAGE=ghcr.io/alexgetmancom/alexgetman-media-processor:runtime-base

# cargo-chef's image is rust:1.100-bookworm with cargo-chef on it.
FROM lukemathwalker/cargo-chef:0.1.78-rust-1.100-bookworm@sha256:9573268a2a874efc1c755a0094a50c25988b2c6a0b7a520ddb7fd08d868d1c43 AS chef
WORKDIR /src

# Every workspace manifest has to be present for cargo to resolve the lock;
# the recipe is unchanged while Cargo.toml and Cargo.lock are.
FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS build
COPY --from=planner /src/recipe.json recipe.json
# Empty means one job per CPU; a memory-tight builder passes a number.
ARG CARGO_JOBS=
# Only the processor's own dependency graph, as a layer the build cache keeps
# while recipe.json is unchanged. No cache mounts: they are empty on a fresh
# runner, so the registry and target live in the layer.
RUN cargo chef cook --release --locked ${CARGO_JOBS:+-j $CARGO_JOBS} -p media_processor --recipe-path recipe.json
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --locked ${CARGO_JOBS:+-j $CARGO_JOBS} -p media_processor \
  && install -D -m 0755 target/release/media-processor -t /out/

FROM ${RUNTIME_BASE_IMAGE}
COPY --from=build /out/media-processor /usr/local/bin/media-processor
EXPOSE 8787
CMD ["/usr/local/bin/media-processor"]
