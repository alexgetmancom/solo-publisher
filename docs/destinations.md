[English](destinations.md) · [Русский](destinations.ru.md)

# Connecting a destination

A destination has two halves, and they are deliberately separate: the Studio has
to know the destination exists, and it has to hold the credentials for it.
Nothing asks you for keys to a platform you do not publish to.

```bash
# 1. Tell the Studio this destination exists
docker compose exec app bun /app/ops/cli.js channel-connect --target threads_en

# 2. Ask what it still needs
docker compose exec app bun /app/ops/cli.js doctor
```

`doctor` names the exact settings that destination is missing and never prints
the ones it has. Put deployment credentials in `.env`, restart, and run it
again. The destination itself can be enabled from Command Center → Studio →
Channels, Telegram → Settings → Channels, the CLI, or the corresponding MCP
operation. Host credentials and the interactive Telegram Stories login remain
CLI-only; MCP never receives a secret or a local session.

Command Center and Telegram show `ready` or the number of missing credentials
beside every connected channel. Disable it from the same screen, or use
`channel-disable` / `ops_channel_disable`; disabled routes disappear from draft
targets without losing their publication history.

## What you can connect

Text and image destinations are connected by naming their target. Video accounts
are connected by naming their platform and language.

| Destination | Connect with | Needs |
| --- | --- | --- |
| Website | `--target site_ru` / `site_en` | nothing, plus `docker compose exec app bun /app/ops/cli.js studio-profile-set --site-enabled` |
| Telegram channel | Channels or `--target telegram` | `CONTROLLER_BOT_TOKEN` |
| Discord | Channels or `--target discord` | `DISCORD_CHANNEL_ID`, then CLI `credential-set --target discord` |
| Threads | Channels or `connect-link --platform threads` | native app credentials or a stored Zernio key |
| X | Channels or `connect-link --platform x` | `X_CLIENT_ID`, `X_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` — the **OAuth 2.0** Client ID and Client Secret, under the app's "User authentication settings" in the X developer portal. Not the API Key and API Secret on the same page: those are OAuth 1.0a and this connects over OAuth 2.0 with PKCE. Register `https://your-domain/oauth/x` there as the callback URL. |
| Instagram Stories | Enable the Story in Channels after native Instagram login, or select its Zernio route | native Instagram credentials or a stored Zernio key |
| Telegram Stories | Channels or `--target telegram_stories` | CLI `telegram-stories-login` with `TELEGRAM_CHANNEL_STORIES_API_ID`, `_API_HASH`, `_SESSION` |
| YouTube | Channels or `connect-link --platform youtube --locale ru` | `YOUTUBE_*_CLIENT_ID`, `_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` |
| Instagram feed and Reels | Channels or `connect-link --platform instagram` | native Instagram credentials or a stored Zernio key |
| TikTok | `--platform tiktok --provider zernio` | a stored Zernio key — analytics only, never published to |

## What each destination carries

| Destination | Text | Media | Short video | Analytics |
| --- | :---: | :---: | :---: | :---: |
| Website | ✓ | ✓ | — | ✓ |
| Telegram channel | ✓ | ✓ | — | ✓ |
| Telegram Stories | — | ✓ | ✓ | — |
| X | ✓ | ✓ | — | ✓ |
| Threads | ✓ | ✓ | — | ✓ |
| YouTube Shorts | — | — | ✓ | ✓ |
| Instagram Reels / Stories | — | ✓ | ✓ | ✓ |

Solo Publisher uses your own platform accounts and API credentials; it is not an
aggregator sitting between you and your audience.

## Native or through a provider

Meta's platforms can be reached two ways, and the channel remembers which one it
uses. For native delivery, create your own Meta app and put its app id and secret
in `.env`; Instagram needs a Professional account. Generate
`TOKEN_ENCRYPTION_KEY` once with `openssl rand -hex 32`.

Register these exact callback URLs in the app dashboard:

```text
https://your-domain.example/oauth/threads
https://your-domain.example/oauth/instagram
```

Then open Command Center → Studio → Channels, or Telegram → Settings → Channels,
and click the RU or EN native button. The browser returns to Studio, which
exchanges the code, seals the long-lived token in the database and records the
account id. An Instagram login enables Reels; enable its separate Story target
on the same screen only when that Studio publishes Stories. No URL copying, CLI
token exchange, `.env` token edit or restart is involved. An app in
Development mode works for accounts assigned a role on that app; serving other
people's accounts is the point at which Meta review matters.

```bash
# The same destination, delivered through a provider instead
docker compose exec app bun /app/ops/cli.js channel-connect --target threads_en --provider zernio --account-id <id>
```

A channel connected this way needs one Zernio key instead of the platform's
tokens — for feed posts, for Threads and for Stories alike — and `doctor` asks
for exactly that. The key is not an .env setting: it is checked against Zernio
and stored sealed in this Studio's database, the way an OAuth token is.

```bash
printf %s "$ZERNIO_KEY" | docker compose exec -T app bun /app/ops/cli.js credential-set --target zernio
```

Command Center and Telegram Settings → Channels list the publishable routes
the provider reports so you can pick one instead of typing an id. MCP lists the
same choices with `studio_zernio_connection_options`; connect the selected route
with `ops_channel_connect`.

Native remains the default: a destination no provider carries is delivered
straight to the platform, as it always was.

## YouTube

The one destination with a guided flow, because obtaining its first token is
otherwise the step people get stuck on.

**You create the app, not us.** YouTube quota is counted per Google Cloud
project rather than per user, so a shared client would give every install
together a handful of uploads a day, and publishing on your behalf from our
project would put it through Google's verification.

1. Create a project in [Google Cloud](https://console.cloud.google.com/) and
   enable **YouTube Data API v3**.
2. Configure the OAuth consent screen and set its publishing status to
   **In production**. Leaving it on *Testing* is the trap: Google then issues
   refresh tokens that [expire in 7 days](https://developers.google.com/identity/protocols/oauth2),
   so publishing works, and then silently stops a week later. Your own channel
   does not need Google's verification; the "unverified app" notice is expected.
3. Credentials → OAuth client ID → type **TVs and Limited Input devices**. A
   Studio runs on a server with no browser, and this is the only client type
   whose flow does not need a redirect back to a reachable address.
4. Put the client id and secret in `.env` as `YOUTUBE_RU_CLIENT_ID` and
   `YOUTUBE_RU_CLIENT_SECRET` (or `YOUTUBE_EN_*`).

```bash
docker compose exec app bun /app/ops/cli.js connect-link --platform youtube --locale ru
```

It answers with a short code and a URL. Approve on any device with a browser and
the Studio finishes on its own within a minute: the refresh token is stored
sealed in its database, the channel appears in the registry, and nothing has to
be pasted into `.env` or restarted. The same connection can be started from
Studio → Channels or from the Telegram bot — one flow, three surfaces. That
approval is the single manual step and it happens once; afterwards the Studio
exchanges the refresh token for a short-lived access token on every upload, and
the refresh token does not expire unless you revoke it or leave it unused for
six months.

## Threads

Note that a Meta app with the Threads use case has two id and secret pairs. The
Threads ones are the pair this uses, under App settings → Basic as **Threads App
ID** and **Threads App secret** — putting the Meta app's own id there produces
error 4476002, which does not say which of the two it wanted.

Connect it from Studio → Channels, as described above. If the Command Center is
unreachable — a broken deployment, a Studio that serves nothing publicly — the
same exchange runs from a terminal:

```bash
docker compose exec -it app bun /app/ops/cli.js threads-authorize --locale ru
```

It prints a link to approve as the account you publish from. Meta redirects to
the callback, which **reports that the connection failed — expected on this
path**: that link carries no signed state, so the callback refuses it and leaves
the single-use code unspent. Copy the whole address from the address bar and
paste it back; the command exchanges it and prints the token for `.env`.

## What to know before you start

**Meta tokens lapse, and the Studio renews them for you.** Long-lived Instagram
and Threads tokens expire 60 days after they are issued. Set `TOKEN_ENCRYPTION_KEY`
in `.env` and the Studio renews them on its own, a month ahead of the deadline,
storing each renewal sealed — the database leaves the machine every day as a
backup, and a live token is not something to hand around in a chat. No key means
no renewal: the tokens stay exactly what `.env` says and you re-issue them by
hand.

One thing it cannot do for you. A token that has already expired can no longer
be renewed, so a Studio switched off for two months has to be connected again —
from Studio → Channels, the same two clicks as the first time. For an account
connected that way the credential lives in the database, and editing
`THREADS_*_ACCESS_TOKEN` in `.env` will not replace it; the startup log says so
when the two disagree. `.env` still wins for an account that was never connected
through the browser. Connecting through a provider sidesteps the whole question.

**Keep the Meta app out of development mode.** An app in development mode
publishes only to accounts that hold a role on it, which is enough for your own
Studio and nothing else. Switch it to live in the App Dashboard before you
connect an account you do not administer.

**X charges for writing.** The four keys are easy to obtain, but posting through
X's API requires a paid tier of their developer platform.

**Telegram Stories are posted by a user, not a bot.** Create an API id and hash
at [my.telegram.org](https://my.telegram.org) under *API development tools*, put
them in `.env` with a writable path for the session, and sign in once:

```bash
docker compose exec -it app bun /app/ops/cli.js telegram-stories-login
```

It asks for the phone number, the code Telegram sends and the two-factor
password if the account has one, then reports which account the session now
belongs to. The session is a directory the app writes to, so this runs inside
the container — `-it` matters, it is a conversation.

**Video over 50 MB needs the local Bot API.** Telegram's public API refuses
larger downloads. Set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` and
`COMPOSE_PROFILES=telegram` in `.env` to run one beside the app and lift the
limit to 2 GB.
