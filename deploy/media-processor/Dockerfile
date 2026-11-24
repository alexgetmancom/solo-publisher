# The remote media processor: the `media-processor` binary (crates/media_processor)
# on the VAAPI ffmpeg runtime base (Dockerfile.runtime-base). Nothing else runs here.
#
# Build context: the repository root, filtered by Dockerfile.dockerignore beside
# this file.
ARG RUNTIME_BASE_IMAGE=ghcr.io/alexgetmancom/alexgetman-media-processor:runtime-base

FROM rust:1.100-bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea AS build
WORKDIR /src
# Every workspace manifest has to be present for cargo to resolve the lock;
# only the processor's own dependency graph is compiled.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# Empty means one job per CPU; a memory-tight builder passes a number.
ARG CARGO_JOBS=
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked ${CARGO_JOBS:+-j $CARGO_JOBS} -p media_processor \
  && install -D -m 0755 target/release/media-processor -t /out/

FROM ${RUNTIME_BASE_IMAGE}
COPY --from=build /out/media-processor /usr/local/bin/media-processor
EXPOSE 8787
CMD ["/usr/local/bin/media-processor"]
