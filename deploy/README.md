# Production deployment agent

The deploy agent (`crates/deploy_agent`, binary `deploy-agent`) is a small
host-side service and the only component allowed to invoke Docker. The Studio
application never mounts the Docker socket and can only request a rollback or a
promotion through the agent's private bearer-authenticated routes.

The binary ships inside the Studio image at `/app/bin/deploy-agent`, built
static (musl) so it runs on the host whatever its C library. It never runs in
the container: every deployment (`cargo xtask deploy-release`, CI's `deploy`
job) copies it out of the image it is about to activate into
`/home/deploy/bin/deploy-agent`, and when it differs from the one there,
replaces it and restarts `alexgetman-deploy-agent`. What that restart runs is
the unit's `ExecStart`; a host still on the TypeScript agent keeps running it
until it is switched (below).

## One-time host setup

1. Create stable runtime directories. Keep configuration and the SQLite databases
   on the system disk, but use the mounted data disk for disposable media:

   ```text
   /home/deploy/alexgetman-runtime/compose.yaml
   /home/deploy/alexgetman-runtime/secrets.env
   /home/deploy/alexgetman-runtime/deploy-image.env
   /home/deploy/maru/compose.yaml
   /home/deploy/maru/secrets.env
   /home/deploy/maru/deploy-image.env
   ```

   `deploy-image.env` must initially contain the immutable image that is currently
   working, for example `BACKEND_IMAGE=ghcr.io/alexgetmancom/solo-publisher@sha256:...`.
   Never seed it with `latest`; rollback is deliberately refused without a digest.

   The shared [studio.compose.yaml](studio.compose.yaml) and each Studio's
   non-secret environment ([alex.env](alex.env), [maru.env](maru.env)) are
   committed. CI installs and validates them atomically on every deployment.
   `deploy-image.env` keeps the currently deployed immutable image alongside
   those committed values; edit the files here, never on the host.

2. Copy `deploy-agent.env.example` to `/etc/alexgetman/deploy-agent.env`, fill the
   token/chat values, and set mode `0600`. Set `DEPLOY_AGENT_HOST` to the gateway
   address of the Docker network used by the backends (obtain it with
   `docker network inspect agent_default`). Set `DEPLOY_TARGETS_JSON` exactly as
   shown in that example: it gives Alex and Maru independent health checks and
   rollback histories. Maru's host health endpoint must be bound to `127.0.0.1:8789`.

   The media paths in the committed environments live on the mounted
   `/mnt/alex-media` disk. No Studio writes backups to this host at all: both are
   pulled as streams by the backup machine at home, which reaches in with a key
   pinned to `/home/deploy/bin/alexgetman-backup-export`, and `doctor` fails a
   deployment whose media has not been pulled for a week.
   `DEPLOY_AGENT_HOST_GATEWAY` in each Studio's
   environment must name the same address the agent binds: Docker's own
   `host-gateway` points at the default bridge, while the agent listens on the
   gateway of `agent_default`, and a container aimed at the wrong one reaches
   nothing.

   The host's single Telegram Bot API server is deployed once from
   `deploy/bot-api.compose.yaml` and is not part of any Studio. Both backends
   reach it at `http://bot-api:8081` over `agent_default` and mount its
   download directory read-only via `BOT_API_DATA_DIR_HOST`.

   The backend containers also use the host's Grok CLI installation, and each Studio
   gets its own copy of it: `STUDIO_GROK_DIR_HOST` names a directory that only that
   Studio mounts at `/home/deploy/.grok`. The mount is writable because Grok refreshes
   its credentials and keeps sessions, locks and headless-run state there — which is
   exactly why it cannot be shared: two Studios pointed at one directory write over
   each other's sessions and credentials. Create a new Studio's directory by copying
   a signed-in one (`cp -a /home/deploy/grok/alex /home/deploy/grok/<studio>`).

   The existing `threads` directory is already a bind mount to the second disk.
   Moving the public site-media root itself requires changing the web server's
   mount/alias too, so it intentionally remains separate from cache migration.

3. Set the same `DEPLOY_AGENT_URL=http://host.docker.internal:9899` and
   `DEPLOY_AGENT_TOKEN` in the backend `secrets.env`. The compose manifest maps
   `host.docker.internal` to `DEPLOY_AGENT_HOST_GATEWAY`; the agent is not public.

4. Install and start the service. The binary comes from any Studio image
   (the first deployment installs it too):

   ```text
   c=$(docker create ghcr.io/alexgetmancom/solo-publisher:latest)
   install -d /home/deploy/bin && docker cp "$c:/app/bin/deploy-agent" /home/deploy/bin/deploy-agent && docker rm "$c"
   sudo install -d -o deploy -g deploy /var/lib/alexgetman-deploy
   sudo install -m 0644 deploy/alexgetman-deploy-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now alexgetman-deploy-agent
   ```

5. In GitHub repository settings set `DEPLOY_ENABLED=true` as an Actions variable
   and configure `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_PRIVATE_KEY`,
   `DEPLOY_SSH_KNOWN_HOSTS`, and `DEPLOY_AGENT_TOKEN` as Actions secrets.

Each deployment receives an immutable `ghcr.io/...@sha256:...` reference. CI builds
the image once, then updates `alex` and, when repository variable
`MARU_DEPLOY_ENABLED=true` is set, `maru`. The agent pulls/recreates only the
target's `backend` after running `studio-entrypoint --check-config` in the new
image, waits for its own Docker health plus `/readyz`, and restores that target's
previous digest automatically on failure. A target whose image has no
`studio-entrypoint` says `"configCheck": false` in `DEPLOY_TARGETS_JSON`. A successful deployment
sends the controller bot a target-specific one-click rollback button. The callback
is accepted only from `CONTROLLER_ADMIN_IDS` and is rejected after a newer release
exists for that target.

Registry and remote-agent failures that look transient are retried before rollback.
The default policy is three attempts with 5, 10 and 20 second delays; override it
with `DEPLOY_RETRY_ATTEMPTS`, `DEPLOY_RETRY_BACKOFF_MS` and
`DEPLOY_RETRY_MAX_BACKOFF_MS` in the host environment. Permanent image errors such
as an unknown digest are not retried.

## Switching the agent to the Rust binary

Once per host, after a deployment of the commit that introduced the binary has
run (it installs `/home/deploy/bin/deploy-agent` and moves `:latest` to an image
that carries it). Until then the hosts run the TypeScript agent: the Studio
host's unit runs `bun …/deploy/deploy-agent.ts`, and deployments leave that file
and `retry.ts` where they are, so the switch is reversible with one line. Switch
while nothing deploys (`curl -fsS http://127.0.0.1:9899/healthz` says
`"deploying":false`).

### Studio host (`alexgetman-deploy-agent`)

From a checkout:

```sh
scp deploy/alexgetman-deploy-agent.service deploy@<host>:/tmp/
```

On the host:

```sh
test -x /home/deploy/bin/deploy-agent   # installed by the first deployment of the binary
sudo cp /etc/systemd/system/alexgetman-deploy-agent.service /etc/alexgetman/alexgetman-deploy-agent.service.bun
sudo install -m 0644 /tmp/alexgetman-deploy-agent.service /etc/systemd/system/alexgetman-deploy-agent.service
sudo systemctl daemon-reload
sudo systemctl restart alexgetman-deploy-agent
systemctl show -p ExecStart --value alexgetman-deploy-agent   # path=/home/deploy/bin/deploy-agent
curl -fsS http://127.0.0.1:9899/healthz                       # {"ok":true,"deploying":false}
sudo sed -n 's/^DEPLOY_AGENT_TOKEN=/Authorization: Bearer /p' /etc/alexgetman/deploy-agent.env \
  | curl -fsS -H @- http://127.0.0.1:9899/v1/releases          # alex and maru, with their current releases
```

`/etc/alexgetman/deploy-agent.env` needs no edit: every existing target keeps
the configuration check. Rollback to the TypeScript agent:

```sh
sudo cp /etc/alexgetman/alexgetman-deploy-agent.service.bun /etc/systemd/system/alexgetman-deploy-agent.service && sudo systemctl daemon-reload && sudo systemctl restart alexgetman-deploy-agent
```

### Media processor host, VM-106 (`media-processor-deploy-agent`)

That host runs `/opt/alexgetman-media-processor/media-processor-deploy-agent`,
a `bun build --compile` of the TypeScript agent that CI produced between
24 July and 3 August 2026. That agent reads single-target variables
(`DEPLOY_COMPOSE_FILE`, `DEPLOY_IMAGE_ENV_FILE`, `DEPLOY_STATE_FILE`,
`DEPLOY_HEALTH_URL`, `DEPLOY_CONTAINER_NAME`, `DEPLOY_SERVICE_NAME`,
`DEPLOY_IMAGE_ENV_KEY`, `DEPLOY_DEFAULT_TARGET`, `DEPLOY_ALLOW_INITIAL_SEED`)
unless its env file has `DEPLOY_TARGETS_JSON`; the binary reads
`DEPLOY_TARGETS_JSON` only. No deployment updates this host's agent: it is
copied out of a Studio image by hand, now and whenever it should change.

From a checkout:

```sh
scp deploy/media-processor-deploy-agent.service <vm106>:/tmp/
```

On VM-106, as a user that may run `docker`, first the binary:

```sh
c=$(docker create ghcr.io/alexgetmancom/solo-publisher:latest) && docker cp "$c:/app/bin/deploy-agent" /tmp/deploy-agent && docker rm "$c"
sudo install -m 0755 /tmp/deploy-agent /opt/alexgetman-media-processor/deploy-agent
/opt/alexgetman-media-processor/deploy-agent; echo $?   # "DEPLOY_AGENT_TOKEN is required", then 1: it runs here
docker image rm ghcr.io/alexgetmancom/solo-publisher:latest
```

Then its configuration. If `sudo grep -c '^DEPLOY_TARGETS_JSON=' <env>` prints
`1`, add `"configCheck":false` to that one target by hand instead; otherwise
derive it from the variables the old agent reads, with the old agent's own
defaults, so it names the same files:

```sh
env=/etc/alexgetman/media-processor-deploy-agent.env
sudo cp -p $env $env.bun
sudo sh -s "$env" <<'EOF'
. "$1"
seed=; [ "$DEPLOY_ALLOW_INITIAL_SEED" = true ] && seed=',"allowInitialSeed":true'
printf 'DEPLOY_TARGETS_JSON={"%s":{"composeFile":"%s","imageEnvFile":"%s","stateFile":"%s","healthUrl":"%s","container":"%s","service":"%s","imageEnvKey":"%s","configCheck":false%s}}\n' \
  "${DEPLOY_DEFAULT_TARGET:-alex}" "$DEPLOY_COMPOSE_FILE" "$DEPLOY_IMAGE_ENV_FILE" \
  "${DEPLOY_STATE_FILE:-/var/lib/alexgetman-deploy/state.json}" "${DEPLOY_HEALTH_URL:-http://127.0.0.1:8788/readyz}" \
  "${DEPLOY_CONTAINER_NAME:-alexgetman-backend}" "${DEPLOY_SERVICE_NAME:-backend}" "${DEPLOY_IMAGE_ENV_KEY:-BACKEND_IMAGE}" "$seed" >> "$1"
EOF
sudo tail -n 1 $env   # expect compose.yml, studio-media-processor, media-processor, MEDIA_PROCESSOR_IMAGE, http://127.0.0.1:9087/health
```

Then the unit:

```sh
sudo cp /etc/systemd/system/media-processor-deploy-agent.service /etc/alexgetman/media-processor-deploy-agent.service.bun
sudo install -m 0644 /tmp/media-processor-deploy-agent.service /etc/systemd/system/media-processor-deploy-agent.service
sudo systemctl daemon-reload
sudo systemctl restart media-processor-deploy-agent
curl -fsS http://127.0.0.1:9898/healthz                       # {"ok":true,"deploying":false}
sudo sed -n 's/^DEPLOY_AGENT_TOKEN=/Authorization: Bearer /p' $env \
  | curl -fsS -H @- http://127.0.0.1:9898/v1/releases          # one compose target, with the state the old agent wrote
```

The derived target keeps the old state file, so the worker's rollback history
carries over, and its name does not matter: the Studio host's agent calls
`POST /v1/deploy` without one, which an agent with a single target takes as
that target. The leftover single-target variables are ignored. Rollback:

```sh
sudo cp /etc/alexgetman/media-processor-deploy-agent.env.bun /etc/alexgetman/media-processor-deploy-agent.env && sudo cp /etc/alexgetman/media-processor-deploy-agent.service.bun /etc/systemd/system/media-processor-deploy-agent.service && sudo systemctl daemon-reload && sudo systemctl restart media-processor-deploy-agent
```

## Naming the Telegram channel of a second Studio

Every Studio publishes text, so every Studio must name its own channel.
`TELEGRAM_CHANNEL_USERNAME` carries a default that is a real, live username —
the first Studio's — so a second Studio that leaves it unset would publish into
someone else's channel. The application refuses to start in production in
exactly that state rather than doing it silently.

```dotenv
# /home/deploy/maru/secrets.env
TELEGRAM_CHANNEL_USERNAME=marux_play
```

The channel registry adds the `telegram` channel as soon as a bot token and a
channel name exist. Verify with `ops channels`, which must list
`telegram · ru · native` with the account.

Maru keeps `site_enabled: false`: a Studio can publish text to Telegram without
publishing a website.

## Operating a Studio from its own machine

A Studio can be operated from a machine that has no checkout: the MCP transport at `/api/mcp` is
the whole interface, authorized by `MCP_STUDIO_TOKEN` and resolving to `MCP_STUDIO_ACTOR_ID`, so
work lands in the same workspace the owner sees in the Telegram bot. `ops doctor` reports
`studioTransportConfigured` when both are set. Media travels separately, as a raw body to
`/api/studio/media`.

Both routes are on the public site of the first Studio already. The second Studio is an allowlist
in the host proxy that ends in `respond 404`, so each route it should answer is named in
[caddy/Caddyfile](caddy/Caddyfile) explicitly.

The operator's machine installs the `studio` plugin, which carries both the MCP server and the
skill that drives it. That setup is driven by an agent rather than by hand:
[../plugin/setup-prompt.md](../plugin/setup-prompt.md) is the prompt, and
[../plugin/README.md](../plugin/README.md) describes the plugin itself.

## Backups, which this host does not keep

Nothing on this machine holds a backup, and nothing here holds a key to the
machine that does. VM-106 dials in nightly with a key pinned to
`/home/deploy/bin/alexgetman-backup-export`, a forced command that accepts
`backup-export <what> <studio>` and can do nothing else — no shell, no path of
the caller's choosing, no write anywhere. Whoever takes this host cannot reach,
rewrite or delete what is stored at home.

Four streams per Studio. `media` and `db` come from the Studio's own operations
CLI, so what they contain follows the code that writes those trees; two hand-kept
file lists that stopped matching the deployment are what silently broke media
backups for eight days in August 2026. `runtime-config` and `deploy-state` are
tars of this host's own files, which no Studio knows about.

The puller stages each stream, verifies it — `gzip -t` on the archive, the SQLite
header on the database, `tar -tf` on the rest — and only then writes it to its
restic repository. A stream piped straight in stored whatever arrived, and an
empty snapshot looks exactly like a backup in every listing.

Each Studio records its own successful exports, and `ops doctor` fails a
deployment whose media has not been pulled for a week. That check is for
*absence*: a puller that errors can report it, a backup machine that is switched
off cannot.

## Optional remote worker targets

Remote workers run the same deploy agent with one compose target of their own:
a different `service`, image environment key and health URL, and
`"configCheck": false` for an image without `studio-entrypoint`. Install
`media-processor-deploy-agent.service` using
`media-processor-deploy-agent.env.example` on the worker host, with the binary
copied out of a Studio image as in "Switching the agent to the Rust binary"
above; it remains bound to loopback and is
reached through a reverse SSH tunnel.

The VPS agent supports arbitrary remote target names in `DEPLOY_TARGETS_JSON`.
A remote target specifies `remoteUrl`, `remoteToken`, `artifactFile`,
`repository`, and its own `stateFile`. CI atomically writes the image digest for
each Git revision to `artifactFile`; Telegram promotion forwards precisely that
digest to the worker. The worker records current/previous digests after pull,
recreate and health-check, so rollback always restores its own previous image.

## Read-only runtime diagnostics

The production image includes the operations CLI (`/app/bin/ops`, run as
`bun /app/ops/cli.js`). From a checkout,
put the SSH destination in the ignored root `.env.local` file and use the single
production launcher:

```env
OPS_SSH_TARGET=deploy@your-server.example
```

```bash
cargo xtask ops-prod status
cargo xtask ops-prod audit
cargo xtask ops-prod --as maru status
```

Each Studio is a container of its own, so the launcher takes the deployment by
name: no `--as` means `alex`, and every run prints the deployment and container
it resolved to on stderr. The names live in `crates/xtask/src/ops_prod.rs`; a
third Studio is one line there. The launcher executes `/app/bin/ops` as uid 1000,
the same unprivileged user used by the application.

Use only the read-only commands above for routine diagnostics. Commands such as
`backup`, `restore`, and `metrics-backfill --apply` mutate state and require an
explicit maintenance task.
