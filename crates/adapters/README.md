# adapters — platform delivery (Rust)

Port of the TypeScript delivery adapters. Every request goes through `runtime::http::HttpClient`, so the request
goldens see exactly what production sends. The delivery workflow (a later slice) drives them through `SocialAdapter`.

| Module | TypeScript |
|---|---|
| `ports` (`SocialAdapter`, `PrepareJob`, `DeliveryPorts`, `AdapterContext`, `EditRequest`/`EditOutcome`) | `delivery/ports.ts` |
| `social_ports` (`PreparedMedia`, `MediaPreparation`) | `delivery/ports/social.ts` (`createPlatformPorts`) |
| `platform_adapters` (`create_platform_adapters`, `verify_platform_publication`, `text_target_is_absent`, `TargetRouting`) | `delivery/platform-adapters.ts` |
| `error` (`AdapterError`, `ambiguous_mutation`, `publish_json`, `absent_if_missing`) | `delivery/ambiguous-publication.ts`, `delivery/platform-absence.ts`, `HttpPublishError`/`publishJson` of `publishing/errors.ts` |
| `payload`, `multipart` | `delivery/social/payload.ts` (readers in `domain::publishing::payload`), Bun's `FormData` |
| `telegram` | `delivery/social/telegram.ts` + the Telegram edit/remove ports |
| `telegram_stories` (`StoriesSidecar`, `HttpStoriesSidecar`) | `delivery/social/telegramStories.ts` minus mtcute |
| `x`, `x_content_state` | `delivery/social/x.ts`, `x-content-state.ts` |
| `threads` | `delivery/social/threads.ts` + the Threads remove port |
| `instagram` | `delivery/social/instagram.ts`, `instagram-container.ts` |
| `discord` | `delivery/social/discord.ts` + edit/remove ports |
| `zernio` | `delivery/zernio.ts` |
| `video_publishers` | the provider calls of `delivery/video-publishers.ts` (YouTube resumable upload, keep-private, verify; Reels container, ready, publish; `videoTargetIsAbsent`) |
| `remote_media_processor` | `delivery/remote-media-processor.ts` (+ `mediaTransformKey`, `writeResponseAtomically`) |
| `providers` (`ProviderCalls`) | what the bot's `Adapters` calls: `zernioPostOutcome`, `publishZernioInstagramReel`, `keepYouTubeUploadPrivate`, `listZernioAccounts` |

## The port

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

`create_platform_adapters(ctx, prepare, stories, &routing)` builds one adapter per target in TypeScript's order. An
error that may have published is `AdapterError::Ambiguous` (→ `requirePublishVerification`); anything else goes to
`failPublishJob` via `to_publish_failure()` / `class()`.

Wiring for the integrator: `PreparedMedia::new(Rc<dyn MediaPreparation>)` is the `prepare` (the delivery slice
implements `MediaPreparation` with `prepareMediaItems` and `awaitPreparedStoryMedia`); `ProviderCalls::new(client,
config)` implements `VideoProvider` and `YoutubeUploads`, so `AppAdapters` forwards `post_outcome`,
`publish_instagram_reel` and `keep_youtube_private` to it (`zernio_accounts` is `channels::zernio::ZernioAccounts`);
`HttpStoriesSidecar::new(client, base_url)` is the `stories`.

## Stories sidecar contract

`POST {base}/v1/stories`, `Content-Type: application/json`, no credentials: the sidecar reads
`TELEGRAM_CHANNEL_STORIES_*` itself and the media path from the shared data volume.

```json
{"peer": "channelname", "periodSeconds": 86400,
 "media": {"type": "video", "path": "/data/…/story.mp4", "width": 1080, "height": 1920, "duration": 12, "supportsStreaming": true},
 "caption": {"text": "…", "links": [{"offset": 4, "length": 4, "url": "https://…"}]}}
```

`media` is `{"type": "photo", "path"}` for an image. The sidecar uploads `file:<path>`, sends `caption.text` as a plain
string when `links` is empty and otherwise as `{text, entities: [messageEntityTextUrl…]}`, under the deadlines
TypeScript used (connect 30 s, `getMe` 30 s, `sendStory` 120 s, teardown 5 s, best effort).

- `200 {"id": <story id>}` — posted.
- `{"error": {"message": "<TypeScript's message, e.g. telegram_channel_story_connect_timeout>", "sent": false}}` (any
  status) — `sendStory` never went out (connect, identity, or Telegram's own RPC refusal): a plain failure.
- `{"error": {"message": …, "sent": true}}`, any other answer, or no answer within 200 s — the Story may be up:
  `Ambiguous("telegram_stories")`.

## Parity

```
bun scripts/rust/adapter-goldens.ts      # writes parity/adapter-goldens/<platform>/<case>.json (deterministic)
cargo test -p adapters                   # goldens.rs replays them; behaviour.rs covers what they cannot
```

228 cases: telegram 31, x 33, threads 43, instagram 26, discord 18, zernio 17, youtube 21, reels 16,
remote-media 10, stories 13 (text, photo, video, album, rich thread, reply chains and resume, edit, delete, verify,
absence, token refresh, 4xx, 429 with Retry-After, 5xx, transport loss, ambiguous mid-way failures). Compared:
every request in order — method, normalized URL, lower-cased sorted headers, body bytes (multipart as its wire parts,
bodies over 16 KiB by sha256), credentials as `{{NAME}}` — the result (objects compared without key order) or the
error kind, message, class, status and Retry-After, virtual sleep time for X, and files written.

## Deliberate deviations

- A sidecar answer that is not an explicit "not sent" is ambiguous, where TypeScript saw only mtcute's own errors:
  the new process boundary can lose an answer after `sendStory`, and a second Story is worse than an unclear one.
- The Stories connection is opened by the sidecar after the probe and re-encode, not before (one call per Story).
- A 2xx YouTube upload or Reels publish without an id is reported with `id: None` (TypeScript: `undefined`), never as
  a failure that would retry a publication that happened.
- Result objects match TypeScript's fields and values, not always their key order (a Threads/Instagram progress
  record whose `containerId` is added later lists it earlier); only the stored JSON's layout differs.
- A body that does not parse as JSON after a 2xx reports `JSON Parse error: <serde's reason>`, not JavaScriptCore's.

## Found, not changed (owner decision)

- Discord: a post split over several messages that fails on a later part (an HTTP refusal, e.g. 429) throws after the
  first message is already in the channel; the retry posts the first message again. X and Threads hand published ids
  back as a resume for exactly this; Discord does not.

Not here: the video worker loop and the publish workflow (`delivery`), `prepareMediaItems` / story derivatives (behind
`MediaPreparation`), the mtcute sidecar itself.
