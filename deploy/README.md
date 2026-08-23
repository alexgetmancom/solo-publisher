# Production deployment agent

`deploy-agent.ts` is intentionally a small host-side Bun service. It is the only
component allowed to invoke Docker. The Astro application never mounts the Docker
socket and can only request a rollback using a private bearer-authenticated route.

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
   `/mnt/alex-media` disk. `STUDIO_BACKUP_DIR_HOST` stays outside the data
   directory: `doctor` fails a deployment whose media backup lives on the
   volume it exists to survive. `DEPLOY_AGENT_HOST_GATEWAY` in each Studio's
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

4. Install and start the service:

   ```text
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
target's `backend`, waits for its own Docker health plus `/readyz`, and restores
that target's previous digest automatically on failure. A successful deployment
sends the controller bot a target-specific one-click rollback button. The callback
is accepted only from `CONTROLLER_ADMIN_IDS` and is rejected after a newer release
exists for that target.

Registry and remote-agent failures that look transient are retried before rollback.
The default policy is three attempts with 5, 10 and 20 second delays; override it
with `DEPLOY_RETRY_ATTEMPTS`, `DEPLOY_RETRY_BACKOFF_MS` and
`DEPLOY_RETRY_MAX_BACKOFF_MS` in the host environment. Permanent image errors such
as an unknown digest are not retried.

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

## Optional remote worker targets

Remote workers run the same deploy-agent protocol with a different `service` and
image environment key. Install `media-processor-deploy-agent.service` using
`media-processor-deploy-agent.env.example` on the worker host; it remains bound
to loopback and is reached through a reverse SSH tunnel.

The VPS agent supports arbitrary remote target names in `DEPLOY_TARGETS_JSON`.
A remote target specifies `remoteUrl`, `remoteToken`, `artifactFile`,
`repository`, and its own `stateFile`. CI atomically writes the image digest for
each Git revision to `artifactFile`; Telegram promotion forwards precisely that
digest to the worker. The worker records current/previous digests after pull,
recreate and health-check, so rollback always restores its own previous image.

## Read-only runtime diagnostics

The production image includes the bundled backend operations CLI. From a checkout,
put the SSH destination in the ignored root `.env.local` file and use the single
production launcher:

```env
OPS_SSH_TARGET=deploy@your-server.example
```

```bash
bun run ops:prod status
bun run ops:prod audit
bun run ops:prod --as maru status
```

Each Studio is a container of its own, so the launcher takes the deployment by
name: no `--as` means `alex`, and every run prints the deployment and container
it resolved to on stderr. The names live in `scripts/ops-prod.ts`; a third Studio
is one line there. The launcher executes the bundled CLI as `bun`, the same
unprivileged user used by the application.

Use only the read-only commands above for routine diagnostics. Commands such as
`backup`, `restore`, and `metrics-backfill --apply` mutate state and require an
explicit maintenance task.
