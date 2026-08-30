# Указываем дефолтный источник сборки (in-docker для локальной сборки на Mac)
ARG BUILD_SOURCE=in-docker

# --- СТАДИЯ FFMPEG (полностью изолированная и кэшируемая) ---
# Copy the binaries as-is without upx. Measured 2026-07-26: the compressed image
# is the same size with `upx -1` (140 MB) because the layer gzip does the same
# work, while upx adds about 318 ms of decompression to every ffmpeg/ffprobe
# launch. The video pipeline launches them dozens of times per publication, and
# `--best --lzma` is worse at about 1230 ms. Disk maintenance is kept outside
# the deployment critical path.
FROM oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef AS ffmpeg-bin
USER root
COPY --from=mwader/static-ffmpeg:6.1.1@sha256:a44cd22b260c527f54e99517186a209b805d0a2319e0886d356e840f62a72132 /ffmpeg /tmp/ffmpeg
COPY --from=mwader/static-ffmpeg:6.1.1@sha256:a44cd22b260c527f54e99517186a209b805d0a2319e0886d356e840f62a72132 /ffprobe /tmp/ffprobe

# --- СТАДИЯ СБОРКИ ВНУТРИ ДОКЕРА (для локальной сборки на Mac) ---
FROM oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef AS build-in-docker
WORKDIR /app
# Сначала копируем только конфигурации и файлы package.json для кэширования
COPY --chown=bun:bun package.json bun.lock tsconfig.json tsconfig.base.json astro.config.ts svelte.config.ts biome.json knip.json ./
COPY --chown=bun:bun apps/backend/package.json ./apps/backend/package.json
COPY --chown=bun:bun tools/knip/package.json ./tools/knip/package.json
COPY --chown=bun:bun tools/svelte-check/package.json ./tools/svelte-check/package.json
COPY --chown=bun:bun tools/layer-checker/package.json ./tools/layer-checker/package.json

RUN chown bun:bun /app
USER bun
RUN --mount=type=cache,target=/home/bun/.bun,uid=1000,gid=1000 bun install --frozen-lockfile --ignore-scripts

# Теперь копируем исходный код
COPY --chown=bun:bun apps/backend ./apps/backend
COPY --chown=bun:bun apps/web ./apps/web
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun tools/knip ./tools/knip
COPY --chown=bun:bun tools/svelte-check ./tools/svelte-check
COPY --chown=bun:bun tools/layer-checker ./tools/layer-checker
# Backend shares the Story encoder with the isolated media-processor service.
# Keep the single source in the in-Docker TypeScript build context as well.
# The whole directory, not just story-encode.ts: the backend's own tests import
# service.ts too, and the typecheck below runs across them.
COPY --chown=bun:bun deploy/media-processor ./deploy/media-processor

RUN bun run --filter @solo-publisher/backend typecheck
RUN DATA_DIR=/data bun run build
RUN bun build apps/web/server.ts --outdir runtime --target bun --splitting --minify --sourcemap=external
RUN bun build apps/backend/src/cli.ts --outdir ops --target bun --minify --sourcemap=external
RUN bun build apps/backend/src/runtime/docker-entrypoint.ts --outdir entrypoint --target bun --minify --sourcemap=external
RUN bun build apps/backend/src/runtime/config-check.ts --outdir entrypoint --target bun --minify --sourcemap=external
RUN bun build apps/backend/src/story-cards/renderer-process.ts --outdir story-renderer --target bun --minify --sourcemap=external

# --- СТАДИЯ КОПИРОВАНИЯ ГОТОВОГО БИЛДА С ХОСТА (для сборки в GitHub Actions) ---
FROM scratch AS build-on-host
COPY dist /app/dist
COPY runtime /app/runtime
COPY ops /app/ops
COPY entrypoint /app/entrypoint
COPY story-renderer /app/story-renderer
COPY apps/backend/drizzle /app/apps/backend/drizzle
COPY apps/backend/assets /app/apps/backend/assets

# --- ДИНАМИЧЕСКИЙ ВЫБОР СТАДИИ СБОРКИ НА ОСНОВЕ ПЕРЕМЕННОЙ ---
FROM build-${BUILD_SOURCE} AS build

# --- PRODUCTION DEPENDENCIES ---
# Keep dependency installation and runtime on glibc-based images. Bun's musl
# runtime does not currently expose every N-API symbol Sharp needs, so an
# Alpine image can contain the correct native package and still fail on import.
FROM oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef AS prod-deps
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock tsconfig.json tsconfig.base.json astro.config.ts svelte.config.ts biome.json knip.json ./
COPY --chown=bun:bun apps/backend/package.json ./apps/backend/package.json
COPY --chown=bun:bun tools/knip/package.json ./tools/knip/package.json
COPY --chown=bun:bun tools/svelte-check/package.json ./tools/svelte-check/package.json
COPY --chown=bun:bun tools/layer-checker/package.json ./tools/layer-checker/package.json

RUN chown bun:bun /app
USER bun
# Build-only web packages live in root devDependencies, so the production
# install contains runtime packages without a manual build-tool blacklist.
# Bun installs optional native packages for both libc variants; the image is
# glibc-only, so discard the unusable musl copies in the same layer.
RUN --mount=type=cache,target=/home/bun/.bun,uid=1000,gid=1000 bun install --production --frozen-lockfile --ignore-scripts --linker hoisted \
  && rm -rf \
    node_modules/@img/sharp-libvips-linuxmusl-* \
    node_modules/@img/sharp-linuxmusl-* \
    node_modules/@bruits/satteri-linux-*-musl

# --- MINIMAL FINAL IMAGE ---
FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6 AS app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

# Keep commit-specific metadata after invariant OS packages so every revision
# can reuse the apt layer.
ARG GIT_REVISION=unknown
ENV GIT_REVISION=${GIT_REVISION}
ENV DRIZZLE_MIGRATIONS_DIR=/app/apps/backend/drizzle

# Копируем сжатые бинарники из изолированной стадии ffmpeg-bin
COPY --from=ffmpeg-bin /tmp/ffmpeg /usr/local/bin/
COPY --from=ffmpeg-bin /tmp/ffprobe /usr/local/bin/

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/runtime ./runtime
COPY --from=build /app/ops ./ops
COPY --from=build /app/entrypoint ./entrypoint
COPY --from=build /app/story-renderer ./story-renderer
# Bun emits mtcute's dynamically loaded WASM files beside the server bundle,
# while mtcute resolves them relative to the process working directory.
COPY --from=build /app/runtime/*.wasm ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/backend/drizzle ./apps/backend/drizzle
COPY --from=build /app/apps/backend/assets ./apps/backend/assets

# Stays root by default: the entrypoint fixes bind-mount ownership on a fresh
# volume, then drops privileges in-process before loading the server (see
# apps/backend/src/runtime/docker-entrypoint.ts). The app itself never runs as
# root — `docker exec` bypasses this entrypoint though, so pass `-u bun` there.
# `--smol` belongs here, not in a compose `command:`: the entrypoint loads the
# server into this same process, so anything after the script path would be
# passed to it as an ignored argument instead of taking effect as a Bun flag.
ENTRYPOINT ["tini", "--", "bun", "--smol", "/app/entrypoint/docker-entrypoint.js"]
