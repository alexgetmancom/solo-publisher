set -euo pipefail

# The base is the last commit that actually reached production, not
# the push's previous tip. An amend or a rebase makes
# `github.event.before` a commit this history no longer contains, and
# the diff against it reports only what the rewrite touched: a backend
# fix pushed, then amended for a one-line test tweak, went green with
# nothing deployed. The deployment status this workflow writes on the
# commit it shipped is the record of what production is running, so
# every commit after it is what this run has to deploy.
base_sha=""
while IFS= read -r sha; do
  if [ "$sha" = "$HEAD_SHA" ]; then
    continue
  fi
  state=$(gh api "repos/$GITHUB_REPOSITORY/commits/$sha/status" \
    --jq '.statuses[] | select(.context == "production deployment") | .state')
  if [ "$state" = "success" ]; then
    base_sha="$sha"
    break
  fi
done < <(git rev-list --max-count=50 "$HEAD_SHA")
# Nothing in reach was deployed: a first run, a branch that never
# deploys, or a gap longer than the walk. Treating the whole history
# as the change deploys once too often, which is the safe direction.
if [ -z "$base_sha" ]; then
  base_sha=$(git rev-list --max-parents=0 "$HEAD_SHA" | tail -n 1)
fi
echo "Measuring changes since $base_sha"

media=false
dependencies=false
backend_image=false
deploy_agent=false
caddy_config=false
deployment=false

while IFS= read -r path; do
  case "$path" in
    deploy/media-processor/compose.yml|deploy/media-processor/Dockerfile|deploy/media-processor/Dockerfile.runtime-base|deploy/media-processor/server.ts|deploy/media-processor/service.ts|deploy/media-processor/story-encode.ts|shared/serial-queue.ts)
      media=true
      deployment=true
      ;;
    bun.lock | package.json | */package.json)
      dependencies=true
      backend_image=true
      deployment=true
      ;;
    apps/web/*|apps/backend/src/*|apps/backend/assets/*|apps/backend/drizzle/*|apps/backend/tsconfig.json|apps/backend/Dockerfile.release|apps/backend/Dockerfile.runtime-base|astro.config.ts|bunfig.toml|scripts/generate-responsive-images.ts|scripts/image-smoke.ts|svelte.config.ts|tsconfig.base.json|tsconfig.json)
      backend_image=true
      deployment=true
      ;;
    deploy/studio.compose.yaml | deploy/alex.env | deploy/maru.env | scripts/deploy-release.ts)
      deployment=true
      ;;
    deploy/deploy-agent.ts | deploy/retry.ts)
      deploy_agent=true
      deployment=true
      ;;
    deploy/caddy/*)
      caddy_config=true
      deployment=true
      ;;
    .github/workflows/check.yml)
      backend_image=true
      deployment=true
      ;;
  esac
done < <(git diff --name-only --no-renames "$base_sha" "$HEAD_SHA")

# A failed deployment deliberately leaves :latest on production's
# previous image. Every later deployment revision therefore needs
# its own image; reusing :latest here would silently roll code back.
if [ "$deployment" = "true" ]; then
  backend_image=true
fi

{
  echo "media=$media"
  echo "dependencies=$dependencies"
  echo "backend_image=$backend_image"
  echo "deploy_agent=$deploy_agent"
  echo "caddy_config=$caddy_config"
  echo "deployment=$deployment"
} >> "$GITHUB_OUTPUT"

# A `Deploy-Maru: yes` trailer on any commit in the push promotes the
# release to the second Studio in the same run. Read as a trailer, not
# as a substring of the message: a subject that merely mentions Maru,
# or a quoted trailer inside a body, must not deploy to an audience.
maru_promote=false
while IFS= read -r sha; do
  if git log -1 --format=%B "$sha" | git interpret-trailers --parse | grep -qiE '^Deploy-Maru:[[:space:]]*(yes|true)$'; then
    maru_promote=true
  fi
done < <(git rev-list "$base_sha".."$HEAD_SHA")

# The trailer asks for a promotion of this run's release. Without a
# deployment there is no release to promote, and silently ignoring the
# request is how a Maru change sits unshipped while the push is green.
if [ "$maru_promote" = "true" ] && [ "$deployment" != "true" ]; then
  echo "Deploy-Maru was requested but nothing in this push deploys." >&2
  exit 1
fi
echo "maru_promote=$maru_promote" >> "$GITHUB_OUTPUT"

echo "Changed areas: media=$media dependencies=$dependencies backend_image=$backend_image caddy_config=$caddy_config deployment=$deployment maru_promote=$maru_promote"
