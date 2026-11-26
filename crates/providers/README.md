# providers — the platforms the Studio publishes through (Rust)

Everything that speaks to a provider outside the Studio, in one crate so `runtime` stays the process foundation:

| Module | Holds |
|---|---|
| `adapters` | platform delivery: the adapter ports, one adapter per platform, Zernio, the remote media processor, the video publishers' provider calls |
| `channels` | connected accounts, their credentials, OAuth, and the probes that need the process or a provider |
| `external` | the provider helpers `adapters`, `channels`, `delivery` and `bot` share |

## adapters — platform delivery

Every request goes through `runtime::http::HttpClient`, so the request goldens see exactly what production sends.
The delivery workflow (a later slice) drives the adapters through `SocialAdapter`.

| Module | Holds |
|---|---|
| `ports` | `SocialAdapter`, `PrepareJob`, `DeliveryPorts`, `AdapterContext`, `EditRequest`/`EditOutcome` |
| `social_ports` | `PreparedMedia`, `MediaPreparation` |
| `platform_adapters` | `create_platform_adapters`, `verify_platform_publication`, `text_target_is_absent`, `TargetRouting` |
| `error` | `AdapterError`, `ambiguous_mutation`, `publish_json`, `absent_if_missing`; the ambiguous-publication and platform-absence rules |
| `payload`, `multipart` | Payload helpers (the readers live in `domain::publishing::payload`) and the multipart body writer |
| `telegram` | The Telegram adapter and its edit/remove ports |
| `telegram_stories` | `StoriesClient`, `StoryRequest`, `StoryError`: everything but the MTProto call (`crates/mtproto`) |
| `x`, `x_content_state` | The X adapter and its content state |
| `threads` | The Threads adapter and its remove port |
| `instagram` | The Instagram adapter and its container handling |
| `discord` | The Discord adapter and its edit/remove ports |
| `zernio` | The Zernio adapter |
| `video_publishers` | The provider calls of the video worker: YouTube resumable upload, keep-private, verify; Reels container, ready, publish; the video absence check |
| `remote_media_processor` | The remote media processor client (media transform key, atomic response write) |
| `providers` | `ProviderCalls`: the adapters Studio's services wait on (Zernio post outcome, Zernio Instagram Reel publish, keep a YouTube upload private, list Zernio accounts, ffprobe/ffmpeg) |

### The port

```rust
pub trait SocialAdapter {
    fn validate(&self, job: &ClaimedPublishJob) -> Result<()>;
    fn prepare(&self, job: ClaimedPublishJob) -> Fut<'_, Result<ClaimedPublishJob>>;
    fn publish<'a>(&'a self, job: &'a ClaimedPublishJob) -> Fut<'a, Result<PublishResult>>;
    fn verify<'a>(&'a self, job: &'a ClaimedPublishJob, result: PublishResult) -> Fut<'a, PublishResult>;
    fn edit<'a>(&'a self, edit: &'a EditRequest) -> Option<Fut<'a, Result<EditOutcome>>>;   // None: no edit port
    fn remove<'a>(&'a self, external_id: &'a str) -> Option<Fut<'a, Result<Value>>>;        // None: no remove port
}
```

`create_platform_adapters(ctx, prepare, stories, &routing)` builds one adapter per target in the stable order the
goldens record. An error that may have published is `AdapterError::Ambiguous` (→ `requirePublishVerification`);
anything else goes to `failPublishJob` via `to_publish_failure()` / `class()`.

Wiring for the integrator: `PreparedMedia::new(Rc<dyn MediaPreparation>)` is the `prepare` (the delivery slice
implements `MediaPreparation` with `prepareMediaItems` and `awaitPreparedStoryMedia`); `ProviderCalls::new(client,
config)` implements `MediaProbe`, `VideoProvider`, `YoutubeUploads` and `ZernioDirectory`, and is what the bot, the
CLI and the MCP server hand Studio's services;
`mtproto::MtprotoStories::new(config)` is the `stories`.

### Telegram Stories over MTProto

`publish_telegram_story` does the guards, the caption, the probe and the re-encode, then hands one `StoryRequest`
(channel username without `@`, the file, its width/height/duration for a video, the caption with its hidden links, the
period) to a `StoriesClient`. The Studio's is `MtprotoStories` (`crates/mtproto`, grammers, in process): it reads
`TELEGRAM_CHANNEL_STORIES_*` from the live configuration at send time, opens the session file, connects (30 s),
loads the account (30 s), resolves the channel, uploads the file and sends `stories.sendStory` (120 s for those three),
then disconnects (5 s, best effort). The request is the one mtcute built (`crates/mtproto/tests/send_story.golden.json`).

- `Ok(id)` — posted.
- `StoryError::Refused` — nothing reached the audience, a plain failure: credentials unset
  (`missing_channel_story_credentials`), no signed-in session (`telegram_channel_story_not_signed_in`), media file
  missing, connect or identity failure or deadline, the channel not resolvable, the upload failing or running out the
  deadline — all before `sendStory` is handed over — or Telegram refusing `sendStory` itself (codes 300–499, mtcute's
  wording: `Telegram API error 400: …`).
- `StoryError::Ambiguous` — `sendStory` went out and no definite answer came back: the deadline, a dropped connection,
  a server-side failure (code 500 and up, or negative), or an answer without the Story. `Ambiguous("telegram_stories")`.

### Goldens

```
cargo test -p providers --test adapters_goldens --test adapters_behaviour   # adapters_goldens.rs replays parity/adapter-goldens/ (recorded from the TypeScript backend before the cutover; nothing re-records them; they are the contract); adapters_behaviour.rs covers what they cannot
```

228 cases: telegram 31, x 33, threads 43, instagram 26, discord 18, zernio 17, youtube 21, reels 16,
remote-media 10, stories 13 (text, photo, video, album, rich thread, reply chains and resume, edit, delete, verify,
absence, token refresh, 4xx, 429 with Retry-After, 5xx, transport loss, ambiguous mid-way failures). Compared:
every request in order — method, normalized URL, lower-cased sorted headers, body bytes (multipart as its wire parts,
bodies over 16 KiB by sha256), credentials as `{{NAME}}` — the result (objects compared without key order) or the
error kind, message, class, status and Retry-After, virtual sleep time for X, and files written.

### Deliberate deviations

- Stories: a failure before `stories.sendStory` is handed over (the upload's deadline included) is not sent. A
  server-side RPC failure after it is ambiguous. Nothing inside mtcute's `sendStory` is guessed at: only
  what happened before the hand-over is "not sent".
- The Stories connection is opened after the probe and re-encode, not before (one connection per Story).
- A 2xx YouTube upload or Reels publish without an id is reported with `id: None`, never as
  a failure that would retry a publication that happened.
- Result objects match the goldens' fields and values, not always their key order (a Threads/Instagram progress
  record whose `containerId` is added later lists it earlier); only the stored JSON's layout differs.
- A body that does not parse as JSON after a 2xx reports `JSON Parse error: <serde's reason>`, not JavaScriptCore's.
- Discord: a split post whose later part is refused after the first is in the channel returns a partial publication
  (`resumeKey: "_discordMessageIds"`, the ids sent), as X and Threads do, because throwing made the retry post the
  first message again. The retry sends only the remaining parts. A lost answer is ambiguous, as before.

Not here: the video worker loop and the publish workflow (`delivery`), `prepareMediaItems` / story derivatives (behind
`MediaPreparation`), the MTProto client itself (`crates/mtproto`).

## channels — connected accounts, their credentials, and the probes that check them

Connected accounts and the process/provider half of the observability probes. Registry reads publishing
needs stay in `domain::channels`; channel administration (register, Zernio route options) in
`domain::studio::services::channels`; the database-only probes in `domain::observability`
(`credentials`, `failures`, `runtime_health`, `dates`, plus `should_ping_token` / `record_token_ping` on the breaker).

| Module | Holds |
|---|---|
| `token_store` | the `platform_tokens` rows (an upsert only sets the columns a writer names) |
| `credentials` | `apply_stored_credentials`, `Setting`, `ConfigPatch` |
| `meta` | Threads and Instagram providers, OAuth and tokens |
| `x`, `youtube`, `api_keys` | X and YouTube OAuth and tokens; API-key services |
| `connect` | `start_connect`, `ConnectLinks` (the real `ChannelConnectLinks`) |
| `registry` | channel identity, destinations and target routing |
| `oauth_routes` | the browser side of connecting an account, framework-free |
| `observability::{cycle, memory, token_health}` | the observability tick, process memory and the process half of runtime health, token health |
| `loops` | the `platform-tokens`, `credentials`, `x-token`, `observability` loop bodies |

Credentials changed at run time are swapped into the live `SharedConfig`.

### Wiring

```rust
loops.start(PLATFORM_TOKENS.0, PLATFORM_TOKENS.1, move || platform_tokens_tick(&config, &db, &http));
loops.start(CREDENTIALS.0, CREDENTIALS.1, move || credentials_tick(&config, &db));
loops.start(X_TOKEN.0, X_TOKEN.1, move || x_token_tick(&config, &db, &http));
loops.start(OBSERVABILITY, observability_interval(&config), move || observability_tick(&config, &db, &http));
```

Call `observability::memory::process_boot()` once at startup so the boot time is the process's. `app/src/host.rs` uses `ConnectLinks::new(SystemClock, OsEntropy)`.

`crates/http` (`oauth.rs`) mounts `oauth_routes::{meta_start, meta_callback, x_start, x_callback, youtube_start,
youtube_callback}` with an `OauthContext` (live config, connection, `HttpClient`, clock, entropy, and the Studio's
`ChannelService` as `ChannelRegistrar`), the query decoded as Hono does (first occurrence, `+` and `%` decoded) and
the `commandAllowed` verdict; it adds `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store` to every
`/oauth/*` answer.

### Goldens

`tests/channels_scenarios.rs` runs the steps of `tests/channels_scenarios.json` and compares with
the recorded goldens (`tests/channels_scenarios.golden.json`; nothing re-records them) (fixed clock, scripted `randomBytes`, canned responses incl. 400 `invalid_grant`, 401,
403, 429, 5xx, transport errors): results, requests, live-config credentials, every table, and `platform_tokens`
opened. Signed Meta states and PKCE challenges compare bit for bit; sealed states compare opened.

### Differences

- Memory logging reports `rssMb` only (no JavaScript heap in a Rust process); rss is `VmRSS` from `/proc`.
- `youtube_access_token` refuses a token response without `access_token` (`external`'s approved deviation),
  so a YouTube probe answered that way is inconclusive instead of calling with `Bearer undefined`.
- `JSON.parse` failures of an authentic Meta state carry serde's message.

## external — provider helpers

| Module | Holds |
|---|---|
| `external::telegram` (`BotApi`, `BotParams`, `BotResponse`, `TELEGRAM_DOWNLOAD_TIMEOUT`) | the one Telegram Bot API client: method calls and the file endpoint; encoding and retries stay with callers |
| `external::{deepseek, instagram, threads, youtube, zernio, telegram_files}` | DeepSeek chat, Instagram/Threads/YouTube credentials and the YouTube access token, the Zernio account list, Telegram file materialization |

The requests the DeepSeek, YouTube token, Zernio and Telegram file helpers send are replayed against the runtime
recording (`crates/runtime/tests/fixtures/runtime.json`, section `external`) by `cargo test -p runtime`.
