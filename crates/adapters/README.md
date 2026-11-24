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
| `telegram_stories` (`StoriesClient`, `StoryRequest`, `StoryError`) | `delivery/social/telegramStories.ts` minus the MTProto call (`crates/mtproto`) |
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
`mtproto::MtprotoStories::new(config)` is the `stories`.

## Telegram Stories over MTProto

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

## Parity

```
cargo test -p adapters   # goldens.rs replays parity/adapter-goldens/ (recorded from the TypeScript backend before the cutover; nothing re-records them); behaviour.rs covers what they cannot
```

228 cases: telegram 31, x 33, threads 43, instagram 26, discord 18, zernio 17, youtube 21, reels 16,
remote-media 10, stories 13 (text, photo, video, album, rich thread, reply chains and resume, edit, delete, verify,
absence, token refresh, 4xx, 429 with Retry-After, 5xx, transport loss, ambiguous mid-way failures). Compared:
every request in order — method, normalized URL, lower-cased sorted headers, body bytes (multipart as its wire parts,
bodies over 16 KiB by sha256), credentials as `{{NAME}}` — the result (objects compared without key order) or the
error kind, message, class, status and Retry-After, virtual sleep time for X, and files written.

## Deliberate deviations

- Stories: a failure before `stories.sendStory` is handed over (the upload's deadline included) is not sent, where
  TypeScript counted any non-RPC error inside mtcute's `sendStory` as possibly posted; a server-side RPC failure after
  it is ambiguous, where TypeScript counted every RPC error as not sent.
- The Stories connection is opened after the probe and re-encode, not before (one connection per Story).
- A 2xx YouTube upload or Reels publish without an id is reported with `id: None` (TypeScript: `undefined`), never as
  a failure that would retry a publication that happened.
- Result objects match TypeScript's fields and values, not always their key order (a Threads/Instagram progress
  record whose `containerId` is added later lists it earlier); only the stored JSON's layout differs.
- A body that does not parse as JSON after a 2xx reports `JSON Parse error: <serde's reason>`, not JavaScriptCore's.
- Discord: a split post whose later part is refused after the first is in the channel returns a partial publication
  (`resumeKey: "_discordMessageIds"`, the ids sent), as X and Threads do; TypeScript threw, and the retry posted the
  first message again. The retry sends only the remaining parts. A lost answer is ambiguous, as before.

Not here: the video worker loop and the publish workflow (`delivery`), `prepareMediaItems` / story derivatives (behind
`MediaPreparation`), the MTProto client itself (`crates/mtproto`).
