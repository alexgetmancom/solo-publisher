# Stories sidecar

Posts Telegram channel Stories over MTProto (mtcute) for the Rust Studio, which has no MTProto client. The contract
(request, answers, what "not sent" means) is in `crates/adapters/README.md` → "Stories sidecar contract"; the Rust
client is `HttpStoriesSidecar`. The Rust side does the guards, caption, probe and re-encode; this side only connects,
loads the account, sends one Story and tears the client down, under TypeScript's deadlines.

| File | What |
|---|---|
| `src/contract.ts` | request validation, answer shapes |
| `src/send.ts` | one Story through a `StoryClient` (mtcute's client, or a test fake); sent / not-sent mapping |
| `src/server.ts` | `POST /v1/stories` (bearer token), `GET /healthz` |
| `src/client.ts` | `TELEGRAM_CHANNEL_STORIES_*` → mtcute `TelegramClient` |
| `src/main.ts` | process entry |
| `src/login.ts` | one-time sign-in that writes the session (replaces `ops telegram-stories-login` for the Rust image) |

Environment: `STORIES_SIDECAR_TOKEN` (required, ≥ 32 characters), `STORIES_SIDECAR_HOST` (default `127.0.0.1`),
`STORIES_SIDECAR_PORT` (default `8790`), `TELEGRAM_CHANNEL_STORIES_API_ID`, `_API_HASH`, `_SESSION` (all three, or
every request answers `missing_channel_story_credentials`, not sent).

In the image (`Dockerfile.rust`) it is bundled to `/app/sidecar` and started, supervised and given its token by
`studio-entrypoint` (`crates/entrypoint`); nothing to configure. Sign in once:

```
docker exec -it -u bun <container> bun /app/sidecar/login.js
```

Tests: `bun test sidecars` (mtcute faked; no network).
