# runtime — process-level foundation (Rust)

The runtime foundation every worker and platform adapter builds on. Single-threaded like the
rest of the Studio: loops, doorbells and transports run on the process's `LocalSet`; futures are not `Send`.

| Module | What it is |
|---|---|
| `http` (`HttpClient`, `Response`, errors, `retry_after_seconds`, `form_body`) | external calls, with the tap hooks as `CallTiming` |
| `http::Transport`, `ReqwestTransport`, `HttpRequest`, `HttpResponse` | the transport every adapter takes |
| `ffmpeg` (`run_ffmpeg`, `run_ffmpeg_capture`, `probe_media_metadata`, `FfmpegMediaProbe`) | child-process ffmpeg/ffprobe, and the `astats` call of the video audio check |
| `scheduler` (`start_loop`, `ScheduledLoop`, `LoopHooks`) | background loops |
| `worker_state` (`record_worker_state`, `HeartbeatLoops`, `worker_liveness`, worker names) | per-loop state rows and liveness |
| `worker_signal` (`ring_worker`, `ring_worker_after`, `set_worker_wake`, `WorkerSignals`) | the doorbells of the two queues a person waits on |
| `timeout`, `job_heartbeat`, `git`, `data_dirs` | deadlines, job lease heartbeat, the running revision, data directories |
| `external::{deepseek, instagram, threads, youtube, zernio, telegram_files}` | provider helpers |

Not here: the Stories session (`crates/mtproto`), deployment (promote/rollback live in `bot::deployment`; reading
the releases is an ops read and goes with `ops`), the privilege drop (goes with the entrypoint).

## Adapters and the transport seam

An adapter takes an `&HttpClient` and builds requests in the call-site order the goldens recorded:

```rust
let request = HttpRequest::post(url).header("Authorization", format!("Bearer {key}"))
    .header("Content-Type", "application/json").text(body).deadline(Duration::from_secs(40));
let json = client.request_json(request).await?;          // JSON request
let response = client.fetch_within(request, ceiling).await?; // with a response-header ceiling
let response = client.exchange(request).await?;          // a bare transport call
```

- `fetch` holds a 30 s ceiling up to the response headers; `deadline` is the caller's timeout over the
  whole exchange. Bodies are `Body` parts (bytes, or a file from an offset), streamed with a known `Content-Length`.
- `ExternalError::Http` is an authoritative refusal (status, redacted body, `retry_after_seconds`);
  `ExternalError::Transport` is "sent, no answer" — the ambiguous case after a publishing call; `Message` is a plain
  refusal. A body that breaks off mid-read is `Transport`.
- Production: `HttpClient::new(Rc::new(ReqwestTransport::new()?))`; inside a bot update, `.timed_by(tap)` bills the
  wait to the tap. Tests: implement `Transport` to record each `HttpRequest` and answer `HttpResponse::buffered(…)` —
  `tests/parity.rs` (`Recorder`) is the pattern request goldens use (URL normalized, header names lower-cased and
  sorted, as Bun's `new Request` shows them).

`FfmpegMediaProbe` implements `domain::publishing::boundaries::MediaProbe` (ffprobe for the metadata, ffmpeg `astats`
for the audio check); `WorkerSignals` implements `WorkerBell`. `domain`'s `MediaMetadata` gained `audio_bitrate`, the
field the probe returns and the Story re-encode reads.

## Goldens

```
cargo test -p runtime   # replays tests/fixtures/runtime.json (recorded from the original backend before the cutover; nothing re-records them); needs ffmpeg/ffprobe on PATH
```

Recorded: Retry-After parsing, JSON request results and redacted messages, form bodies, ffmpeg failure trimming,
ffprobe JSON → metadata (a fake ffprobe on PATH), a real clip's probe, `worker_state` rows step by step, liveness,
scheduler cycle traces, and the requests DeepSeek, YouTube token, Zernio and Telegram file helpers sent.
`tests/runtime.rs` covers what a recording cannot: kills on timeout, timers, doorbells, accounting, heartbeats.

Deliberate deviations: `with_timeout` drops the work it gave up on (a raced promise ran on unobserved);
`youtube_access_token` refuses a response without `access_token` (the goldens' backend returned `undefined`); a lost
response body is a transport error (above); the ffmpeg limit is the constant 2.
