[English](mcp.md) · [Русский](mcp.ru.md)

# Operating a Studio from an agent

`/api/mcp` is the whole interface. An agent on your laptop writes, publishes,
schedules, reads analytics and diagnoses delivery through it — with no database
access, no SSH and no checkout of this repository on that machine.

## Turn it on

`install.sh` generates both of these, so a Studio installed with it already
answers here — read them from the `.env` it wrote. Setting them by hand:

```dotenv
# openssl rand -hex 32
MCP_STUDIO_TOKEN=
# Who the agent's work belongs to. Your numeric Telegram user id if you also
# author from the bot, so both interfaces own the same drafts; otherwise any
# positive integer — it means nothing outside this Studio's own database.
MCP_STUDIO_ACTOR_ID=1
```

The two are configured together or not at all: a token that acts as nobody is
refused at startup. The actor needs no roster entry, because the token is what
authorizes it. `STUDIO_ACTOR_IDS` exists for the other case — a second person
who owns work here — and an installation with one agent leaves it empty.

```bash
docker compose up -d
docker compose exec app bun /app/ops/cli.js doctor
```

`doctor` reports `studioTransportConfigured: true` once both are set.

## Point an agent at it

The endpoint is `https://your-domain/api/mcp`, authenticated with
`Authorization: Bearer <MCP_STUDIO_TOKEN>`. It is reachable whether or not this
Studio serves a public website — a Studio with `site_enabled: false` answers the
operator surfaces and this transport and nothing else.

For Claude Code, Codex and anything else that speaks MCP over HTTP, the bundled
[`studio` plugin](../plugin/README.md) packages the transport together with the
skill that drives it, so one install gives the agent the whole Studio rather than
a list of unexplained tools. Its [setup prompt](../plugin/setup-prompt.md)
connects and verifies without ever printing your token.

To check the transport by hand before involving an agent:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $MCP_STUDIO_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://your-domain/api/mcp
```

`200` means the transport is live. `401` means the token does not match or is
not set. `404` means something in front of the Studio is not forwarding the
path — with the stack in this repository, Caddy forwards it always.

## What an agent can and cannot do

Every operation the CLI has is exposed except the ones that move the database
file, write credentials or read a host path. So an agent can connect and disable
channels, inspect delivery, retry a target, edit and reschedule a publication —
and cannot take a backup, restore one, or run the YouTube and Telegram Stories
sign-in flows, because those handle credentials or a terminal.

```bash
docker compose exec app bun /app/ops/cli.js guide --json
```

That catalogue is the same one the agent sees: each operation carries whether it
mutates and whether it is on the agent surface at all.
