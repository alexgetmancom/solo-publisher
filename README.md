[English](README.md) · [Русский](README.ru.md)

# Solo Publisher

**Write in chat. Publish everywhere. Own the stack.**

Write from Telegram or an MCP client such as Codex; Solo Publisher publishes to
your website, Telegram, X, Threads, YouTube Shorts and Instagram, schedules and
retries every destination independently. One
owner, one server, no SaaS in the middle.

![A live publication powered by Solo Publisher](docs/assets/live-site.png)

> Not a starter kit or a mockup. This is the complete publishing pipeline
> running in production behind a real, daily-updated publication.

## Install

Docker, and a domain whose DNS already points at this machine:

```bash
curl -fsSL https://raw.githubusercontent.com/alexgetmancom/solo-publisher/main/install.sh | sh -s -- publisher.example.com
```

It checks Docker and the DNS before touching anything, generates the secrets,
starts the stack, gets the TLS certificate, and prints your Command Center link
with its token. Run it again to update. → [Install guide](docs/install.md)

## Try it without installing

Needs [Bun 1.3.14](https://bun.sh/) and the native build prerequisites for
`sharp`:

```bash
bun install --frozen-lockfile
bun run demo
```

The Studio's public feed at <http://localhost:8788/api/public/site> — fixture
content, no credentials, `Ctrl+C` to stop.

## Docs

- [Install, update, run from source](docs/install.md)
- [Connecting a destination](docs/destinations.md) — every platform, what it needs, and what bites later
- [Backups](docs/backups.md) — what arrives on its own, what you point your own tool at
- [Operating from an agent](docs/mcp.md) — the MCP transport and connecting a client
- [Architecture, stack, development](docs/architecture.md)

## License

[Apache License 2.0](LICENSE).
