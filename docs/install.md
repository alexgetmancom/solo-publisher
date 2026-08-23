[English](install.md) · [Русский](install.ru.md)

# Installing and running a Studio

Requirements: Docker, and a domain whose DNS already points at the machine. The
image is published for linux/amd64 and linux/arm64, so an ARM server needs no
build.

```bash
curl -fsSL https://raw.githubusercontent.com/alexgetmancom/solo-publisher/main/install.sh | sh -s -- publisher.example.com
```

The installer refuses before it touches anything if Docker is missing or the
domain does not resolve to this machine — the two reasons an install fails after
it looks like it worked. It then writes `.env` with the three secrets generated,
starts the stack, waits for `/readyz` through Caddy, and prints the Command
Center URL with its token. Run it again to update: an existing `.env` is kept as
it is.

Caddy obtains and renews the TLS certificate itself, so there is no certbot and
no renewal timer to set up. The Command Center link the installer prints signs
you in with the `COMMAND_CENTER_TOKEN` it wrote to `.env`; an empty Studio opens
with the three steps to its first draft instead of an empty analytics screen.

Only Caddy publishes ports; the application is reachable through it alone.
Nothing else in `.env` is required to start — a Studio with no platform
credentials serves its Command Center and publishes nowhere. Add Telegram or MCP
as the authoring interface, then connect destinations from Command Center →
Studio; `docker compose exec app bun /app/ops/cli.js doctor` lists what each
enabled destination still needs. See
[Connecting a destination](destinations.md).

## The public website

The public website is off by default — most Studios publish to channels they
already have and do not want another site to look after. Enable it with the
operations CLI shipped in the container:

```bash
docker compose exec app bun /app/ops/cli.js studio-profile-set --site-enabled
```

It appears at `https://your-domain/`, with its feeds, sitemap and Markdown
endpoints, on the next request.

Temporary media that an external platform fetches during publishing is staged
under `/data/media`, automatically created and owned by the container before the
app drops privileges. The `/media/staging/` route remains available when the
public site is off, so a fresh self-host does not need a manual directory or
permission step.

## Studio profile

`docker compose exec app bun /app/ops/cli.js studio-profile` shows what this
Studio publishes as, its time zone, whether it serves a public site, and video
timing; `studio-profile-set` on the same CLI changes them. They live in the
database, so they survive a redeploy and need no restart.

## Video over 50 MB

Telegram refuses file downloads over 50 MB, which is smaller than a short video.
To publish video, set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` and
`COMPOSE_PROFILES=telegram` in `.env`, which starts a local Bot API server
alongside the app and lifts the limit to 2 GB.

## Backups on day one

When Telegram is configured, the Studio sends you a copy of its database every
day, silently, in the same Telegram chat you author from. Media files are not in
it and never leave on their own: the Studio emits them as a stream and a machine
you control pulls it. `doctor` reports the deployment unhealthy until that has
happened within the week. [Backups](backups.md) covers both halves and carries
the forced-command recipe for the pulling side.

## Updating

Before an update, `docker compose exec app bun /app/ops/cli.js status` reports
the running `gitRevision`. `latest` follows the revision running in the
maintainer's production; set
`SOLO_PUBLISHER_IMAGE=ghcr.io/alexgetmancom/solo-publisher:<full-gitRevision>`
in `.env` when you want the verified installation to stay fixed. Update with
`docker compose pull && docker compose up -d`; diagnose with
`docker compose logs -f app`.

## Running from source

Requirements: [Bun 1.3.14](https://bun.sh/) and the native build prerequisites
required by `sharp`. Copy the secret template:

```bash
cp apps/backend/secrets.env.example apps/backend/secrets.env
```

What a Studio publishes as, whether it serves the public site, its time zone and
video timing live in its own database, read and written with
`bun run --filter @solo-publisher/backend ops -- studio-profile`. Credentials
stay in the ignored `apps/backend/secrets.env`; connected destinations live in
the channel registry. Text posting, video posting and analytics always run.

The private Telegram bot and MCP endpoint operate the same Studio services.
Posts created through either interface land in the same drafts, schedules,
publication jobs, and analytics.

For an MCP client on another machine, the bundled
[`studio` plugin](../plugin/README.md) packages the remote transport and the
operating skill. Its [setup prompt](../plugin/setup-prompt.md) connects and
verifies a deployment without exposing its database or SSH access.
