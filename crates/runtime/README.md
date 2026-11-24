# runtime — process-level foundation (Rust)

Port of the TypeScript runtime foundation every worker and platform adapter builds on. Single-threaded like the
rest of the Studio: loops, doorbells and transports run on the process's `LocalSet`; futures are not `Send`.

| Module | TypeScript |
|---|---|
| `http` (`HttpClient`, `Response`, errors, `retry_after_seconds`, `form_body`) | `foundation/http.ts` (+ the tap hooks of `tap-measurement.ts` as `CallTiming`) |
| `http::Transport`, `ReqwestTransport`, `HttpRequest`, `HttpResponse` | the `fetchImpl` every adapter took |
| `ffmpeg` (`run_ffmpeg`, `run_ffmpeg_capture`, `probe_media_metadata`, `FfmpegMediaProbe`) | `foundation/runtime/ffmpeg.ts`, the `astats` call of `publishing/video-audio.ts` |
| `scheduler` (`start_loop`, `ScheduledLoop`, `LoopHooks`) | `foundation/scheduler.ts` |
| `worker_state` (`record_worker_state`, `HeartbeatLoops`, `worker_liveness`, worker names) | `foundation/runtime/worker-state.ts` |
| `worker_signal` (`ring_worker`, `ring_worker_after`, `set_worker_wake`, `WorkerSignals`) | `foundation/worker-signal.ts` |
| `timeout`, `job_heartbeat`, `git`, `data_dirs` | `foundation/runtime/timeout.ts`, `job-heartbeat.ts`, `git.ts`, `data-dirs.ts` |
| `external::{deepseek, instagram, threads, youtube, zernio, telegram_files}` | `foundation/external/*` |

Not here: `telegram-session.ts` (the Stories session, now `crates/mtproto`), `foundation/deployment.ts`
(promote/rollback live in `bot::deployment`; `readDeploymentReleases` is an ops read and goes with `ops`), the
privilege drop of `docker-entrypoint.ts` (goes with the entrypoint).

## Adapters and the transport seam

An adapter takes an `&HttpClient` and builds requests in the TypeScript call-site order:

```rust
let request = HttpRequest::post(url).header("Authorization", format!("Bearer {key}"))
    .header("Content-Type", "application/json").text(body).deadline(Duration::from_secs(40));
let json = client.request_json(request).await?;          // requestJson
let response = client.fetch_within(request, ceiling).await?; // externalFetch(…, timeoutMs)
let response = client.exchange(request).await?;          // a bare fetchImpl call
```

- `fetch` holds a 30 s ceiling up to the response headers; `deadline` is the caller's `AbortSignal.timeout` over the
  whole exchange. Bodies are `Body` parts (bytes, or a file from an offset), streamed with a known `Content-Length`.
- `ExternalError::Http` is an authoritative refusal (status, redacted body, `retry_after_seconds`);
  `ExternalError::Transport` is "sent, no answer" — the ambiguous case after a publishing call; `Message` is a plain
  refusal. A body that breaks off mid-read is `Transport` (TypeScript let the reader's own error through).
- Production: `HttpClient::new(Rc::new(ReqwestTransport::new()?))`; inside a bot update, `.timed_by(tap)` bills the
  wait to the tap. Tests: implement `Transport` to record each `HttpRequest` and answer `HttpResponse::buffered(…)` —
  `tests/parity.rs` (`Recorder`) is the pattern request goldens use (URL normalized, header names lower-cased and
  sorted, as Bun's `new Request` shows them).

`FfmpegMediaProbe` implements `domain::publishing::boundaries::MediaProbe` (ffprobe for the metadata, ffmpeg `astats`
for the audio check); `WorkerSignals` implements `WorkerBell`. `domain`'s `MediaMetadata` gained `audio_bitrate`, the
field `probeMediaMetadata` returned and the Story re-encode reads.

## Parity

```
cargo test -p runtime   # replays tests/fixtures/runtime.json (recorded from the TypeScript backend before the cutover; nothing re-records them); needs ffmpeg/ffprobe on PATH
```

Recorded: Retry-After parsing, `requestJson` results and redacted messages, `formBody`, ffmpeg failure trimming,
ffprobe JSON → metadata (a fake ffprobe on PATH), a real clip's probe, `worker_state` rows step by step, liveness,
scheduler cycle traces, and the requests DeepSeek, YouTube token, Zernio and Telegram file helpers sent.
`tests/runtime.rs` covers what a recording cannot: kills on timeout, timers, doorbells, accounting, heartbeats.

Deliberate deviations: `with_timeout` drops the work it gave up on (a raced promise ran on unobserved);
`youtube_access_token` refuses a response without `access_token` (TypeScript returned `undefined`); a lost response
body is a transport error (above); the ffmpeg limit is the constant 2 (`configureFfmpegConcurrency(2)` was its one
call).
